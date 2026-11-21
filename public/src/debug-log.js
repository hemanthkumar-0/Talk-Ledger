/**
 * Voice Khata — Local Development Voice Debug Logger (public/src/debug-log.js)
 * Hidden in production builds/hosts. Captures recent transcripts, parsed results,
 * confidence scores, and audio diagnostics locally for developer inspection.
 */

const STORAGE_KEY = 'vk-voice-debug-log';
const MAX_ENTRIES = 30;

export function isLocalDebugMode() {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search || '');
    if (params.get('debug') === '0') return false;
    if (params.get('debug') === '1') return true;
    const host = (window.location.hostname || '').toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local') ||
      /^192\.168\./.test(host) ||
      /^10\./.test(host)
    );
  } catch {
    return false;
  }
}

export class VoiceDebugLog {
  constructor() {
    this.enabled = isLocalDebugMode();
    this.records = [];
    if (this.enabled) {
      this._load();
    }
  }

  _load() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.records = parsed.slice(0, MAX_ENTRIES);
      }
    } catch {
      this.records = [];
    }
  }

  _save() {
    if (!this.enabled) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.records.slice(0, MAX_ENTRIES)));
    } catch {
      // ignore quota errors
    }
  }

  add(entry) {
    if (!this.enabled) return null;
    const record = {
      at: new Date().toISOString(),
      transcript: entry.transcript || '',
      normalized: entry.normalized || '',
      language: entry.language || 'en-IN',
      engine: entry.engine || 'unknown',
      intent: entry.parsed?.intent || 'unknown',
      confidence: Number(entry.confidence ?? entry.parsed?.confidence ?? 0),
      lowConfidence: Boolean(entry.parsed?.lowConfidence),
      warnings: entry.parsed?.warnings || [],
      entries: (entry.parsed?.entries || []).map((e) => ({
        customerName: e.customerName,
        action: e.action || (e.type === 'paid' ? 'PAYMENT' : 'CREDIT'),
        amount: e.amount,
        confidence: e.confidence,
        uncertainMatch: Boolean(e.uncertainMatch),
      })),
      rmsPeak: entry.rmsPeak ?? null,
    };

    this.records.unshift(record);
    if (this.records.length > MAX_ENTRIES) {
      this.records.length = MAX_ENTRIES;
    }
    this._save();

    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug('[VoiceKhata VoiceDebug]', record);
    }
    return record;
  }

  clear() {
    this.records = [];
    if (this.enabled) {
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }

  getRecords() {
    return this.enabled ? this.records : [];
  }
}
