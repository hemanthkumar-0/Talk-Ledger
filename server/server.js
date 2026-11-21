import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { WebSocketServer } from 'ws';
import { attachPrismaRelay, getGnaniConfig, synthesizeWithTimbre } from './gnaniClient.js';
import { closePostgresPool, getPostgresStatus } from './postgres.js';
import { disconnectPrisma, getPrismaStatus } from './prisma.js';
import {
  getSupabasePublicConfig,
  getSupabaseServerStatus,
  requireSupabaseAuth,
} from './supabase.js';

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');
const supabaseUmdPath = path.resolve(__dirname, '../node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=()');
  next();
});

// Lightweight IP rate limiter for voice proxy endpoints
const rateBuckets = new Map();
function voiceRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'local';
  const now = Date.now();
  const windowMs = 60_000;
  const maxReqs = 60;
  const rec = rateBuckets.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > rec.resetAt) {
    rec.count = 0;
    rec.resetAt = now + windowMs;
  }
  rec.count += 1;
  rateBuckets.set(ip, rec);
  if (rec.count > maxReqs) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Please try again shortly.' });
  }
  return next();
}

// Health & voice engine mode endpoint (never exposes secrets)
app.get('/api/health', (_req, res) => {
  const cfg = getGnaniConfig();
  const sb = getSupabaseServerStatus();
  const pgStatus = getPostgresStatus();
  const prismaStatus = getPrismaStatus();
  res.json({
    status: 'ok',
    app: 'Voice Khata',
    mode: cfg.isLive ? 'gnani' : 'browser-fallback',
    sttMode: cfg.sttConfigured ? 'gnani-prisma' : 'web-speech',
    ttsMode: cfg.ttsConfigured ? 'gnani-timbre' : 'speech-synthesis',
    gnaniConfigured: cfg.isLive,
    supabaseConfigured: sb.configured,
    supabaseJwksConfigured: sb.jwksConfigured,
    supabaseSecretConfigured: sb.secretConfigured,
    postgresConfigured: pgStatus.configured,
    prismaConfigured: prismaStatus.configured,
    timestamp: new Date().toISOString(),
  });
});

// Public Supabase client config (publishable/anon key only, never SUPABASE_SECRET_KEY)
app.get('/api/auth-config', (_req, res) => {
  res.json(getSupabasePublicConfig());
});

// Verified current user endpoint powered by @supabase/server (JWKS JWT verification)
app.get('/api/auth/me', requireSupabaseAuth({ auth: 'user' }), (req, res) => {
  res.json({
    ok: true,
    authMode: req.supabaseAuth.authMode,
    user: req.supabaseAuth.userClaims,
  });
});

// Serve @supabase/supabase-js browser bundle directly from installed package
app.get('/vendor/supabase.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(supabaseUmdPath);
});

// Short-utterance REST STT proxy (audio stays strictly in memory, never saved or logged)
app.post('/api/stt', voiceRateLimit, async (req, res) => {
  const cfg = getGnaniConfig();
  const language = String(req.body?.language || cfg.sttLang || 'en-IN').slice(0, 16);

  if (!cfg.sttConfigured) {
    return res.json({
      ok: true,
      mode: 'browser-fallback',
      transcript: null,
      language,
      reason: 'Gnani Prisma credentials not configured — using Browser Voice Mode',
    });
  }

  const httpSttUrl = (process.env.GNANI_PRISMA_HTTP_URL || '').trim();
  if (!httpSttUrl) {
    return res.json({
      ok: true,
      mode: 'browser-fallback',
      transcript: null,
      language,
      reason: 'Streaming WS active; HTTP STT fallback',
    });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(httpSttUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        'x-api-key': cfg.apiKey,
      },
      signal: controller.signal,
      body: JSON.stringify({
        audio: req.body?.audioBase64 || '',
        language,
        sample_rate: 16000,
      }),
    });
    clearTimeout(timer);

    if (!response.ok) {
      return res.json({ ok: true, mode: 'browser-fallback', transcript: null });
    }
    const data = await response.json();
    return res.json({
      ok: true,
      mode: 'gnani',
      transcript: data.transcript || data.text || '',
    });
  } catch {
    return res.json({ ok: true, mode: 'browser-fallback', transcript: null });
  }
});

