/**
 * Voice Khata — AudioWorklet Capture, Rolling 300ms Pre-Buffer & 60fps Waveform Engine
 * - Captures mono audio via getUserMedia with echoCancellation, noiseSuppression & autoGainControl
 * - Uses AudioWorklet (never ScriptProcessorNode) to resample to 16 kHz, 16-bit PCM
 * - Keeps a rolling ~300ms pre-buffer so the very first word is never clipped
 * - Drives live waveform + RMS volume meter and warns when input volume is too low
 */

import {
  LOW_VOLUME_GRACE_MS,
  LOW_VOLUME_RMS_THRESHOLD,
  PcmPreBuffer,
  PRE_BUFFER_MS,
  TARGET_SAMPLE_RATE,
} from './audio-utils.js';

function classifyGetUserMediaError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return {
      ok: false,
      errorCode: 'permission-denied',
      message: 'Microphone permission denied. Please allow mic access in your browser settings and try again.',
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return {
      ok: false,
      errorCode: 'no-mic',
      message: 'No microphone found. Please connect a microphone or check your device audio input.',
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return {
      ok: false,
      errorCode: 'mic-busy',
      message: 'Microphone is busy in another app. Close other audio apps and try again.',
    };
  }
  return {
    ok: false,
    errorCode: 'mic-error',
    message: err?.message || 'Could not access microphone. Check your browser audio permissions.',
  };
}

export class AudioEngine {
  constructor() {
    this.audioCtx = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.analyser = null;
    this.workletNode = null;
    this.silentGain = null;
    this.highpass = null;
    this.lowpass = null;
    this.compressor = null;
    this.gainNode = null;

    this.noiseFilterEnabled = true;
    this.isCapturing = false;
    this.isStreamingPcm = false;
    this.isSpeaking = false;
    this.simActive = false;

    this.voiceActivity = 0;
    this.targetVoiceActivity = 0;
    this.currentRms = 0;
    this.peakRms = 0;
    this.captureStartedAt = 0;
    this.lastAudibleAt = 0;
    this.lowVolumeWarned = false;

    this.preBuffer = new PcmPreBuffer(PRE_BUFFER_MS, TARGET_SAMPLE_RATE);
    this.onPcmChunk = null;
    this.onVolumeCallback = null;

    this.canvases = new Set();
    this.rafId = null;
    this.phase = 0;
    this.freqData = new Uint8Array(64);
    this.reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  registerCanvas(canvas) {
    if (!canvas) return;
    this.canvases.add(canvas);
    this.startRenderLoop();
  }

  setVolumeListener(cb) {
    this.onVolumeCallback = typeof cb === 'function' ? cb : null;
  }

  setNoiseFilter(enabled) {
    this.noiseFilterEnabled = Boolean(enabled);
    if (this.highpass && this.lowpass && this.gainNode && this.audioCtx) {
      const now = this.audioCtx.currentTime;
      this.highpass.frequency.setTargetAtTime(this.noiseFilterEnabled ? 110 : 20, now, 0.04);
      this.lowpass.frequency.setTargetAtTime(this.noiseFilterEnabled ? 4000 : 12000, now, 0.04);
      this.gainNode.gain.setTargetAtTime(this.noiseFilterEnabled ? 1.35 : 1.0, now, 0.04);
    }
  }

  setSpeakingState(active) {
    this.isSpeaking = Boolean(active);
  }

  setVoiceActivity(level) {
    this.targetVoiceActivity = Math.max(0, Math.min(1, Number(level) || 0));
    if (this.targetVoiceActivity > 0) {
      this.startRenderLoop();
    }
  }

  pulseVoiceWord() {
    this.voiceActivity = Math.min(1, Math.max(this.voiceActivity, 0.92));
    this.lastAudibleAt = performance.now();
    if (this.lowVolumeWarned) {
      this.lowVolumeWarned = false;
      this.onVolumeCallback?.({ rms: 0.08, level: 0.72, lowVolume: false });
    }
    clearTimeout(this._wordPulseTimer);
    this._wordPulseTimer = setTimeout(() => {
      if (this.targetVoiceActivity > 0.25) {
        this.targetVoiceActivity = 0.42;
      }
    }, 320);
  }

  pulseSimulation(durationMs = 1350) {
    this.simActive = true;
    clearTimeout(this._simTimer);
    this._simTimer = setTimeout(() => {
      this.simActive = false;
    }, durationMs);
  }

  /**
   * Begins mono 16 kHz PCM capture via AudioWorklet into the rolling ~300ms pre-buffer.
   * Call `attachPcmStream(cb)` once the WS stream is open to flush the pre-buffer and
   * forward live chunks immediately without clipping the first word.
   */
  async startCapture(onPcmChunk = null) {
    if (this.isCapturing) {
      if (onPcmChunk) this.attachPcmStream(onPcmChunk);
      return { ok: true };
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return {
        ok: false,
        errorCode: 'no-mic',
        message: 'Microphone capture is not supported in this browser.',
      };
    }

    this.preBuffer.clear();
    this.onPcmChunk = typeof onPcmChunk === 'function' ? onPcmChunk : null;
    this.isStreamingPcm = Boolean(this.onPcmChunk);
    this.currentRms = 0;
    this.peakRms = 0;
    this.lowVolumeWarned = false;
    this.captureStartedAt = performance.now();
    this.lastAudibleAt = 0;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx();
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      if (!this.audioCtx.audioWorklet) {
        stream.getTracks().forEach((t) => t.stop());
        this.audioCtx.close().catch(() => undefined);
        this.audioCtx = null;
        return {
          ok: false,
          errorCode: 'worklet-unsupported',
          message: 'AudioWorklet is unavailable in this browser context (requires HTTPS or localhost).',
        };
      }

      await this.audioCtx.audioWorklet.addModule('/src/pcm-worklet.js');

      this.mediaStream = stream;
      this.sourceNode = this.audioCtx.createMediaStreamSource(stream);

      this.highpass = this.audioCtx.createBiquadFilter();
      this.highpass.type = 'highpass';
      this.highpass.frequency.value = this.noiseFilterEnabled ? 110 : 20;

      this.lowpass = this.audioCtx.createBiquadFilter();
      this.lowpass.type = 'lowpass';
      this.lowpass.frequency.value = this.noiseFilterEnabled ? 4000 : 12000;

      this.compressor = this.audioCtx.createDynamicsCompressor();
      this.compressor.threshold.value = -26;
      this.compressor.knee.value = 18;
      this.compressor.ratio.value = 5;

      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = this.noiseFilterEnabled ? 1.35 : 1.0;

      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.76;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

      this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm16-capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: {
          targetSampleRate: TARGET_SAMPLE_RATE,
          chunkSamples: 640, // 40ms frames at 16 kHz
        },
      });

