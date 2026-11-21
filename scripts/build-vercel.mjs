import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const srcSupabaseUmd = path.join(
  rootDir,
  'node_modules/@supabase/supabase-js/dist/umd/supabase.js'
);
const destVendorDir = path.join(rootDir, 'public/vendor');
const destSupabaseUmd = path.join(destVendorDir, 'supabase.js');

if (!fs.existsSync(srcSupabaseUmd)) {
  throw new Error(`Missing @supabase/supabase-js browser bundle at ${srcSupabaseUmd}`);
}

fs.mkdirSync(destVendorDir, { recursive: true });
fs.copyFileSync(srcSupabaseUmd, destSupabaseUmd);

process.stdout.write('Voice Khata static build ready (public/vendor/supabase.js copied).\n');
