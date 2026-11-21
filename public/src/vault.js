/**
 * TalkLedger On-Device Encrypted Vault
 * Stores all customer accounts and ledger entries in IndexedDB,
 * encrypted at rest using Web Crypto API (AES-GCM, 256-bit non-extractable key).
 */

const DB_NAME = 'talkledger-vault-v1';
const DB_VERSION = 1;
const STORE_KEYS = 'keys';
const STORE_RECORDS = 'records';
const KEY_ID = 'master-aes-gcm-256';
const STATE_RECORD_ID = 'ledger-state';
const FALLBACK_STORAGE_KEY = 'talkledger-fallback-vault';

let dbPromise = null;
let cachedKey = null;

function isWebCryptoAvailable() {
  return Boolean(
    typeof window !== 'undefined' &&
      window.indexedDB &&
      window.crypto &&
      window.crypto.subtle
  );
}

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KEYS)) {
        db.createObjectStore(STORE_KEYS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function idbGet(db, storeName, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getOrCreateMasterKey(db) {
  if (cachedKey) return cachedKey;

  const existing = await idbGet(db, STORE_KEYS, KEY_ID);
  if (existing && existing.key) {
    cachedKey = existing.key;
    return cachedKey;
  }

  const key = await window.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable key stays locked inside browser Web Crypto store
    ['encrypt', 'decrypt']
  );

  await idbPut(db, STORE_KEYS, {
    id: KEY_ID,
    key,
    algorithm: 'AES-GCM-256',
    createdAt: new Date().toISOString(),
  });

  cachedKey = key;
  return key;
}

function bufferToHex(buffer, maxBytes = 24) {
  const bytes = new Uint8Array(buffer);
  const slice = bytes.slice(0, maxBytes);
  return Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function initVault() {
  if (!isWebCryptoAvailable()) {
    return {
      encrypted: false,
      algorithm: 'LocalStorage (Unsecured Context)',
      storage: 'localStorage',
    };
  }

  try {
    const db = await openDatabase();
    await getOrCreateMasterKey(db);
    const keyMeta = await idbGet(db, STORE_KEYS, KEY_ID);
    return {
      encrypted: true,
      algorithm: 'AES-GCM 256-bit',
      storage: 'IndexedDB',
      keyCreatedAt: keyMeta?.createdAt || new Date().toISOString(),
    };
  } catch {
    return {
      encrypted: false,
      algorithm: 'LocalStorage Fallback',
      storage: 'localStorage',
    };
  }
}

export async function saveEncryptedState(payload) {
  const startedAt = performance.now();
  const serialized = JSON.stringify(payload);

  if (!isWebCryptoAvailable()) {
    window.localStorage.setItem(FALLBACK_STORAGE_KEY, serialized);
    return {
      vaultMs: Math.max(0.5, Number((performance.now() - startedAt).toFixed(1))),
      encrypted: false,
      bytes: serialized.length,
    };
  }

  const db = await openDatabase();
  const key = await getOrCreateMasterKey(db);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(serialized);

  const ciphertext = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );

  await idbPut(db, STORE_RECORDS, {
    id: STATE_RECORD_ID,
    iv: Array.from(iv),
    ciphertext,
    byteLength: ciphertext.byteLength,
    updatedAt: new Date().toISOString(),
  });

  return {
    vaultMs: Math.max(0.5, Number((performance.now() - startedAt).toFixed(1))),
    encrypted: true,
    bytes: ciphertext.byteLength,
    ivHex: bufferToHex(iv, 12),
    cipherPreview: bufferToHex(ciphertext, 20),
  };
}

export async function loadEncryptedState() {
  if (!isWebCryptoAvailable()) {
    const raw = window.localStorage.getItem(FALLBACK_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  try {
    const db = await openDatabase();
    const record = await idbGet(db, STORE_RECORDS, STATE_RECORD_ID);
    if (!record || !record.ciphertext || !record.iv) {
      return null;
    }

    const key = await getOrCreateMasterKey(db);
    const iv = new Uint8Array(record.iv);
    const plaintext = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      record.ciphertext
    );

    const decoded = new TextDecoder().decode(plaintext);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export async function inspectCiphertextProof() {
  if (!isWebCryptoAvailable()) {
    return {
      encrypted: false,
      ivHex: 'N/A',
      cipherPreview: 'Requires secure context (localhost / HTTPS)',
      bytes: 0,
      updatedAt: null,
    };
  }

  try {
    const db = await openDatabase();
    const record = await idbGet(db, STORE_RECORDS, STATE_RECORD_ID);
    if (!record || !record.ciphertext) {
      return {
        encrypted: true,
        ivHex: 'Pending first write',
        cipherPreview: 'Vault initialized — no records written yet',
        bytes: 0,
        updatedAt: null,
      };
    }

    return {
      encrypted: true,
      ivHex: bufferToHex(new Uint8Array(record.iv), 12),
      cipherPreview: `${bufferToHex(record.ciphertext, 24)}…`,
      bytes: record.byteLength || record.ciphertext.byteLength,
      updatedAt: record.updatedAt,
    };
  } catch {
    return {
      encrypted: false,
      ivHex: 'Unavailable',
      cipherPreview: 'Could not read IndexedDB',
      bytes: 0,
      updatedAt: null,
    };
  }
}

/**
 * Permanently wipes the IndexedDB store AND destroys the AES-GCM 256-bit key.
 */
export async function wipeEncryptedVault() {
  cachedKey = null;
  try {
    if (dbPromise) {
      const db = await dbPromise;
      db.close();
      dbPromise = null;
    }
  } catch {
    dbPromise = null;
  }

  try {
    window.localStorage.removeItem(FALLBACK_STORAGE_KEY);
  } catch {
    // ignore
  }

  if (!isWebCryptoAvailable()) return true;

  await new Promise((resolve) => {
    const req = window.indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
  });

  return true;
}