      this.workletNode.port.onmessage = (event) => {
        if (!this.isCapturing) return;
        const msg = event.data;
        if (!msg || msg.type !== 'pcm' || !msg.pcm) return;

        const rms = Number(msg.rms || 0);
        this.currentRms = rms;
        if (rms > this.peakRms) this.peakRms = rms;

        const now = performance.now();
        if (rms >= LOW_VOLUME_RMS_THRESHOLD) {
          this.lastAudibleAt = now;
          this.lowVolumeWarned = false;
        } else if (
          now - this.captureStartedAt >= LOW_VOLUME_GRACE_MS &&
          (this.lastAudibleAt === 0 || now - this.lastAudibleAt >= 1800)
        ) {
          this.lowVolumeWarned = true;
        }

        // Normalized 0..1 visual meter level (gentle perceptual curve)
        const normalizedLevel = Math.min(1, Math.pow(Math.min(1, rms * 5.2), 0.75));
        this.voiceActivity = Math.max(this.voiceActivity * 0.65, normalizedLevel);
        this.onVolumeCallback?.({
          rms,
          level: normalizedLevel,
          lowVolume: this.lowVolumeWarned,
        });

        // Always maintain rolling ~300ms pre-buffer so first syllable & reconnects never clip
        this.preBuffer.push(msg.pcm);

        if (this.isStreamingPcm && this.onPcmChunk) {
          this.onPcmChunk(msg.pcm);
        }
      };

      // Connect through a muted gain node so worklet processes without playing mic back to speakers
      this.silentGain = this.audioCtx.createGain();
      this.silentGain.gain.value = 0;

      this.sourceNode.connect(this.highpass);
      this.highpass.connect(this.lowpass);
      this.lowpass.connect(this.compressor);
      this.compressor.connect(this.gainNode);
      this.gainNode.connect(this.analyser);
      this.analyser.connect(this.workletNode);
      this.workletNode.connect(this.silentGain);
      this.silentGain.connect(this.audioCtx.destination);

