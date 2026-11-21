import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeRms,
  LOW_VOLUME_RMS_THRESHOLD,
  MIN_PRESS_MS,
  PcmPreBuffer,
  POST_RELEASE_TAIL_MS,
  PRE_BUFFER_MS,
  resampleToInt16PCM,
  TARGET_SAMPLE_RATE,
} from '../public/src/audio-utils.js';

describe('Voice Khata Audio Capture Utilities (16 kHz PCM16 & Rolling Pre-Buffer)', () => {
  it('enforces exact timing constants for pre-buffer, short-press guard, and post-release tail', () => {
    assert.equal(TARGET_SAMPLE_RATE, 16000);
    assert.equal(PRE_BUFFER_MS, 300);
    assert.equal(MIN_PRESS_MS, 400);
    assert.equal(POST_RELEASE_TAIL_MS, 400);
  });

  it('resamples 48 kHz and 44.1 kHz mono Float32 buffers accurately to 16 kHz Int16 PCM', () => {
    // 100ms of 440 Hz sine at 48 kHz -> 4800 samples -> 1600 samples at 16 kHz
    const in48k = new Float32Array(4800);
    for (let i = 0; i < in48k.length; i += 1) {
      in48k[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    const out16k = resampleToInt16PCM(in48k, 48000, 16000);
    assert.equal(out16k.length, 1600);
    assert.ok(out16k instanceof Int16Array);
    // Peak should remain close to 0.5 * 32767 = ~16383
    let maxAbs = 0;
    for (let i = 0; i < out16k.length; i += 1) {
      maxAbs = Math.max(maxAbs, Math.abs(out16k[i]));
    }
    assert.ok(maxAbs > 14000 && maxAbs < 17500, `Unexpected peak amplitude ${maxAbs}`);

    // 100ms at 44.1 kHz -> 4410 samples -> 1600 samples at 16 kHz
    const in44k = new Float32Array(4410).fill(0.25);
    const outFrom44k = resampleToInt16PCM(in44k, 44100, 16000);
    assert.equal(outFrom44k.length, 1600);
    assert.ok(Math.abs(outFrom44k[100] - Math.round(0.25 * 32767)) <= 2);
  });

  it('maintains a rolling ~300ms PCM16 pre-buffer and drains in chronological order', () => {
    const pre = new PcmPreBuffer(300, 16000);
    // Push 10 chunks of 50ms each (800 samples = 1600 bytes per chunk -> total 500ms pushed)
    for (let c = 1; c <= 10; c += 1) {
      const chunk = new Int16Array(800).fill(c);
      pre.push(chunk.buffer);
    }

    // Should retain <= 300ms (6 chunks = 300ms = 9600 bytes)
    assert.equal(pre.getBufferedMs(), 300);
    const drained = pre.drain();
    assert.equal(drained.length, 6);
    assert.equal(pre.getBufferedMs(), 0);

    // Chunks retained must be the latest 6 in chronological order: 5, 6, 7, 8, 9, 10
    const markers = drained.map((buf) => new Int16Array(buf)[0]);
    assert.deepEqual(markers, [5, 6, 7, 8, 9, 10]);
  });

  it('distinguishes low-volume silence from normal speech RMS cleanly', () => {
    const quiet = new Float32Array(1024).fill(0.002);
    const spoken = new Float32Array(1024);
    for (let i = 0; i < spoken.length; i += 1) {
      spoken[i] = 0.25 * Math.sin((2 * Math.PI * 300 * i) / 16000);
    }
    assert.ok(computeRms(quiet) < LOW_VOLUME_RMS_THRESHOLD);
    assert.ok(computeRms(spoken) > LOW_VOLUME_RMS_THRESHOLD);
  });
});
