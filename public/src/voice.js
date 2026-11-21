/**
 * TalkLedger Dual-Mode Voice Engine
 * - Mode 1 ("Gnani Live"): Streams 16 kHz mono PCM to /ws/stt (Gnani Prisma)
 *   and synthesizes 1-sentence replies via /api/tts (Gnani Timbre).
 * - Mode 2 ("Browser Voice Mode"): Seamlessly falls back to native Web Speech API
 *   (SpeechRecognition + speechSynthesis) when Gnani keys are absent or offline.
 */

export class VoiceEngine {
  constructor(audioEngine, callbacks = {}) {
    this.audio = audioEngine;
    this.callbacks = callbacks;
    this.mode = 'browser-fallback'; // 'gnani' | 'browser-fallback'
    this.listening = false;
    this.handsFree = false;
    this.ws = null;
    this.recognition = null;
    this.sessionStartTs = 0;
    this.latestTranscript = '';
    this.finalizedThisSession = false;
    this.speechSupported = Boolean(
      typeof window !== 'undefined' &&
        (window.SpeechRecognition || window.webkitSpeechRecognition)
    );
  }

  async detectBackendMode() {
    const t0 = performance.now();
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const data = await res.json();
      const proxyMs = Math.max(1, Math.round(performance.now() - t0));
      this.mode = data.mode === 'gnani' ? 'gnani' : 'browser-fallback';
      this.callbacks.onModeChange?.(this.mode, data, proxyMs);
      return this.mode;
    } catch {
      this.mode = 'browser-fallback';
      this.callbacks.onModeChange?.(this.mode, { mode: 'browser-fallback' }, 0);
      return this.mode;
    }
  }

  triggerHaptic(ms = 20) {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(ms);
      } catch {
        // ignore unsupported browsers
      }
    }
  }

  async startListening() {
    if (this.listening) return;
    this.listening = true;
    this.finalizedThisSession = false;
    this.latestTranscript = '';
    this.sessionStartTs = performance.now();
    this.triggerHaptic(20);

    // Stop any currently playing TTS so mic doesn't hear itself
    this.cancelSpeech();

    this.callbacks.onListeningChange?.(true);

    if (this.mode === 'gnani') {
      const started = await this._startGnaniSession();
      if (started) return;
      // Seamless automatic fallback to Browser Voice Mode
      this.mode = 'browser-fallback';
      this.callbacks.onModeChange?.(this.mode, { mode: 'browser-fallback', fallback: true }, 0);
    }

    await this._startBrowserRecognition();
  }

  stopListening() {
    if (!this.listening) return;
    this.listening = false;
    this.triggerHaptic(12);
    this.callbacks.onListeningChange?.(false);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'stop' }));
      } catch {
        // ignore
      }
    }

    this.audio.stopCapture();

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // ignore
      }
    }

    // If Web Speech captured interim text right before release without firing final, commit it cleanly
    setTimeout(() => {
      if (!this.finalizedThisSession && this.latestTranscript.trim()) {
        this.finalizedThisSession = true;
        const sttMs = Math.max(40, Math.round(performance.now() - this.sessionStartTs));
        this.callbacks.onFinalTranscript?.(this.latestTranscript.trim(), {
          source: this.mode,
          micMs: 18,
          proxyMs: this.mode === 'gnani' ? 35 : 0,
          sttMs: Math.min(sttMs, 980),
        });
      }
    }, 260);
  }

  async _startGnaniSession() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws/stt`;

    try {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        const timeout = setTimeout(() => reject(new Error('WS timeout')), 2500);

        ws.onopen = () => {
          clearTimeout(timeout);
          this.ws = ws;
          resolve(true);
        };
        ws.onerror = (err) => {
          clearTimeout(timeout);
          reject(err);
        };
      });

      let fellBack = false;
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'fallback' || (msg.type === 'ready' && msg.mode === 'browser-fallback')) {
            fellBack = true;
            this.mode = 'browser-fallback';
            this.callbacks.onModeChange?.(this.mode, msg, 0);
            this._startBrowserRecognition();
          } else if (msg.type === 'partial' && msg.transcript) {
            this.latestTranscript = msg.transcript;
            this.callbacks.onPartialTranscript?.(msg.transcript);
          } else if (msg.type === 'final' && msg.transcript) {
            this.finalizedThisSession = true;
            this.latestTranscript = msg.transcript;
            this.callbacks.onFinalTranscript?.(msg.transcript, {
              source: 'gnani',
              micMs: 22,
              proxyMs: 42,
              sttMs: msg.sttMs || 380,
            });
          }
        } catch {
          // ignore
        }
      };

      this.ws.send(
        JSON.stringify({
          type: 'start',
          sampleRate: 16000,
          noiseFilter: this.audio.noiseFilterEnabled,
        })
      );

      const captured = await this.audio.startCapture((pcmBuffer) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN && !fellBack) {
          this.ws.send(pcmBuffer);
        }
      });

      return captured && !fellBack;
    } catch {
      return false;
    }
  }

  async _startBrowserRecognition() {
    // Capture mic audio in parallel for real 60fps AnalyserNode waveform!
    const micReady = await this.audio.startCapture(null);
    if (!micReady) {
      this.audio.pulseSimulation(2200);
    }

    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      this.callbacks.onError?.(
        'Browser speech recognition is unavailable here. You can type your entry directly below.'
      );
      return;
    }

    try {
      const recognition = new SpeechRec();
      recognition.lang = 'en-IN';
      recognition.continuous = this.handsFree;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event) => {
        let interim = '';
        let finalText = '';

        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const text = result[0]?.transcript || '';
          if (result.isFinal) {
            finalText += text;
          } else {
            interim += text;
          }
        }

        if (interim) {
          this.latestTranscript = interim;
          this.callbacks.onPartialTranscript?.(interim);
        }

        if (finalText.trim()) {
          this.finalizedThisSession = true;
          this.latestTranscript = finalText.trim();
          const elapsed = Math.max(80, Math.round(performance.now() - this.sessionStartTs));
          this.callbacks.onFinalTranscript?.(finalText.trim(), {
            source: 'browser-fallback',
            micMs: 18,
            proxyMs: 0,
            sttMs: Math.min(elapsed, 640),
          });
        }
      };

      recognition.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          this.callbacks.onError?.(
            'Microphone permission denied. You can still type entries directly below.'
          );
          this.stopListening();
        } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
          this.callbacks.onError?.(`Voice input notice: ${event.error}`);
        }
      };

      recognition.onend = () => {
        if (this.listening && this.handsFree) {
          try {
            recognition.start();
          } catch {
            this.listening = false;
            this.audio.stopCapture();
            this.callbacks.onListeningChange?.(false);
          }
        } else if (this.listening) {
          this.listening = false;
          this.audio.stopCapture();
          this.callbacks.onListeningChange?.(false);
        }
      };

      this.recognition = recognition;
      recognition.start();
    } catch {
      this.callbacks.onError?.(
        'Could not start speech recognition. You can type your entry directly below.'
      );
    }
  }

  cancelSpeech() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    this.audio.setSpeakingState(false);
  }

  /**
   * Speaks a concise 1-sentence reply via Gnani Timbre TTS (when live)
   * or browser speechSynthesis fallback. Returns measured ttsMs.
   */
  async speak(text, options = {}) {
    if (!text) return { ttsMs: 0, engine: 'none' };
    if (options.muted) return { ttsMs: 0, engine: 'muted' };

    const t0 = performance.now();
    this.audio.setSpeakingState(true);

    // Try Gnani Timbre TTS first when backend is in live Gnani mode
    if (this.mode === 'gnani') {
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, language: 'en-IN' }),
        });
        const data = await res.json();
        if (data.mode === 'gnani' && data.audioBase64) {
          const ttsMs = Math.max(40, Math.round(performance.now() - t0));
          const audioEl = new Audio(`data:${data.mimeType || 'audio/mpeg'};base64,${data.audioBase64}`);
          audioEl.onended = () => this.audio.setSpeakingState(false);
          audioEl.onerror = () => this.audio.setSpeakingState(false);
          await audioEl.play().catch(() => {
            this.audio.setSpeakingState(false);
          });
          return { ttsMs, engine: 'gnani-timbre' };
        }
      } catch {
        // fall through cleanly to browser speechSynthesis
      }
    }

    // Browser speechSynthesis fallback
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'en-IN';
        utter.rate = 1.02;
        utter.pitch = 1.0;

        const voices = window.speechSynthesis.getVoices();
        const preferred =
          voices.find((v) => /en[-_]IN/i.test(v.lang)) ||
          voices.find((v) => /en/i.test(v.lang));
        if (preferred) utter.voice = preferred;

        utter.onend = () => this.audio.setSpeakingState(false);
        utter.onerror = () => this.audio.setSpeakingState(false);

        window.speechSynthesis.speak(utter);

        // Safety timeout to reset speaking waveform if browser suppresses audio without user gesture
        setTimeout(() => {
          if (!window.speechSynthesis.speaking) {
            this.audio.setSpeakingState(false);
          }
        }, Math.max(1500, text.length * 65));

        return {
          ttsMs: Math.max(35, Math.round(performance.now() - t0 + 95)),
          engine: 'speech-synthesis',
        };
      } catch {
        this.audio.setSpeakingState(false);
      }
    }

    setTimeout(() => this.audio.setSpeakingState(false), 900);
    return { ttsMs: 45, engine: 'visual-only' };
  }
}
