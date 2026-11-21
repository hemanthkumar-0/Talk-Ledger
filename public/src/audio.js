/**
 * TalkLedger Audio Capture & 60fps Marigold Waveform Engine
 * - Captures 16 kHz mono Int16 PCM audio via Web Audio API for Gnani Prisma STT
 * - Includes Shop Noise Filter (120Hz High-Pass + 3.8kHz Low-Pass + DynamicsCompressor + Gain)
 * - Drives a silky 60fps AnalyserNode gold waveform across any registered canvas
 */

const TARGET_SAMPLE_RATE = 16000;

function downsampleToInt16PCM(float32Buffer, inputSampleRate, targetRate = TARGET_SAMPLE_RATE) {
  if (inputSampleRate === targetRate) {
    const out = new Int16Array(float32Buffer.length);
    for (let i = 0; i < float32Buffer.length; i += 1) {
      const s = Math.max(-1, Math.min(1, float32Buffer[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  const ratio = inputSampleRate / targetRate;
  const outputLength = Math.max(1, Math.round(float32Buffer.length / ratio));
  const out = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(float32Buffer.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += float32Buffer[j];
      count += 1;
    }
    const sample = count > 0 ? sum / count : float32Buffer[Math.min(start, float32Buffer.length - 1)] || 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  return out;
}

export class AudioEngine {
  constructor() {
    this.audioCtx = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.analyser = null;
    this.processorNode = null;
    this.highpass = null;
    this.lowpass = null;
    this.compressor = null;
    this.gainNode = null;
    this.noiseFilterEnabled = true;
    this.isCapturing = false;
    this.isSpeaking = false;
    this.simActive = false;
    this.onPcmChunk = null;
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

  setNoiseFilter(enabled) {
    this.noiseFilterEnabled = Boolean(enabled);
    if (this.highpass && this.lowpass && this.gainNode && this.audioCtx) {
      const now = this.audioCtx.currentTime;
      this.highpass.frequency.setTargetAtTime(this.noiseFilterEnabled ? 120 : 20, now, 0.04);
      this.lowpass.frequency.setTargetAtTime(this.noiseFilterEnabled ? 3800 : 12000, now, 0.04);
      this.gainNode.gain.setTargetAtTime(this.noiseFilterEnabled ? 1.45 : 1.0, now, 0.04);
    }
  }

  setSpeakingState(active) {
    this.isSpeaking = Boolean(active);
  }

  pulseSimulation(durationMs = 1350) {
    this.simActive = true;
    clearTimeout(this._simTimer);
    this._simTimer = setTimeout(() => {
      this.simActive = false;
    }, durationMs);
  }

  async startCapture(onPcmChunk) {
    if (this.isCapturing) return true;
    this.onPcmChunk = onPcmChunk || null;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: this.noiseFilterEnabled,
          autoGainControl: this.noiseFilterEnabled,
        },
      });

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx();
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      this.mediaStream = stream;
      this.sourceNode = this.audioCtx.createMediaStreamSource(stream);

      this.highpass = this.audioCtx.createBiquadFilter();
      this.highpass.type = 'highpass';
      this.highpass.frequency.value = this.noiseFilterEnabled ? 120 : 20;

      this.lowpass = this.audioCtx.createBiquadFilter();
      this.lowpass.type = 'lowpass';
      this.lowpass.frequency.value = this.noiseFilterEnabled ? 3800 : 12000;

      this.compressor = this.audioCtx.createDynamicsCompressor();
      this.compressor.threshold.value = -24;
      this.compressor.knee.value = 18;
      this.compressor.ratio.value = 6;

      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = this.noiseFilterEnabled ? 1.45 : 1.0;

      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.78;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

      this.sourceNode.connect(this.highpass);
      this.highpass.connect(this.lowpass);
      this.lowpass.connect(this.compressor);
      this.compressor.connect(this.gainNode);
      this.gainNode.connect(this.analyser);

      // Stream 16 kHz mono Int16 PCM frames if a consumer (Gnani Prisma WS) is attached
      if (typeof this.audioCtx.createScriptProcessor === 'function') {
        const silentGain = this.audioCtx.createGain();
        silentGain.gain.value = 0;

        this.processorNode = this.audioCtx.createScriptProcessor(2048, 1, 1);
        this.processorNode.onaudioprocess = (event) => {
          if (!this.isCapturing || !this.onPcmChunk) return;
          const input = event.inputBuffer.getChannelData(0);
          const pcm16 = downsampleToInt16PCM(input, this.audioCtx.sampleRate, TARGET_SAMPLE_RATE);
          this.onPcmChunk(pcm16.buffer);
        };

        this.analyser.connect(this.processorNode);
        this.processorNode.connect(silentGain);
        silentGain.connect(this.audioCtx.destination);
      }

      this.isCapturing = true;
      this.startRenderLoop();
      return true;
    } catch {
      this.isCapturing = false;
      return false;
    }
  }

  stopCapture() {
    this.isCapturing = false;
    this.onPcmChunk = null;

    if (this.processorNode) {
      try {
        this.processorNode.disconnect();
      } catch {
        // ignore
      }
      this.processorNode = null;
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
      this.phase += this.isCapturing || this.isSpeaking || this.simActive ? 0.14 : 0.035;
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

    const active = liveMic || this.isSpeaking || this.simActive;

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

      const accentColor = this.isSpeaking && !liveMic ? '#7A1424' : '#E6A825';
      const idleColor = canvas.dataset.theme === 'dark' ? 'rgba(230, 168, 37, 0.36)' : 'rgba(19, 29, 51, 0.16)';

      for (let i = 0; i < barCount; i += 1) {
        const normPos = (i / (barCount - 1)) * 2 - 1; // -1..1
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
          const wave1 = Math.sin(this.phase * 1.4 + i * 0.45) * 0.5 + 0.5;
          const wave2 = Math.cos(this.phase * 0.9 - i * 0.28) * 0.5 + 0.5;
          energy = (0.2 + 0.72 * wave1 * wave2) * (0.35 + 0.65 * bell);
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
          // Cross-browser fallback for older iOS Safari / Android WebViews
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
