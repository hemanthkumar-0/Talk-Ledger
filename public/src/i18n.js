/**
 * TalkLedger i18n, RTL, and Locale Formatting Engine
 * Supports en, hi, kn, ta, ur (RTL) with Intl.NumberFormat & Intl.DateTimeFormat.
 */

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', locale: 'en-IN', sttLang: 'en-IN', dir: 'ltr', voiceSupported: true },
  { code: 'hi', label: 'हिन्दी (Hindi)', locale: 'hi-IN', sttLang: 'hi-IN', dir: 'ltr', voiceSupported: true },
  { code: 'kn', label: 'ಕನ್ನಡ (Kannada)', locale: 'kn-IN', sttLang: 'kn-IN', dir: 'ltr', voiceSupported: true },
  { code: 'ta', label: 'தமிழ் (Tamil)', locale: 'ta-IN', sttLang: 'ta-IN', dir: 'ltr', voiceSupported: true },
  { code: 'ur', label: 'اردو (Urdu · RTL)', locale: 'ur-IN', sttLang: 'ur-IN', dir: 'rtl', voiceSupported: true },
];

const LANG_STORAGE_KEY = 'talkledger-lang';
const cache = new Map();
let activeLang = 'en';
let activeDict = null;
const listeners = new Set();

function resolveKey(dict, keyPath) {
  if (!dict || !keyPath) return null;
  const parts = keyPath.split('.');
  let cur = dict;
  for (const part of parts) {
    if (cur && typeof cur === 'object' && part in cur) {
      cur = cur[part];
    } else {
      return null;
    }
  }
  return typeof cur === 'string' ? cur : null;
}

export async function loadLanguage(langCode = 'en') {
  const meta = SUPPORTED_LANGUAGES.find((l) => l.code === langCode) || SUPPORTED_LANGUAGES[0];

  if (!cache.has('en')) {
    const enRes = await fetch('/locales/en.json');
    cache.set('en', await enRes.json());
  }

  if (!cache.has(meta.code)) {
    const res = await fetch(`/locales/${meta.code}.json`);
    if (res.ok) {
      cache.set(meta.code, await res.json());
    }
  }

  activeLang = meta.code;
  activeDict = cache.get(meta.code) || cache.get('en');

  try {
    localStorage.setItem(LANG_STORAGE_KEY, activeLang);
  } catch {
    // ignore
  }

  document.documentElement.lang = meta.code;
  document.documentElement.dir = meta.dir;

  applyTranslationsToDom();
  listeners.forEach((fn) => fn(meta));
  return meta;
}

export function getSavedLanguage() {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved && SUPPORTED_LANGUAGES.some((l) => l.code === saved)) {
      return saved;
    }
  } catch {
    // ignore
  }
  return 'en';
}

export function getLanguageMeta(code = activeLang) {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code) || SUPPORTED_LANGUAGES[0];
}

export function getActiveLanguage() {
  return activeLang;
}

export function isRtl() {
  return getLanguageMeta().dir === 'rtl';
}

export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key, vars = {}) {
  let str = resolveKey(activeDict, key) ?? resolveKey(cache.get('en'), key) ?? key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replaceAll(`{${k}}`, String(v));
  }
  return str;
}

export function formatCurrencyInr(amount, opts = {}) {
  const meta = getLanguageMeta();
  const num = Number(amount || 0);
  const abs = Math.abs(num);
  const hasDecimals = Math.abs(abs - Math.round(abs)) > 0.004;
  try {
    return new Intl.NumberFormat(meta.locale, {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: hasDecimals ? 2 : 0,
      maximumFractionDigits: hasDecimals ? 2 : 0,
      ...opts,
    }).format(opts.signed ? num : abs);
  } catch {
    return `₹${(opts.signed ? num : abs).toFixed(hasDecimals ? 2 : 0)}`;
  }
}

export function formatNumber(value, maxDecimals = 0) {
  const meta = getLanguageMeta();
  try {
    return new Intl.NumberFormat(meta.locale, { maximumFractionDigits: maxDecimals }).format(Number(value || 0));
  } catch {
    return String(value);
  }
}

export function formatLocalizedDate(isoDate, options = { day: 'numeric', month: 'short' }) {
  if (!isoDate) return '';
  const meta = getLanguageMeta();
  const d = isoDate.length === 7 ? new Date(`${isoDate}-01T12:00:00`) : new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  try {
    return new Intl.DateTimeFormat(meta.locale, options).format(d);
  } catch {
    return isoDate;
  }
}

export function applyTranslationsToDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.setAttribute('placeholder', t(key));
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    if (key) el.setAttribute('aria-label', t(key));
  });
}