      this.isCapturing = true;
      this.startRenderLoop();
      return { ok: true };
    } catch (err) {
      this.stopCapture();
      return classifyGetUserMediaError(err);
    }
  }

  /**
   * Flushes the rolling ~300ms pre-buffer in order and switches live streaming ON.
   */
  attachPcmStream(onPcmChunk) {
    this.onPcmChunk = typeof onPcmChunk === 'function' ? onPcmChunk : null;
    this.isStreamingPcm = Boolean(this.onPcmChunk);
    if (!this.isStreamingPcm || !this.onPcmChunk) return 0;

    const buffered = this.preBuffer.drain();
    for (const chunk of buffered) {
      this.onPcmChunk(chunk);
    }
    return buffered.length;
  }

  /**
   * Temporarily pauses outbound PCM forwarding (e.g. during WS reconnect) while keeping
   * AudioWorklet recording into the rolling ~300ms pre-buffer.
   */
  pausePcmStream() {
    this.isStreamingPcm = false;
    this.onPcmChunk = null;
  }

  stopCapture() {
    this.isCapturing = false;
    this.isStreamingPcm = false;
    this.onPcmChunk = null;
    this.currentRms = 0;
    this.lowVolumeWarned = false;
    this.preBuffer.clear();
    this.onVolumeCallback?.({ rms: 0, level: 0, lowVolume: false });

    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
      this.workletNode = null;
    }

    if (this.silentGain) {
      try {
        this.silentGain.disconnect();
      } catch {
        // ignore
      }
      this.silentGain = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    if (this.audioCtx) {
      this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }

    this.analyser = null;
  }

  startRenderLoop() {
    if (this.rafId !== null) return;
    const tick = () => {
      this.voiceActivity += (this.targetVoiceActivity - this.voiceActivity) * 0.16;
      const isHot = this.isCapturing || this.isSpeaking || this.simActive || this.voiceActivity > 0.08;
      this.phase += isHot ? 0.14 + this.voiceActivity * 0.08 : 0.035;
      this.renderAllCanvases();
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  renderAllCanvases() {
    const liveMic = Boolean(this.isCapturing && this.analyser);
    if (liveMic) {
      this.analyser.getByteFrequencyData(this.freqData);
    }

    const active = liveMic || this.isSpeaking || this.simActive || this.voiceActivity > 0.08;

    for (const canvas of this.canvases) {
      if (!canvas.isConnected) {
        this.canvases.delete(canvas);
        continue;
      }

      const rect = canvas.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const targetW = Math.round(rect.width * dpr);
      const targetH = Math.round(rect.height * dpr);

      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const barCount = Math.max(18, Math.min(44, Math.floor(rect.width / 8)));
      const gap = 4;
      const barWidth = Math.max(2.5, (rect.width - gap * (barCount - 1)) / barCount);
      const centerY = rect.height / 2;
      const maxBarH = rect.height * 0.82;
      const minBarH = 4;

      const accentColor = this.isSpeaking && !liveMic ? '#E8D5A3' : '#C9A961';
      const idleColor = canvas.dataset.theme === 'dark' ? 'rgba(201, 169, 97, 0.34)' : 'rgba(11, 15, 25, 0.16)';

      for (let i = 0; i < barCount; i += 1) {
        const normPos = (i / (barCount - 1)) * 2 - 1;
        const bell = Math.cos(normPos * Math.PI * 0.5);
        let energy = 0.08;

        if (liveMic) {
          const binIdx = Math.min(
            this.freqData.length - 1,
            Math.floor((Math.abs(normPos) * 0.65 + 0.05) * this.freqData.length)
          );
          const raw = this.freqData[binIdx] / 255;
          energy = Math.max(0.14, raw * (0.45 + 0.75 * bell));
        } else if (active && !this.reducedMotion) {
          const amp = this.voiceActivity > 0.08 ? Math.max(0.28, this.voiceActivity) : 0.85;
          const wave1 = Math.sin(this.phase * 1.4 + i * 0.45) * 0.5 + 0.5;
          const wave2 = Math.cos(this.phase * 0.9 - i * 0.28) * 0.5 + 0.5;
          energy = (0.16 + 0.78 * amp * wave1 * wave2) * (0.35 + 0.65 * bell);
        } else if (!this.reducedMotion) {
          const idleWave = Math.sin(this.phase + i * 0.32) * 0.5 + 0.5;
          energy = (0.06 + 0.11 * idleWave) * (0.4 + 0.6 * bell);
        } else {
          energy = active ? 0.45 * bell : 0.1 * bell;
        }

        const barH = Math.max(minBarH, energy * maxBarH);
        const x = i * (barWidth + gap);
        const y = centerY - barH / 2;

        ctx.fillStyle = active ? accentColor : idleColor;
        ctx.beginPath();
        const r = Math.min(barWidth / 2, barH / 2);
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(x, y, barWidth, barH, r);
        } else {
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + barWidth - r, y);
          ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + r);
          ctx.lineTo(x + barWidth, y + barH - r);
          ctx.quadraticCurveTo(x + barWidth, y + barH, x + barWidth - r, y + barH);
          ctx.lineTo(x + r, y + barH);
          ctx.quadraticCurveTo(x, y + barH, x, y + barH - r);
          ctx.lineTo(x, y + r);
          ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.closePath();
        }
        ctx.fill();
      }

      ctx.restore();
    }
  }
}
