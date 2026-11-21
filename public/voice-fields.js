/**
 * TalkLedger Fixed-Rule Voice-to-Field Normalizer (NO AI / Zero LLM)
 * Handles Full Name, Email Address, and Phone Number across en, hi, kn, ta, ur.
 * NEVER used for passwords, PINs, or OTP/login codes.
 */

import {
  COMMON_EMAIL_DOMAINS,
  LOCAL_SCRIPT_DIGITS,
  VOICE_FIELD_KEYWORDS,
} from './locales/voice-keywords.js';

const EMAIL_REGEX = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces Devanagari, Kannada, Tamil, and Urdu/Arabic-Indic numerals with ASCII 0-9.
 */
export function normalizeLocalDigits(input) {
  if (!input) return '';
  return String(input).replace(/[०-९೦-೯௦-௯۰-۹٠-٩]/g, (ch) => LOCAL_SCRIPT_DIGITS[ch] ?? ch);
}

function getLangPack(lang = 'en') {
  const base = String(lang || 'en').toLowerCase().split(/[-_]/)[0];
  return VOICE_FIELD_KEYWORDS[base] || VOICE_FIELD_KEYWORDS.en;
}

/**
 * Normalizes a spoken Full Name:
 * - Trims and removes language-specific filler phrases
 * - Preserves native scripts (Devanagari, Kannada, Tamil, Urdu) as spoken
 * - Capitalizes Latin-script words cleanly
 */
export function normalizeSpokenName(raw, lang = 'en') {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.trim().replace(/[.,!?;:"'()]+/g, ' ');

  const fillers = [
    ...(getLangPack(lang).fillers || []),
    ...(VOICE_FIELD_KEYWORDS.en.fillers || []),
  ].sort((a, b) => b.length - a.length);

  for (const filler of fillers) {
    const rx = new RegExp(`(?:^|\\s)${escapeRegExp(filler)}(?:\\s|$)`, 'giu');
    text = text.replace(rx, ' ');
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';

  return text
    .split(' ')
    .map((word) => {
      if (/^[A-Za-z]/.test(word)) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      return word;
    })
    .join(' ');
}

/**
 * Normalizes a spoken Email Address using pure deterministic rules:
 * - Local-script digits & spoken number words -> 0-9
 * - Spoken symbol phrases (at / at the rate / dot / underscore / dash / hyphen / plus) -> @ . _ - +
 * - Joins spelled letters ("r a m e s h" -> "ramesh")
 * - Removes spaces, lowercases, validates format
 * - Returns tap-to-accept domain suggestion (gmail/yahoo/outlook) without silently altering email
 */
export function normalizeSpokenEmail(raw, lang = 'en') {
  if (!raw || typeof raw !== 'string') {
    return { email: '', valid: false, suggestion: null, readback: '' };
  }

  let text = normalizeLocalDigits(raw).trim().toLowerCase();

  // Strip conversational fillers at start
  const fillers = [
    ...(getLangPack(lang).fillers || []),
    ...(VOICE_FIELD_KEYWORDS.en.fillers || []),
  ].sort((a, b) => b.length - a.length);

  for (const filler of fillers) {
    const leadRx = new RegExp(`^${escapeRegExp(filler.toLowerCase())}\\s+`, 'iu');
    text = text.replace(leadRx, '');
  }

  // Gather symbol mappings for active language + English fallback
  const langPack = getLangPack(lang);
  const symbolOrder = ['@', '.', '_', '-', '+'];
  const replacements = [];

  for (const sym of symbolOrder) {
    const phrases = [
      ...(langPack.symbols?.[sym] || []),
      ...(VOICE_FIELD_KEYWORDS.en.symbols?.[sym] || []),
    ];
    for (const p of phrases) {
      replacements.push({ phrase: p.toLowerCase(), sym });
    }
  }
  // Longest phrases first ("at the rate of" before "at")
  replacements.sort((a, b) => b.phrase.length - a.phrase.length);

  for (const { phrase, sym } of replacements) {
    const rx = new RegExp(`(^|\\s)${escapeRegExp(phrase)}(?=\\s|$)`, 'giu');
    text = text.replace(rx, `$1 ${sym} `);
  }

  // Convert spoken digit words (per language + English) into 0-9
  const digitMap = {
    ...(VOICE_FIELD_KEYWORDS.en.digits || {}),
    ...(langPack.digits || {}),
  };

  const tokens = text
    .replace(/([@._+-])/g, ' $1 ')
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => (tok in digitMap ? digitMap[tok] : tok));

  // Join tokens cleanly — naturally collapses spelled letters ("r", "a", "m", "e", "s", "h") -> "ramesh"
  let candidate = tokens
    .join('')
    .replace(/[,;:!?'"()]+/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .toLowerCase();

  // Check if user said a common domain without ".com" (e.g., "ramesh@gmail")
  let suggestion = null;
  if (candidate.includes('@')) {
    const [localPart, domainPart] = candidate.split('@');
    if (localPart && domainPart) {
      const match = COMMON_EMAIL_DOMAINS.find((d) => d.keyword === domainPart);
      if (match) {
        suggestion = `${localPart}@${match.domain}`;
      }
    }
  } else {
    // Check trailing domain word with no "@" (e.g. "rameshgmail")
    for (const d of COMMON_EMAIL_DOMAINS) {
      if (candidate.endsWith(d.domain) && candidate.length > d.domain.length) {
        const prefix = candidate.slice(0, -d.domain.length);
        if (/^[a-z0-9._%+-]+$/.test(prefix)) {
          suggestion = `${prefix}@${d.domain}`;
          break;
        }
      }
    }
  }

  const valid = EMAIL_REGEX.test(candidate);
  const readback = formatEmailForReadback(valid ? candidate : suggestion || candidate);

  return {
    email: candidate,
    valid,
    suggestion: valid ? null : suggestion,
    readback,
  };
}

/**
 * Formats an email address letter-by-letter for clear spoken verification:
 * "ramesh@gmail.com" -> "r-a-m-e-s-h at gmail dot com"
 */
export function formatEmailForReadback(email) {
  if (!email) return '';
  if (!email.includes('@')) {
    return email.split('').join('-');
  }
  const [local, domain] = email.split('@');
  const spelledLocal = local
    .split('')
    .map((ch) => {
      if (ch === '.') return ' dot ';
      if (ch === '_') return ' underscore ';
      if (ch === '-') return ' dash ';
      if (ch === '+') return ' plus ';
      return ch;
    })
    .join('-')
    .replace(/-?\s+(dot|underscore|dash|plus)\s+-?/g, ' $1 ');

  const readableDomain = domain.replace(/\./g, ' dot ');
  return `${spelledLocal} at ${readableDomain}`.replace(/\s+/g, ' ').trim();
}

/**
 * Normalizes a spoken phone number: local-script & spoken digits -> ASCII digits only,
 * validates standard 10-digit Indian or 10-15 digit E.164 length.
 */
export function normalizeSpokenPhone(raw, lang = 'en') {
  if (!raw || typeof raw !== 'string') {
    return { phone: '', valid: false };
  }

  let text = normalizeLocalDigits(raw).trim().toLowerCase();
  const digitMap = {
    ...(VOICE_FIELD_KEYWORDS.en.digits || {}),
    ...(getLangPack(lang).digits || {}),
  };

  text = text
    .split(/\s+/)
    .map((tok) => (tok in digitMap ? digitMap[tok] : tok))
    .join('');

  const digits = text.replace(/\D/g, '');
  const valid = digits.length === 10 || (digits.length >= 11 && digits.length <= 15);
  return { phone: digits, valid };
}
