/**
 * Voice Khata — Pure Audio Timing, Resampling & Rolling Pre-Buffer Utilities
 * Shared between browser AudioEngine / VoiceEngine and Node.js unit tests.
 */

export const TARGET_SAMPLE_RATE = 16000;
export const PRE_BUFFER_MS = 300;
export const POST_RELEASE_TAIL_MS = 400;
export const MIN_PRESS_MS = 400;
export const LOW_VOLUME_RMS_THRESHOLD = 0.014;
export const LOW_VOLUME_GRACE_MS = 950;

/**
 * Computes Root Mean Square amplitude (0..1) of a Float32 PCM buffer.
 */
export function computeRms(float32Buffer) {
  if (!float32Buffer || float32Buffer.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < float32Buffer.length; i += 1) {
    const s = float32Buffer[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / float32Buffer.length);
}

/**
 * Resamples mono Float32 samples from any input sample rate to 16 kHz Int16 PCM.
 */
export function resampleToInt16PCM(float32Buffer, inputSampleRate, targetRate = TARGET_SAMPLE_RATE) {
  if (!float32Buffer || float32Buffer.length === 0) return new Int16Array(0);

  if (inputSampleRate === targetRate) {
    const out = new Int16Array(float32Buffer.length);
    for (let i = 0; i < float32Buffer.length; i += 1) {
      const s = Math.max(-1, Math.min(1, float32Buffer[i]));
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
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
    const sample =
      count > 0 ? sum / count : float32Buffer[Math.min(start, float32Buffer.length - 1)] || 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }

  return out;
}

/**
 * Rolling ring-style pre-buffer storing the most recent `maxMs` (~300ms) of
 * 16 kHz Int16 PCM ArrayBuffer chunks so the very first word is never clipped
 * while WebSocket streaming connects or reconnects.
 */
export class PcmPreBuffer {
  constructor(maxMs = PRE_BUFFER_MS, sampleRate = TARGET_SAMPLE_RATE) {
    this.maxMs = maxMs;
    this.sampleRate = sampleRate;
    this.maxBytes = Math.ceil((sampleRate * 2 * maxMs) / 1000); // 16-bit mono = 2 bytes/sample
    this.chunks = [];
    this.totalBytes = 0;
  }

  push(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength === 0) return;
    // Clone so transferred/detached buffers are safe
    const copy = arrayBuffer.slice(0);
    this.chunks.push(copy);
    this.totalBytes += copy.byteLength;

    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.totalBytes -= dropped.byteLength;
    }
  }

  /**
   * Drains buffered chunks in chronological order and resets the buffer.
   */
  drain() {
    const out = this.chunks.slice();
    this.chunks = [];
    this.totalBytes = 0;
    return out;
  }

  /**
   * Returns current buffered duration in milliseconds.
   */
  getBufferedMs() {
    return Math.round((this.totalBytes / (this.sampleRate * 2)) * 1000);
  }

  clear() {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
