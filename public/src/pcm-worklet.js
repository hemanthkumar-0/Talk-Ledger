/**
 * Voice Khata — AudioWorklet PCM16 Capture & 16 kHz Resampler (public/src/pcm-worklet.js)
 * Runs off the main thread for glitch-free low-latency mono 16 kHz 16-bit PCM capture
 * and live RMS volume metering. Replaces deprecated ScriptProcessorNode completely.
 */

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES_16K = 640; // 40ms frames at 16 kHz (optimal for streaming STT)

class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    this.targetRate = Number(opts.targetSampleRate) || TARGET_SAMPLE_RATE;
    this.chunkSamples = Number(opts.chunkSamples) || CHUNK_SAMPLES_16K;
    this.ratio = sampleRate / this.targetRate;
    this.pos = 0; // fractional sample cursor carried cleanly across 128-frame quanta
    this.prevSample = 0;
    this.outBuf = new Int16Array(this.chunkSamples);
    this.outIdx = 0;
    this.rmsSumSq = 0;
    this.rmsCount = 0;
    this.peak = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    const len = channel.length;

    // Accumulate input RMS & peak for real-time volume meter and low-volume warning
    for (let i = 0; i < len; i += 1) {
      const s = channel[i];
      const abs = s < 0 ? -s : s;
      if (abs > this.peak) this.peak = abs;
      this.rmsSumSq += s * s;
      this.rmsCount += 1;
    }

    if (Math.abs(this.ratio - 1) < 0.001) {
      // Already 16 kHz mono
      for (let i = 0; i < len; i += 1) {
        const clamped = Math.max(-1, Math.min(1, channel[i]));
        this.outBuf[this.outIdx++] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
        if (this.outIdx >= this.chunkSamples) {
          this._flushChunk();
        }
      }
      this.prevSample = channel[len - 1];
      return true;
    }

    // Box-averaged / linearly interpolated downsampling to 16 kHz with zero drift across blocks
    let cursor = this.pos;
    while (cursor < len) {
      const idx0 = Math.floor(cursor);
      const frac = cursor - idx0;
      const s0 = idx0 < 0 ? this.prevSample : channel[idx0];
      const s1 = idx0 + 1 < len ? channel[idx0 + 1] : s0;

      // Average neighboring span when downsampling >= 2x to reduce aliasing
      let sample;
      if (this.ratio >= 2) {
        const spanEnd = Math.min(len, Math.ceil(cursor + this.ratio));
        let sum = 0;
        let cnt = 0;
        for (let k = Math.max(0, idx0); k < spanEnd; k += 1) {
          sum += channel[k];
          cnt += 1;
        }
        sample = cnt > 0 ? sum / cnt : s0 + (s1 - s0) * frac;
      } else {
        sample = s0 + (s1 - s0) * frac;
      }

      const clamped = Math.max(-1, Math.min(1, sample));
      this.outBuf[this.outIdx++] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);

      if (this.outIdx >= this.chunkSamples) {
        this._flushChunk();
      }
      cursor += this.ratio;
    }

    this.pos = cursor - len;
    this.prevSample = channel[len - 1];
    return true;
  }

  _flushChunk() {
    const pcmCopy = new Int16Array(this.outBuf.subarray(0, this.outIdx));
    const rms = this.rmsCount > 0 ? Math.sqrt(this.rmsSumSq / this.rmsCount) : 0;
    const peak = this.peak;

    this.outIdx = 0;
    this.rmsSumSq = 0;
    this.rmsCount = 0;
    this.peak = 0;

    this.port.postMessage(
      {
        type: 'pcm',
        pcm: pcmCopy.buffer,
        rms,
        peak,
        sampleRate: this.targetRate,
      },
      [pcmCopy.buffer]
    );
  }
}

registerProcessor('pcm16-capture-processor', Pcm16CaptureProcessor);
