import WebSocket from 'ws';

/**
 * Gnani Voice API Connector (Prisma STT WebSocket + Timbre TTS REST)
 * Keeps all credentials strictly server-side and supports seamless fallback
 * when credentials are absent or upstream services are unreachable.
 */
export function getGnaniConfig() {
  const apiKey = (process.env.GNANI_API_KEY || '').trim();
  const accessKey = (process.env.GNANI_ACCESS_KEY || '').trim();
  const prismaWsUrl = (process.env.GNANI_PRISMA_WS_URL || '').trim();
  const timbreTtsUrl = (process.env.GNANI_TIMBRE_TTS_URL || '').trim();
  const ttsVoice = (process.env.GNANI_TTS_VOICE || 'en-IN-female-1').trim();
  const sttLang = (process.env.GNANI_STT_LANG || 'en-IN').trim();

  const sttConfigured = Boolean(apiKey && prismaWsUrl);
  const ttsConfigured = Boolean(apiKey && timbreTtsUrl);

  return {
    apiKey,
    accessKey,
    prismaWsUrl,
    timbreTtsUrl,
    ttsVoice,
    sttLang,
    sttConfigured,
    ttsConfigured,
    isLive: sttConfigured || ttsConfigured,
  };
}

/**
 * Synthesizes a concise 1-sentence spoken reply using Gnani Timbre TTS.
 * Returns { ok, mode, mimeType, audioBase64, latencyMs, reason }.
 */
export async function synthesizeWithTimbre(text, options = {}) {
  const cfg = getGnaniConfig();
  const startedAt = Date.now();

  if (!cfg.ttsConfigured) {
    return {
      ok: true,
      mode: 'browser-fallback',
      audioBase64: null,
      mimeType: null,
      latencyMs: Date.now() - startedAt,
      reason: 'Gnani Timbre credentials not configured',
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      'x-api-key': cfg.apiKey,
    };
    if (cfg.accessKey) {
      headers['x-access-key'] = cfg.accessKey;
    }

    const response = await fetch(cfg.timbreTtsUrl, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        text,
        voice: options.voice || cfg.ttsVoice,
        language: options.language || cfg.sttLang,
        format: 'mp3',
        sample_rate: 16000,
      }),
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        ok: true,
        mode: 'browser-fallback',
        audioBase64: null,
        mimeType: null,
        latencyMs: Date.now() - startedAt,
        reason: `Gnani Timbre responded with HTTP ${response.status}`,
      };
    }

    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      const base64 = payload.audio || payload.audioContent || payload.data || null;
      if (!base64) {
        return {
          ok: true,
          mode: 'browser-fallback',
          audioBase64: null,
          mimeType: null,
          latencyMs: Date.now() - startedAt,
          reason: 'Empty audio payload from Gnani Timbre',
        };
      }
      return {
        ok: true,
        mode: 'gnani',
        audioBase64: base64,
        mimeType: payload.mimeType || 'audio/mpeg',
        latencyMs: Date.now() - startedAt,
      };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      ok: true,
      mode: 'gnani',
      audioBase64: buffer.toString('base64'),
      mimeType: contentType.split(';')[0],
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: true,
      mode: 'browser-fallback',
      audioBase64: null,
      mimeType: null,
      latencyMs: Date.now() - startedAt,
      reason: err.name === 'AbortError' ? 'Gnani Timbre timeout' : err.message,
    };
  }
}

/**
 * Creates a bidirectional WebSocket bridge between a browser client
 * streaming 16 kHz mono Int16 PCM frames and Gnani Prisma STT.
 */
export function attachPrismaRelay(clientWs) {
  const cfg = getGnaniConfig();

  const sendJson = (payload) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(payload));
    }
  };

  if (!cfg.sttConfigured) {
    sendJson({
      type: 'ready',
      mode: 'browser-fallback',
      message: 'Gnani Prisma credentials not set. Using on-device Browser Voice Mode.',
    });

    clientWs.on('message', (raw, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') {
          sendJson({ type: 'pong', ts: Date.now() });
        }
      } catch {
        // ignore malformed control packets
      }
    });
    return;
  }

  let upstreamWs = null;
  let sessionStartedAt = Date.now();
  let chunkCount = 0;

  const openUpstream = (meta = {}) => {
    sessionStartedAt = Date.now();
    chunkCount = 0;

    const headers = {
      Authorization: `Bearer ${cfg.apiKey}`,
      'x-api-key': cfg.apiKey,
      'x-audio-format': 'pcm16',
      'x-sample-rate': String(meta.sampleRate || 16000),
      'x-language': meta.language || cfg.sttLang,
    };
    if (cfg.accessKey) {
      headers['x-access-key'] = cfg.accessKey;
    }

    try {
      upstreamWs = new WebSocket(cfg.prismaWsUrl, { headers, handshakeTimeout: 5000 });
    } catch (err) {
      sendJson({
        type: 'fallback',
        mode: 'browser-fallback',
        reason: `Could not open Gnani Prisma relay: ${err.message}`,
      });
      return;
    }

    upstreamWs.on('open', () => {
      sendJson({
        type: 'upstream_ready',
        mode: 'gnani',
        proxyMs: Date.now() - sessionStartedAt,
      });
      upstreamWs.send(
        JSON.stringify({
          event: 'start',
          config: {
            encoding: 'LINEAR16',
            sampleRateHertz: meta.sampleRate || 16000,
            channels: 1,
            languageCode: meta.language || cfg.sttLang,
            interimResults: true,
          },
        })
      );
    });

    upstreamWs.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        const transcript =
          parsed.transcript ||
          parsed.text ||
          parsed.alternatives?.[0]?.transcript ||
          '';
        const isFinal = Boolean(parsed.isFinal ?? parsed.is_final ?? parsed.final);

        if (transcript) {
          sendJson({
            type: isFinal ? 'final' : 'partial',
            transcript,
            confidence: parsed.confidence ?? 0.95,
            sttMs: Date.now() - sessionStartedAt,
            chunks: chunkCount,
          });
        }
      } catch {
        // non-JSON upstream frame
      }
    });

    upstreamWs.on('error', (err) => {
      sendJson({
        type: 'fallback',
        mode: 'browser-fallback',
        reason: `Gnani Prisma relay error: ${err.message}`,
      });
    });

    upstreamWs.on('close', () => {
      upstreamWs = null;
    });
  };

  sendJson({
    type: 'ready',
    mode: 'gnani',
    message: 'Connected to TalkLedger Gnani Prisma proxy.',
  });

  clientWs.on('message', (data, isBinary) => {
    if (isBinary) {
      chunkCount += 1;
      if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.send(data);
      }
      return;
    }

    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'start') {
        openUpstream(msg);
      } else if (msg.type === 'stop') {
        if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.send(JSON.stringify({ event: 'stop' }));
        }
      } else if (msg.type === 'ping') {
        sendJson({ type: 'pong', ts: Date.now() });
      }
    } catch {
      // ignore invalid JSON
    }
  });

  clientWs.on('close', () => {
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.close();
    }
    upstreamWs = null;
  });
}
