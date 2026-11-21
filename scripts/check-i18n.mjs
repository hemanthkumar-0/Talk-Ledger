import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.resolve(__dirname, '../public/locales');

function flattenKeys(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_meta') continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenKeys(v, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function extractPlaceholders(str) {
  return Array.from(String(str).matchAll(/\{([a-zA-Z0-9_]+)\}/g), (m) => m[1]).sort();
}

const files = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json')).sort();
if (!files.includes('en.json')) {
  process.stderr.write('Missing base locale en.json\n');
  process.exit(1);
}

const baseData = JSON.parse(fs.readFileSync(path.join(localesDir, 'en.json'), 'utf8'));
const baseKeys = flattenKeys(baseData);
const baseKeyList = Object.keys(baseKeys).sort();

let failed = false;

process.stdout.write(`i18n Key Consistency Check — Base en.json has ${baseKeyList.length} keys\n\n`);

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));
  const keys = flattenKeys(data);
  const keyList = Object.keys(keys).sort();

  const missing = baseKeyList.filter((k) => !(k in keys));
  const extra = keyList.filter((k) => !(k in baseKeys));
  const empty = keyList.filter((k) => typeof keys[k] !== 'string' || keys[k].trim() === '');
  const placeholderMismatch = [];

  for (const k of baseKeyList) {
    if (!(k in keys)) continue;
    const pBase = extractPlaceholders(baseKeys[k]).join(',');
    const pLoc = extractPlaceholders(keys[k]).join(',');
    if (pBase !== pLoc) {
      placeholderMismatch.push(`${k} (expected {${pBase}}, got {${pLoc}})`);
    }
  }

  const ok = missing.length === 0 && extra.length === 0 && empty.length === 0 && placeholderMismatch.length === 0;
  const reviewTag = data._meta?.financialTermsStatus || '';
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(10)} | keys: ${keyList.length} | dir: ${data._meta?.dir || 'ltr'} | financial: ${reviewTag}\n`
  );

  if (!ok) {
    failed = true;
    if (missing.length) process.stdout.write(`  Missing: ${JSON.stringify(missing)}\n`);
    if (extra.length) process.stdout.write(`  Extra: ${JSON.stringify(extra)}\n`);
    if (empty.length) process.stdout.write(`  Empty: ${JSON.stringify(empty)}\n`);
    if (placeholderMismatch.length) {
      process.stdout.write(`  Placeholder mismatch: ${JSON.stringify(placeholderMismatch)}\n`);
    }
  }
}

process.exit(failed ? 1 : 0);
