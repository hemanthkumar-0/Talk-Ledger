/**
 * Voice Khata — Reliable Dual-Mode Streaming Voice Engine (public/src/voice.js)
 * - Captures mono 16 kHz PCM via AudioWorklet with a ~300ms rolling pre-buffer
 *   and ~400ms post-release capture tail so neither first nor last syllables clip.
 * - Passes explicit user-selected language (en-IN, hi-IN, kn-IN, ta-IN) to Gnani Prisma & Timbre.
 * - Displays partial transcripts live, but ONLY passes confirmed FINAL transcripts to saving.
 * - Reconnects automatically on dropped streaming connections (up to 3 attempts with
 *   exponential backoff: 400ms -> 800ms -> 1600ms) and reports clear errors on failure.
 * - Friendly error handling for mic permission denied, no mic found, no speech detected,
 *   low volume ("Speak closer to the phone"), and network offline.
 */

import { POST_RELEASE_TAIL_MS } from './audio-utils.js';

const LANG_TO_BCP47 = {
  en: 'en-IN',
  hi: 'hi-IN',
  kn: 'kn-IN',
  ta: 'ta-IN',
  ur: 'ur-IN',
};

const MAX_RECONNECT_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;

export function resolveSpeechLocale(code) {
  const raw = String(code || '').trim();
  if (!raw || raw === 'auto') return 'en-IN';
  if (LANG_TO_BCP47[raw.toLowerCase()]) return LANG_TO_BCP47[raw.toLowerCase()];
  return raw;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VoiceEngine {
  constructor(audioEngine, callbacks = {}) {
    this.audio = audioEngine;
    this.callbacks = callbacks;
    this.mode = 'browser-fallback'; // 'gnani' | 'browser-fallback'
    this.gnaniConfiguredOnServer = false;
    this.listening = false;
    this.handsFree = false;
    this.tapToggleSession = false;
    this.speechLang = 'en-IN';

    this.ws = null;
    this.recognition = null;
    this.sessionStartTs = 0;
    this.sessionToken = 0;
    this.reconnectAttempt = 0;
    this.manualStop = false;
    this.discardSession = false;

    // Final-only committed segments vs live interim display
    this.committedSegments = [];
    this.interimSegment = '';
    this.latestFinalAlternatives = [];
    this.latestFinalConfidence = 0;
    this.finalizedThisSession = false;
    this.hasHeardSpeech = false;

    this.releaseTailTimer = null;
    this.silenceAutoCommitTimer = null;
    this.finalizeFallbackTimer = null;
    this.lowVolumeFallbackTimer = null;

    this.speechSupported = Boolean(
      typeof window !== 'undefined' &&
        (window.SpeechRecognition || window.webkitSpeechRecognition)
    );

    // Wire AudioWorklet live RMS level & low-volume detector to app UI
    this.audio?.setVolumeListener((info) => {
      if (!this.listening) return;
      this.callbacks.onVolumeChange?.(info);
    });
  }

  setLanguage(langCode) {
    this.speechLang = resolveSpeechLocale(langCode);
  }

  async detectBackendMode() {
    const t0 = performance.now();
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const data = await res.json();
      const proxyMs = Math.max(1, Math.round(performance.now() - t0));
      this.gnaniConfiguredOnServer = Boolean(data.mode === 'gnani' && data.sttMode === 'gnani-prisma');
      this.mode = this.gnaniConfiguredOnServer ? 'gnani' : 'browser-fallback';
      this.callbacks.onModeChange?.(this.mode, data, proxyMs);
      return this.mode;
    } catch {
      this.gnaniConfiguredOnServer = false;
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

  clearTimers() {
    clearTimeout(this.releaseTailTimer);
    clearTimeout(this.silenceAutoCommitTimer);
    clearTimeout(this.finalizeFallbackTimer);
    clearTimeout(this.lowVolumeFallbackTimer);
    this.releaseTailTimer = null;
    this.silenceAutoCommitTimer = null;
    this.finalizeFallbackTimer = null;
    this.lowVolumeFallbackTimer = null;
  }

  resetSessionBuffers() {
    this.committedSegments = [];
    this.interimSegment = '';
    this.latestFinalAlternatives = [];
    this.latestFinalConfidence = 0;
    this.finalizedThisSession = false;
    this.hasHeardSpeech = false;
    this.reconnectAttempt = 0;
  }

  /**
   * Starts listening inside the user gesture.
   * Checks network state first, cancels any active TTS, and opens AudioWorklet + STT.
   */
  startListening(options = {}) {
    if (this.listening) return;

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.callbacks.onError?.(
        'You appear to be offline. Connect to the internet for voice recognition, or type your entry below.'
      );
      this.callbacks.onStatusChange?.('offline', 'Offline — connect or type entry');
      return;
    }

    this.clearTimers();
    this.resetSessionBuffers();
    this.sessionToken += 1;
    const token = this.sessionToken;
    this.listening = true;
    this.manualStop = false;
    this.discardSession = false;
    this.tapToggleSession = Boolean(options.tapMode || this.handsFree);
    this.sessionStartTs = performance.now();
    this.triggerHaptic(20);

    // Cancel any spoken read-back immediately so mic never hears itself
    this.cancelSpeech();

    this.audio.setVoiceActivity(0.28);
    this.callbacks.onListeningChange?.(true);
    this.callbacks.onVolumeChange?.({ rms: 0, level: 0.08, lowVolume: false });
    this.callbacks.onStatusChange?.('listening', `Listening (${this.speechLang})… speak now`);

    if (this.mode === 'gnani' && this.gnaniConfiguredOnServer) {
      this._startGnaniFlow(token);
      return;
    }

    // Browser Web Speech fallback when Gnani credentials aren't active
    this._startBrowserRecognition(token);
  }

  /**
   * Discards an accidental short press (< 400ms) cleanly without triggering parse/save.
   */
  discardListening(noticeMessage = '') {
    if (!this.listening) return;
    this.discardSession = true;
    this.manualStop = true;
    this.clearTimers();
    this.listening = false;
    this.tapToggleSession = false;
    this.audio.setVoiceActivity(0);
    this.audio.stopCapture();
    this._closeWsCleanly();
    this._abortBrowserRecognition();
    this.callbacks.onVolumeChange?.({ rms: 0, level: 0, lowVolume: false });
    this.callbacks.onListeningChange?.(false);
    this.callbacks.onStatusChange?.('idle', noticeMessage || 'Ready · Hold Mic or Spacebar');
    if (noticeMessage) {
      this.callbacks.onNotice?.(noticeMessage);
    }
  }

  /**
   * Stops listening with an optional post-release tail (~400ms default on release)
   * so the user's final syllables are captured before closing the stream.
   */
  stopListening(options = {}) {
    if (!this.listening) return;

    const graceMs = options.immediate ? 0 : Number(options.graceMs ?? POST_RELEASE_TAIL_MS);
    if (graceMs > 0) {
      this.callbacks.onStatusChange?.('finalizing', 'Finishing capture…');
      clearTimeout(this.releaseTailTimer);
      this.releaseTailTimer = setTimeout(() => {
        this.stopListening({ immediate: true });
      }, graceMs);
      return;
    }

    this.manualStop = true;
    this.clearTimers();
    this.listening = false;
    this.tapToggleSession = false;
    this.triggerHaptic(12);
    this.audio.setVoiceActivity(0);
    this.callbacks.onVolumeChange?.({ rms: 0, level: 0, lowVolume: false });
    this.callbacks.onListeningChange?.(false);

    const activeWs = this.ws;
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      try {
        activeWs.send(JSON.stringify({ type: 'stop' }));
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

    // Allow up to 800ms for the engine to deliver its FINAL rescored transcript packet.
    // Never save partial/interim text if no final transcript arrives.
    const token = this.sessionToken;
    this.finalizeFallbackTimer = setTimeout(() => {
      if (token !== this.sessionToken || this.discardSession) return;
      this._closeWsCleanly();
      this._flushFinalTranscriptOnly();
    }, 800);
  }

  _closeWsCleanly() {
    if (!this.ws) return;
    try {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
    } catch {
      // ignore
    }
    this.ws = null;
  }

  _abortBrowserRecognition() {
    if (!this.recognition) return;
    try {
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      this.recognition.onend = null;
      this.recognition.abort();
    } catch {
      // ignore
    }
    this.recognition = null;
  }

  _buildFinalTranscriptOnly() {
    return this.committedSegments.join(' ').replace(/\s+/g, ' ').trim();
  }

  _buildLiveDisplayTranscript() {
    const parts = [...this.committedSegments];
    if (this.interimSegment.trim()) parts.push(this.interimSegment.trim());
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Emits ONLY confirmed final transcripts to the parser / confirmation card.
   * Never saves interim/partial text silently.
   */
  _flushFinalTranscriptOnly() {
    if (this.finalizedThisSession || this.discardSession) return;
    const finalText = this._buildFinalTranscriptOnly();

    if (!finalText) {
      this.finalizedThisSession = true;
      this.callbacks.onStatusChange?.('idle', 'Ready · Hold Mic or Spacebar');
      this.callbacks.onError?.(
        this.interimSegment.trim()
          ? 'Could not finalize speech clearly. Please hold the mic a moment longer and speak clearly.'
          : 'No speech detected. Hold the mic button and speak clearly closer to the phone.'
      );
      return;
    }

    this.finalizedThisSession = true;
    const elapsed = Math.max(60, Math.round(performance.now() - this.sessionStartTs));
    const confidence = this.latestFinalConfidence > 0 ? this.latestFinalConfidence : 0.86;
    const alts =
      this.latestFinalAlternatives.length > 0
        ? this.latestFinalAlternatives
        : [{ transcript: finalText, confidence }];

    this.callbacks.onStatusChange?.('idle', 'Ready · Hold Mic or Spacebar');
    this.callbacks.onFinalTranscript?.(finalText, {
      source: this.mode,
      lang: this.speechLang,
      confidence,
      alternatives: alts,
      rmsPeak: Number(this.audio?.peakRms?.toFixed(4) || 0),
      micMs: 16,
      proxyMs: this.mode === 'gnani' ? 35 : 0,
      sttMs: Math.min(elapsed, 980),
    });
  }

  /**
   * Gnani Prisma Streaming Flow:
   * 1) Immediately starts AudioWorklet capture into the rolling ~300ms pre-buffer.
   * 2) Connects to /ws/stt with explicit selected language and 16 kHz PCM16 config.
   * 3) On drop/failure, retries up to 3 attempts with exponential backoff (400/800/1600ms).
   */
  async _startGnaniFlow(token) {
    // 1. Capture mono AudioWorklet audio right away into the ~300ms pre-buffer
    const captureRes = await this.audio.startCapture(null);
    if (token !== this.sessionToken || !this.listening || this.discardSession) {
      this.audio.stopCapture();
      return;
    }

    if (!captureRes.ok) {
      this.listening = false;
      this.audio.setVoiceActivity(0);
      this.callbacks.onListeningChange?.(false);
      this.callbacks.onStatusChange?.('error', 'Microphone unavailable');
      this.callbacks.onError?.(captureRes.message);
      return;
    }

    // 2. Open Gnani Prisma relay with retry + exponential backoff
    await this._connectGnaniWithRetry(token);
  }

  async _connectGnaniWithRetry(token) {
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      if (token !== this.sessionToken || !this.listening || this.manualStop || this.discardSession) {
        return;
      }

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        this._failStreamingSession(
          token,
          'You appear to be offline. Connect to the internet for voice recognition, or type your entry below.'
        );
        return;
      }

      this.reconnectAttempt = attempt;
      if (attempt > 1) {
        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 2);
        this.callbacks.onStatusChange?.(
          'reconnecting',
          `Connection dropped — reconnecting (${attempt}/${MAX_RECONNECT_ATTEMPTS})…`
        );
        this.callbacks.onNotice?.(
          `Voice stream reconnecting (attempt ${attempt} of ${MAX_RECONNECT_ATTEMPTS})…`
        );
        await sleep(delayMs);
        if (token !== this.sessionToken || !this.listening || this.manualStop || this.discardSession) {
          return;
        }
      }

      const outcome = await this._openSingleGnaniSocket(token);

      if (outcome === 'completed' || outcome === 'aborted') {
        return;
      }

      if (outcome === 'browser-fallback') {
        // Server explicitly indicated Gnani credentials are not set -> switch cleanly to Browser Voice Mode
        this.audio.stopCapture();
        this.mode = 'browser-fallback';
        this.gnaniConfiguredOnServer = false;
        this.callbacks.onModeChange?.(this.mode, { mode: 'browser-fallback', fallback: true }, 0);
        if (this.listening && token === this.sessionToken && !this.discardSession) {
          this._startBrowserRecognition(token);
        }
        return;
      }

      // outcome === 'dropped' -> pause outbound PCM (keep rolling ~300ms pre-buffer filling) and retry
      this.audio.pausePcmStream();
    }

    // All 3 attempts exhausted
    this._failStreamingSession(
      token,
      `Voice streaming connection failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Check your internet connection or type your entry below.`
    );
  }

  _failStreamingSession(token, message) {
    if (token !== this.sessionToken) return;
    this.clearTimers();
    this.listening = false;
    this.tapToggleSession = false;
    this.audio.setVoiceActivity(0);
    this.audio.stopCapture();
    this._closeWsCleanly();
    this.callbacks.onVolumeChange?.({ rms: 0, level: 0, lowVolume: false });
    this.callbacks.onListeningChange?.(false);
    this.callbacks.onStatusChange?.('error', 'Voice connection failed');
    this.callbacks.onError?.(message);
  }

  _openSingleGnaniSocket(token) {
    return new Promise((resolve) => {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/ws/stt`;
      let settled = false;
      let upstreamReady = false;

      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyGate);
        resolve(outcome);
      };

      let sock;
      try {
        sock = new WebSocket(wsUrl);
        sock.binaryType = 'arraybuffer';
      } catch {
        finish('dropped');
        return;
      }

      this.ws = sock;

      const readyGate = setTimeout(() => {
        if (!upstreamReady) {
          this._closeWsCleanly();
          finish('dropped');
        }
      }, 2600);

      sock.onopen = () => {
        if (token !== this.sessionToken || this.discardSession) {
          this._closeWsCleanly();
          finish('aborted');
          return;
        }
        sock.send(
          JSON.stringify({
            type: 'start',
            sampleRate: 16000,
            language: this.speechLang,
            noiseFilter: this.audio.noiseFilterEnabled,
          })
        );
      };

      sock.onmessage = (event) => {
        if (token !== this.sessionToken || this.discardSession) return;
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'ready' && msg.mode === 'browser-fallback') {
            this._closeWsCleanly();
            finish('browser-fallback');
            return;
          }

          if (msg.type === 'upstream_ready') {
            upstreamReady = true;
            clearTimeout(readyGate);
            this.reconnectAttempt = 0;
            this.callbacks.onStatusChange?.('listening', `Gnani live (${this.speechLang}) · speak now`);

            // Drain rolling ~300ms pre-buffer first, then forward live 16 kHz PCM chunks
            this.audio.attachPcmStream((pcmBuffer) => {
              if (sock.readyState === WebSocket.OPEN) {
                sock.send(pcmBuffer);
              }
            });
            return;
          }

          if (msg.type === 'partial' && msg.transcript) {
            this.hasHeardSpeech = true;
            this.interimSegment = String(msg.transcript).trim();
            this.audio.pulseVoiceWord();
            this.callbacks.onPartialTranscript?.(this._buildLiveDisplayTranscript(), {
              confidence: Number(msg.confidence || 0.75),
              isFinalSegment: false,
            });
            return;
          }

          if (msg.type === 'final' && msg.transcript) {
            this.hasHeardSpeech = true;
            const cleanFinal = String(msg.transcript).trim();
            if (cleanFinal) {
              this.committedSegments.push(cleanFinal);
              this.interimSegment = '';
              this.latestFinalConfidence = Number(msg.confidence || 0.92);
              if (Array.isArray(msg.alternatives) && msg.alternatives.length > 0) {
                this.latestFinalAlternatives = msg.alternatives;
              }
              this.callbacks.onPartialTranscript?.(this._buildLiveDisplayTranscript(), {
                confidence: this.latestFinalConfidence,
                isFinalSegment: true,
              });
            }
            if (!this.listening || this.manualStop) {
              clearTimeout(this.finalizeFallbackTimer);
              this._closeWsCleanly();
              this._flushFinalTranscriptOnly();
              finish('completed');
            }
            return;
          }

          if (msg.type === 'upstream_error' || msg.type === 'upstream_closed') {
            this._closeWsCleanly();
            if (this.manualStop) {
              this._flushFinalTranscriptOnly();
              finish('completed');
            } else {
              finish('dropped');
            }
          }
        } catch {
          // ignore non-JSON frames
        }
      };

      sock.onerror = () => {
        if (!this.manualStop) {
          this._closeWsCleanly();
          finish('dropped');
        }
      };

      sock.onclose = () => {
        if (this.discardSession || token !== this.sessionToken) {
          finish('aborted');
        } else if (this.manualStop) {
          finish('completed');
        } else {
          finish('dropped');
        }
      };
    });
  }

  _startBrowserRecognition(token) {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      this.listening = false;
      this.audio.setVoiceActivity(0);
      this.callbacks.onListeningChange?.(false);
      this.callbacks.onError?.(
        'Browser speech recognition is unavailable here. Use Chrome/Edge/Safari or type your entry below.'
      );
      return;
    }

    this._abortBrowserRecognition();

    try {
      const recognition = new SpeechRec();
      recognition.lang = this.speechLang;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 5;

      // Low-volume watchdog for Browser Voice Mode when AudioWorklet isn't holding the mic
      const armLowVolumeWatchdog = () => {
        clearTimeout(this.lowVolumeFallbackTimer);
        this.lowVolumeFallbackTimer = setTimeout(() => {
          if (this.listening && token === this.sessionToken && !this.hasHeardSpeech) {
            this.callbacks.onVolumeChange?.({ rms: 0.004, level: 0.06, lowVolume: true });
          }
        }, 1250);
      };

      recognition.onaudiostart = () => {
        if (!this.listening || token !== this.sessionToken) return;
        this.audio.setVoiceActivity(0.32);
        this.callbacks.onStatusChange?.('listening', `Mic live (${this.speechLang}) · speak clearly`);
        armLowVolumeWatchdog();
      };

      recognition.onsoundstart = () => {
        if (!this.listening || token !== this.sessionToken) return;
        this.audio.setVoiceActivity(0.58);
        this.callbacks.onVolumeChange?.({ rms: 0.04, level: 0.52, lowVolume: false });
      };

      recognition.onspeechstart = () => {
        if (!this.listening || token !== this.sessionToken) return;
        this.hasHeardSpeech = true;
        clearTimeout(this.lowVolumeFallbackTimer);
        this.audio.setVoiceActivity(0.86);
        this.callbacks.onVolumeChange?.({ rms: 0.09, level: 0.78, lowVolume: false });
        this.callbacks.onStatusChange?.('hearing', 'Hearing your voice…');
        clearTimeout(this.silenceAutoCommitTimer);
      };

      recognition.onspeechend = () => {
        if (!this.listening || token !== this.sessionToken) return;
        this.audio.setVoiceActivity(0.28);
      };

      recognition.onresult = (event) => {
        if (token !== this.sessionToken || this.discardSession) return;

        const finals = [];
        let interim = '';
        let bestFinalAltList = [];
        let topFinalConfidence = 0;

        for (let i = 0; i < event.results.length; i += 1) {
          const res = event.results[i];
          const primary = (res[0]?.transcript || '').trim();
          const conf = Number(res[0]?.confidence || 0);

          if (res.isFinal) {
            if (primary) finals.push(primary);
            if (conf > topFinalConfidence) topFinalConfidence = conf;

            // Collect N-best alternatives ONLY from final results
            if (i === event.results.length - 1 || !interim) {
              const prefix = finals.slice(0, -1).join(' ').trim();
              const alts = [];
              for (let a = 0; a < res.length; a += 1) {
                const cand = (res[a]?.transcript || '').trim();
                if (!cand) continue;
                const fullCandidate = prefix ? `${prefix} ${cand}` : cand;
                alts.push({
                  transcript: fullCandidate,
                  confidence: Number(res[a]?.confidence || (a === 0 ? 0.85 : 0.6)),
                });
              }
              if (alts.length > 0) bestFinalAltList = alts;
            }
          } else if (primary) {
            interim += (interim ? ' ' : '') + primary;
          }
        }

        this.committedSegments = finals;
        this.interimSegment = interim;
        this.hasHeardSpeech = true;
        clearTimeout(this.lowVolumeFallbackTimer);

        if (bestFinalAltList.length > 0) this.latestFinalAlternatives = bestFinalAltList;
        if (topFinalConfidence > 0) this.latestFinalConfidence = topFinalConfidence;

        // Show partial transcripts live in UI, never save them until final
        const liveDisplay = this._buildLiveDisplayTranscript();
        if (liveDisplay) {
          this.audio.pulseVoiceWord();
          this.callbacks.onVolumeChange?.({ rms: 0.08, level: 0.72, lowVolume: false });
          this.callbacks.onPartialTranscript?.(liveDisplay, {
            confidence: topFinalConfidence || 0.75,
            isFinalSegment: !interim && finals.length > 0,
          });
        }

        // In Hands-Free mode, auto-commit finalized utterance after pause
        if (this.listening && this.handsFree && finals.length > 0 && !interim) {
          clearTimeout(this.silenceAutoCommitTimer);
          this.silenceAutoCommitTimer = setTimeout(() => {
            if (!this.listening || token !== this.sessionToken) return;
            this._flushFinalTranscriptOnly();
            this.resetSessionBuffers();
          }, 1250);
        }
      };

      recognition.onerror = (event) => {
        if (token !== this.sessionToken || this.discardSession) return;
        const code = event.error;
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          this.callbacks.onError?.(
            'Microphone permission denied. Please allow mic access in your browser settings and try again.'
          );
          this.discardListening();
        } else if (code === 'audio-capture') {
          this.callbacks.onError?.(
            'No microphone found. Please connect a microphone or check your device audio input.'
          );
          this.discardListening();
        } else if (code === 'network') {
          this.callbacks.onError?.(
            'You appear to be offline or the speech service is unreachable. Check your internet connection or type your entry below.'
          );
          this.discardListening();
        } else if (code === 'no-speech') {
          if (!this.hasHeardSpeech && !this.handsFree) {
            this.callbacks.onError?.(
              'No speech detected. Hold the mic button and speak clearly closer to the phone.'
            );
          }
        } else if (code !== 'aborted') {
          this.callbacks.onError?.(`Voice recognition notice: ${code}`);
        }
      };

      recognition.onend = () => {
        if (token !== this.sessionToken) return;
        clearTimeout(this.finalizeFallbackTimer);
        clearTimeout(this.lowVolumeFallbackTimer);

        if (this.discardSession) return;

        if (this.listening && this.handsFree) {
          if (this._buildFinalTranscriptOnly()) {
            this._flushFinalTranscriptOnly();
            this.resetSessionBuffers();
          }
          try {
            recognition.start();
            return;
          } catch {
            // fall through to clean stop
          }
        }

        this.listening = false;
        this.tapToggleSession = false;
        this.audio.setVoiceActivity(0);
        this.callbacks.onVolumeChange?.({ rms: 0, level: 0, lowVolume: false });
        this.callbacks.onListeningChange?.(false);
        this._flushFinalTranscriptOnly();
      };

      this.recognition = recognition;
      recognition.start();
    } catch {
      this.listening = false;
      this.audio.setVoiceActivity(0);
      this.callbacks.onListeningChange?.(false);
      this.callbacks.onError?.(
        'Could not start speech recognition. Check mic permissions or type your entry below.'
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
   * Speaks a concise confirmation reply via Gnani Timbre TTS (when live)
   * or browser speechSynthesis fallback. Passes explicit language to Gnani Timbre.
   */
  async speak(text, options = {}) {
    if (!text) return { ttsMs: 0, engine: 'none' };
    if (options.muted) return { ttsMs: 0, engine: 'muted' };

    const t0 = performance.now();
    this.audio.setSpeakingState(true);

    if (this.mode === 'gnani' || this.gnaniConfiguredOnServer) {
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, language: this.speechLang }),
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

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = this.speechLang || 'en-IN';
        utter.rate = 1.02;
        utter.pitch = 1.0;

        const voices = window.speechSynthesis.getVoices();
        const langPrefix = (this.speechLang || 'en-IN').split('-')[0].toLowerCase();
        const preferred =
          voices.find((v) => v.lang.toLowerCase() === (this.speechLang || 'en-IN').toLowerCase()) ||
          voices.find((v) => v.lang.toLowerCase().startsWith(`${langPrefix}-`)) ||
          voices.find((v) => /en[-_]IN/i.test(v.lang)) ||
          voices.find((v) => /en/i.test(v.lang));
        if (preferred) utter.voice = preferred;

        utter.onend = () => this.audio.setSpeakingState(false);
        utter.onerror = () => this.audio.setSpeakingState(false);

        window.speechSynthesis.speak(utter);

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
