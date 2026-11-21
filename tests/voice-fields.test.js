import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatEmailForReadback,
  normalizeSpokenEmail,
  normalizeSpokenName,
  normalizeSpokenPhone,
} from '../public/voice-fields.js';

describe('TalkLedger Fixed-Rule Voice Field Normalizer (public/voice-fields.js)', () => {
  it('normalizes spoken names in English, Hindi, Kannada, and Tamil preserving native scripts', () => {
    assert.equal(normalizeSpokenName('my name is ramesh kumar', 'en'), 'Ramesh Kumar');
    assert.equal(normalizeSpokenName('मेरा नाम रमेश कुमार', 'hi'), 'रमेश कुमार');
    assert.equal(normalizeSpokenName('ನನ್ನ ಹೆಸರು ಕವಿತಾ ಶರ್ಮಾ', 'kn'), 'ಕವಿತಾ ಶರ್ಮಾ');
    assert.equal(normalizeSpokenName('என் பெயர் அர்ஜுன்', 'ta'), 'அர்ஜுன்');
  });

  it('normalizes spoken emails across English, Hindi, Kannada, Tamil, spelled letters & local digits', () => {
    const en1 = normalizeSpokenEmail('ramesh dot kumar at gmail dot com', 'en');
    assert.equal(en1.email, 'ramesh.kumar@gmail.com');
    assert.equal(en1.valid, true);
    assert.equal(en1.readback.includes('r-a-m-e-s-h dot k-u-m-a-r at gmail dot com'), true);

    const spelled = normalizeSpokenEmail('r a m e s h underscore two four at the rate of outlook dot com', 'en');
    assert.equal(spelled.email, 'ramesh_24@outlook.com');
    assert.equal(spelled.valid, true);

    const hi = normalizeSpokenEmail('ramesh डॉट ४२ एट gmail डॉट com', 'hi');
    assert.equal(hi.email, 'ramesh.42@gmail.com');
    assert.equal(hi.valid, true);

    const kn = normalizeSpokenEmail('kavita ಡಾಟ್ ೯೮ ಅಟ್ yahoo ಡಾಟ್ com', 'kn');
    assert.equal(kn.email, 'kavita.98@yahoo.com');
    assert.equal(kn.valid, true);

    const ta = normalizeSpokenEmail('arjun டாட் ௧௨ அட் gmail டாட் com', 'ta');
    assert.equal(ta.email, 'arjun.12@gmail.com');
    assert.equal(ta.valid, true);
  });

  it('rejects invalid emails and offers tap-to-accept domain suggestion without silent completion', () => {
    const partial = normalizeSpokenEmail('ramesh at gmail', 'en');
    assert.equal(partial.valid, false);
    assert.equal(partial.email, 'ramesh@gmail');
    assert.equal(partial.suggestion, 'ramesh@gmail.com');

    const bad = normalizeSpokenEmail('just some random words', 'en');
    assert.equal(bad.valid, false);
    assert.equal(bad.suggestion, null);
  });

  it('normalizes phone numbers with local-script digits and formats letter-by-letter readback', () => {
    const p1 = normalizeSpokenPhone('९८७६५ ४३२१०', 'hi');
    assert.equal(p1.phone, '9876543210');
    assert.equal(p1.valid, true);

    const p2 = normalizeSpokenPhone('12345', 'en');
    assert.equal(p2.valid, false);

    assert.equal(formatEmailForReadback('ab@gmail.com'), 'a-b at gmail dot com');
  });
});
