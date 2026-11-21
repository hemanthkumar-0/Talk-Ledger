import {
  createAdminClient,
  createContextClient,
  resolveEnv,
  verifyCredentials,
} from '@supabase/server/core';
import { createClient } from '@supabase/supabase-js';

function isUsableSecret(value) {
  const v = String(value || '').trim();
  return Boolean(v && !v.includes('•') && !v.includes('...'));
}

/**
 * Public Supabase client config for browser auth (/api/auth-config).
 * Exposes ONLY the project URL and publishable/anon key — never SUPABASE_SECRET_KEY.
 */
export function getSupabasePublicConfig() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const key = (
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    ''
  ).trim();

  return {
    configured: Boolean(url && key),
    url: url && key ? url : '',
    anonKey: url && key ? key : '',
  };
}

/**
 * Non-secret backend status snapshot resolved via @supabase/server/core.
 */
export function getSupabaseServerStatus() {
  const pub = getSupabasePublicConfig();
  const { data: env, error } = resolveEnv();
  const hasSecret =
    Boolean(env?.secretKeys && Object.values(env.secretKeys).some((k) => isUsableSecret(k)));

  return {
    configured: pub.configured,
    url: pub.url,
    serverEnvReady: Boolean(!error && env?.url),
    jwksConfigured: Boolean(env?.jwks),
    secretConfigured: hasSecret,
  };
}

/**
 * Extracts Bearer JWT and apikey headers from an Express request.
 */
export function extractExpressCredentials(req) {
  const authHeader = String(req.headers?.authorization || '').trim();
  const token = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim() || null
    : null;
  const apikeyHeader = req.headers?.apikey;
  const apikey = typeof apikeyHeader === 'string' && apikeyHeader.trim() ? apikeyHeader.trim() : null;
  return { token, apikey };
}

/**
 * Verifies an Express request using @supabase/server/core JWKS / key verification.
 */
export async function verifyExpressRequest(req, options = { auth: 'user' }) {
  const credentials = extractExpressCredentials(req);
  return verifyCredentials(credentials, options);
}

/**
 * Creates an RLS-scoped Supabase client for an authenticated user (or anon when token omitted).
 */
export function createUserSupabaseClient(token, keyName) {
  if (token) {
    return createContextClient({ auth: { token, keyName } });
  }
  return createContextClient();
}

/**
 * Creates a server-only admin Supabase client (bypasses RLS). Requires an unmasked SUPABASE_SECRET_KEY.
 */
export function createAdminSupabaseClient(keyName) {
  const { secretConfigured } = getSupabaseServerStatus();
  if (!secretConfigured) {
    throw new Error('SUPABASE_SECRET_KEY is not configured with a valid unmasked secret key.');
  }
  return keyName ? createAdminClient({ auth: { keyName } }) : createAdminClient();
}

/**
 * Express middleware powered by @supabase/server/core.
 * Verifies caller JWT/API keys and attaches `req.supabaseAuth` and RLS-scoped `req.supabase`.
 */
export function requireSupabaseAuth(options = { auth: 'user' }) {
  return async (req, res, next) => {
    const { data: auth, error } = await verifyExpressRequest(req, options);
    if (error) {
      return res.status(error.status || 401).json({
        ok: false,
        code: error.code || 'UNAUTHORIZED',
        error: error.message || 'Authentication required.',
      });
    }

    req.supabaseAuth = auth;
    try {
      req.supabase = createUserSupabaseClient(auth.token, auth.keyName);
    } catch {
      req.supabase = null;
    }
    return next();
  };
}

let cachedAnonClient = null;

/**
 * Legacy helper returning a stateless server-side publishable client.
 */
export function getServerSupabaseClient() {
  if (cachedAnonClient) return cachedAnonClient;
  const { configured, url, anonKey } = getSupabasePublicConfig();
  if (!configured) return null;

  cachedAnonClient = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return cachedAnonClient;
}
