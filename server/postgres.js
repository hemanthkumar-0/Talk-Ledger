import pg from 'pg';

const { Pool } = pg;

const ALLOWED_RLS_ROLES = new Set(['authenticated', 'anon']);

function isPlaceholderConnectionString(raw) {
  const s = String(raw || '').trim();
  if (!s) return true;
  if (s.includes('[YOUR-DATABASE-PASSWORD]') || s.includes('[YOUR-PASSWORD]')) return true;
  if (s.includes('<project-ref>') || s.includes('••••')) return true;
  return false;
}

/**
 * Resolves and validates the server-side Postgres connection string from env.
 * Never returns the password or full URI in status objects.
 */
export function getPostgresStatus() {
  const raw = (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '').trim();
  if (isPlaceholderConnectionString(raw)) {
    return {
      configured: false,
      host: '',
      port: null,
      database: '',
      ssl: true,
    };
  }

  try {
    const parsed = new URL(raw);
    const isPgProtocol = parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:';
    const hasPassword = Boolean(parsed.password);
    if (!isPgProtocol || !parsed.hostname || !hasPassword) {
      return { configured: false, host: '', port: null, database: '', ssl: true };
    }
    const isLocal =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1';

    return {
      configured: true,
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      database: parsed.pathname.replace(/^\//, '') || 'postgres',
      ssl: !isLocal,
    };
  } catch {
    return { configured: false, host: '', port: null, database: '', ssl: true };
  }
}

let sharedPool = null;

/**
 * Lazily creates a bounded PostgreSQL connection pool (max 4 connections).
 */
export function getPostgresPool() {
  if (sharedPool) return sharedPool;

  const status = getPostgresStatus();
  if (!status.configured) {
    throw new Error(
      'SUPABASE_DB_URL is not configured with a valid password. Set it in .env.local (percent-encoding special characters).'
    );
  }

  const connectionString = (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '').trim();
  sharedPool = new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: 'voice-khata',
    ssl: status.ssl ? { rejectUnauthorized: false } : false,
  });

  sharedPool.on('error', () => {
    // Discard errored idle clients cleanly without crashing the server
  });

  return sharedPool;
}

/**
 * Executes a parameterized SQL query inside a transaction scoped to the caller's
 * verified JWT claims and Postgres role (`authenticated` or `anon`) so RLS enforces.
 */
export async function queryWithUserRls(jwtClaims, sqlText, params = []) {
  const role = jwtClaims?.role || 'anon';
  if (!ALLOWED_RLS_ROLES.has(role)) {
    const err = new Error(`Unsupported Postgres RLS role: ${role}`);
    err.code = 'UNSUPPORTED_ROLE';
    throw err;
  }

  const pool = getPostgresPool();
  const client = await pool.connect();
  let broken = false;

  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(jwtClaims || {}),
    ]);
    await client.query(`SET LOCAL ROLE ${role === 'authenticated' ? '"authenticated"' : '"anon"'}`);
    const result = await client.query(sqlText, params);
    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

/**
 * Gracefully drains the Postgres pool on server shutdown.
 */
export async function closePostgresPool() {
  if (!sharedPool) return;
  const pool = sharedPool;
  sharedPool = null;
  await pool.end().catch(() => undefined);
}