// Timbre TTS proxy endpoint
app.post('/api/tts', voiceRateLimit, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) {
    return res.status(400).json({ ok: false, error: 'Text is required for speech synthesis.' });
  }
  if (text.length > 400) {
    return res.status(400).json({ ok: false, error: 'Spoken replies must stay concise (<= 400 chars).' });
  }

  const result = await synthesizeWithTimbre(text, {
    voice: req.body?.voice,
    language: req.body?.language,
  });

  return res.json(result);
});

// Dynamic theme-aware PWA Manifest
function sendManifest(req, res) {
  const isDark = req.query.theme === 'dark';
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    name: 'Voice Khata — Voice Credit Book',
    short_name: 'Voice Khata',
    description: 'Speak. Your khata updates itself. Private, offline-ready voice credit book for Indian businesses.',
    start_url: '/app?source=pwa',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: isDark ? '#0B1120' : '#FAF8F5',
    theme_color: isDark ? '#0B1120' : '#131D33',
    categories: ['finance', 'business', 'productivity'],
    icons: [
      { src: '/icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any maskable' },
      { src: '/icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
    ],
  });
}

app.get('/manifest.webmanifest', sendManifest);
app.get('/manifest.json', sendManifest);

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\nDisallow: /api/\n');
});

app.get('/sitemap.xml', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const urls = ['/', '/app', '/privacy', '/terms', '/contact']
    .map((p) => `<url><loc>${origin}${p}</loc></url>`)
    .join('');
  res
    .type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
});

app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'sw.js'));
});

// Dedicated product routes
app.get(['/app', '/app/*'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'app.html'));
});

app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(publicDir, 'privacy.html'));
});

app.get('/terms', (_req, res) => {
  res.sendFile(path.join(publicDir, 'terms.html'));
});

app.get('/contact', (_req, res) => {
  res.sendFile(path.join(publicDir, 'contact.html'));
});

// Unknown /api/* endpoints return JSON 404
app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: 'Endpoint not found.' });
});

// Serve static PWA files
app.use(
  express.static(publicDir, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html') || filePath.endsWith('.json')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// Fallback for unknown web routes -> landing page
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = http.createServer(app);

// WebSocket relay for 16 kHz mono PCM streaming to Gnani Prisma STT
const wss = new WebSocketServer({ server, path: '/ws/stt' });
wss.on('connection', (ws) => {
  attachPrismaRelay(ws);
});

function getLocalLanIps() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const net of list) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

server.listen(PORT, HOST, () => {
  const cfg = getGnaniConfig();
  const sb = getSupabaseServerStatus();
  const pgStatus = getPostgresStatus();
  const lanIps = getLocalLanIps();
  const modeLabel = cfg.isLive
    ? 'Gnani Live (Prisma STT + Timbre TTS)'
    : 'Browser Voice Mode (Web Speech API)';
  const authLabel = sb.configured
    ? `Supabase Live (${sb.url})${sb.jwksConfigured ? ' [JWKS]' : ''}`
    : 'Local Vault Auth';
  const dbLabel = pgStatus.configured
    ? `PostgreSQL (${pgStatus.host}:${pgStatus.port}/${pgStatus.database})`
    : 'On-Device AES-GCM Vault (set SUPABASE_DB_URL for Postgres)';

  const lines = [
    '',
    '  Voice Khata server ready',
    `  Web:            http://localhost:${PORT}`,
    `  App:            http://localhost:${PORT}/app`,
    ...lanIps.map((ip) => `  Phone / Tablet: http://${ip}:${PORT}`),
    `  Voice Engine:   ${modeLabel}`,
    `  Auth Provider:  ${authLabel}`,
    `  Database:       ${dbLabel}`,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    Promise.allSettled([closePostgresPool(), disconnectPrisma()]).finally(() => process.exit(0));
  });
}

export { app, server };
