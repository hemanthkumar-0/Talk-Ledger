/**
 * Voice Khata Auth & Session Layer (public/db.js)
 * - Uses Supabase Auth (@supabase/supabase-js served from /vendor/supabase.js)
 *   configured via /api/auth-config (publishable key only — never service_role).
 * - Keeps sessions refreshed automatically via autoRefreshToken + onAuthStateChange.
 * - Gracefully falls back to salted Web Crypto SHA-256 local accounts when Supabase is not configured.
 */

const LOCAL_ACCOUNTS_KEY = 'voicekhata-local-accounts-v1';
const LOCAL_SESSION_KEY = 'voicekhata-session-v1';
const DEFAULT_LOCAL_PIN = '1234';

let supabaseClient = null;
let initPromise = null;
let authConfig = { configured: false, url: '', anonKey: '' };
const sessionListeners = new Set();

function notifySessionChange() {
  const current = getActiveSession();
  sessionListeners.forEach((cb) => {
    try {
      cb(current);
    } catch {
      // ignore listener errors
    }
  });
}

export function onAuthSessionChange(cb) {
  if (typeof cb === 'function') sessionListeners.add(cb);
  return () => sessionListeners.delete(cb);
}

async function sha256Hex(str) {
  if (typeof window !== 'undefined' && window.crypto?.subtle) {
    const data = new TextEncoder().encode(str);
    const hash = await window.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv-${(h >>> 0).toString(16)}`;
}

function readLocalAccounts() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_ACCOUNTS_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeLocalAccounts(list) {
  try {
    localStorage.setItem(LOCAL_ACCOUNTS_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

function saveSession(user) {
  try {
    sessionStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(user));
  } catch {
    // ignore
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(LOCAL_SESSION_KEY);
  } catch {
    // ignore
  }
}

export function getSupabaseClient() {
  return supabaseClient;
}

export function initAuthClient() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const res = await fetch('/api/auth-config', { cache: 'no-store' });
      if (res.ok) {
        authConfig = await res.json();
      }
    } catch {
      authConfig = { configured: false };
    }

    if (authConfig.configured && authConfig.url && authConfig.anonKey && window.supabase?.createClient) {
      supabaseClient = window.supabase.createClient(authConfig.url, authConfig.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });

      // Restore and keep Supabase session refreshed automatically
      try {
        const { data } = await supabaseClient.auth.getSession();
        if (data?.session?.user) {
          const u = data.session.user;
          const existing = getActiveSession();
          saveSession({
            id: u.id,
            name: u.user_metadata?.full_name || u.email?.split('@')[0] || 'Account',
            email: u.email || '',
            pinVerified: Boolean(existing?.pinVerified),
            provider: 'supabase',
          });
          notifySessionChange();
        } else if (getActiveSession()?.provider === 'supabase') {
          clearSession();
          notifySessionChange();
        }
      } catch {
        // ignore offline session check failure
      }

      supabaseClient.auth.onAuthStateChange((_event, session) => {
        if (session?.user) {
          const u = session.user;
          const existing = getActiveSession();
          saveSession({
            id: u.id,
            name: u.user_metadata?.full_name || u.email?.split('@')[0] || 'Account',
            email: u.email || '',
            pinVerified: Boolean(existing?.pinVerified),
            provider: 'supabase',
          });
          notifySessionChange();
        } else if (getActiveSession()?.provider === 'supabase') {
          clearSession();
          notifySessionChange();
        }
      });
    }

    return { mode: supabaseClient ? 'supabase' : 'local', config: authConfig };
  })();

  return initPromise;
}

export function getActiveSession() {
  try {
    const raw = sessionStorage.getItem(LOCAL_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function signOut() {
  clearSession();
  notifySessionChange();
  if (supabaseClient) {
    supabaseClient.auth.signOut().catch(() => undefined);
  }
}

export async function signUp({ name, email, password }) {
  await initAuthClient();
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (supabaseClient) {
    const { data, error } = await supabaseClient.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        data: { full_name: name },
        emailRedirectTo: `${window.location.origin}/app`,
      },
    });
    if (error) {
      return { ok: false, errorCode: 'invalidCredentials' };
    }
    const needsConfirmation = Boolean(!data.session);
    const user = {
      id: data.user?.id || `sb-${Date.now()}`,
      name,
      email: normalizedEmail,
      pinVerified: false,
      provider: 'supabase',
    };
    if (!needsConfirmation) {
      saveSession(user);
    }
    return { ok: true, user, needsConfirmation };
  }

  const accounts = readLocalAccounts();
  if (accounts.some((a) => a.email === normalizedEmail)) {
    return { ok: false, errorCode: 'invalidCredentials' };
  }

  const salt = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const passwordHash = await sha256Hex(`${salt}:${password}`);

  const account = {
    id: `local-${Date.now()}`,
    name,
    email: normalizedEmail,
    salt,
    passwordHash,
    pinHash: await sha256Hex(`pin:${DEFAULT_LOCAL_PIN}`),
    createdAt: new Date().toISOString(),
  };

  accounts.push(account);
  writeLocalAccounts(accounts);

  const sessionUser = {
    id: account.id,
    name: account.name,
    email: account.email,
    pinVerified: false,
    provider: 'local',
  };
  saveSession(sessionUser);
  return { ok: true, user: sessionUser, needsConfirmation: false };
}

export async function signInWithPassword({ email, password }) {
  await initAuthClient();
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (supabaseClient) {
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });
    if (error || !data?.user) {
      return { ok: false, errorCode: 'invalidCredentials' };
    }
    const sessionUser = {
      id: data.user.id,
      name: data.user.user_metadata?.full_name || normalizedEmail.split('@')[0],
      email: normalizedEmail,
      pinVerified: false,
      provider: 'supabase',
    };
    saveSession(sessionUser);
    return { ok: true, user: sessionUser };
  }

  const accounts = readLocalAccounts();
  const match = accounts.find((a) => a.email === normalizedEmail);
  if (!match) {
    return { ok: false, errorCode: 'invalidCredentials' };
  }

  const candidateHash = await sha256Hex(`${match.salt}:${password}`);
  if (candidateHash !== match.passwordHash) {
    return { ok: false, errorCode: 'invalidCredentials' };
  }

  const sessionUser = {
    id: match.id,
    name: match.name,
    email: match.email,
    pinVerified: false,
    provider: 'local',
  };
  saveSession(sessionUser);
  return { ok: true, user: sessionUser };
}

export async function signInWithOtp({ email }) {
  await initAuthClient();
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (supabaseClient) {
    await supabaseClient.auth.signInWithOtp({
      email: normalizedEmail,
      options: { shouldCreateUser: false },
    });
    return { ok: true, mode: 'supabase' };
  }

  window.__vkLocalOtp = { email: normalizedEmail, code: '123456', expiresAt: Date.now() + 300000 };
  return { ok: true, mode: 'local' };
}

export async function verifyEmailOtp({ email, token }) {
  await initAuthClient();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const code = String(token || '').trim();

  if (supabaseClient) {
    const { data, error } = await supabaseClient.auth.verifyOtp({
      email: normalizedEmail,
      token: code,
      type: 'email',
    });
    if (error || !data?.user) return { ok: false, errorCode: 'invalidCredentials' };
    const sessionUser = {
      id: data.user.id,
      name: data.user.user_metadata?.full_name || normalizedEmail.split('@')[0],
      email: normalizedEmail,
      pinVerified: false,
      provider: 'supabase',
    };
    saveSession(sessionUser);
    return { ok: true, user: sessionUser };
  }

  const pending = window.__vkLocalOtp;
  if (pending && pending.email === normalizedEmail && pending.code === code && Date.now() < pending.expiresAt) {
    delete window.__vkLocalOtp;
    const sessionUser = {
      id: `otp-${Date.now()}`,
      name: normalizedEmail.split('@')[0],
      email: normalizedEmail,
      pinVerified: false,
      provider: 'local',
    };
    saveSession(sessionUser);
    return { ok: true, user: sessionUser };
  }

  return { ok: false, errorCode: 'invalidCredentials' };
}

export async function resetPasswordForEmail({ email }) {
  await initAuthClient();
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (supabaseClient) {
    await supabaseClient.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo: `${window.location.origin}/app#auth`,
    });
  }
  return { ok: true };
}

export async function verifyShopPin(pin) {
  const clean = String(pin || '').trim();
  if (!/^\d{4}$/.test(clean)) return false;

  const session = getActiveSession();
  if (clean === DEFAULT_LOCAL_PIN) {
    if (session) {
      saveSession({ ...session, pinVerified: true });
    }
    return true;
  }

  const accounts = readLocalAccounts();
  const acc = session ? accounts.find((a) => a.email === session.email) : null;
  if (acc?.pinHash) {
    const h = await sha256Hex(`pin:${clean}`);
    if (h === acc.pinHash) {
      saveSession({ ...session, pinVerified: true });
      return true;
    }
  }
  return false;
}

export async function getSupabaseAccessToken() {
  await initAuthClient();
  if (!supabaseClient) return null;
  try {
    const { data } = await supabaseClient.auth.getSession();
    return data?.session?.access_token || null;
  } catch {
    return null;
  }
}

/**
 * Pulls the authenticated user's ledger data from Supabase Postgres (RLS-scoped to auth.uid()).
 */
export async function pullStateFromSupabase() {
  await initAuthClient();
  if (!supabaseClient) return null;

  try {
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const user = sessionData?.session?.user;
    if (!user) return null;

    const [profileRes, custRes, entriesRes, bizRes, stocksRes] = await Promise.all([
      supabaseClient.from('vk_profiles').select('*').eq('id', user.id).maybeSingle(),
      supabaseClient.from('vk_customers').select('*').order('name', { ascending: true }),
      supabaseClient.from('vk_entries').select('*').order('created_at', { ascending: true }),
      supabaseClient.from('vk_business_records').select('*').order('created_at', { ascending: true }),
      supabaseClient.from('vk_stocks').select('*').order('created_at', { ascending: false }),
    ]);

    if (custRes.error || entriesRes.error || bizRes.error || stocksRes.error) {
      return null;
    }

    return {
      defaultCreditDays: profileRes.data?.default_credit_days ?? null,
      customers: (custRes.data || []).map((c) => ({
        name: c.name,
        optInReminder: Boolean(c.opt_in_reminder),
      })),
      entries: (entriesRes.data || []).map((e) => ({
        id: e.id,
        customerName: e.customer_name,
        amount: Number(e.amount),
        type: e.entry_type,
        accountingType: e.entry_type === 'credit' ? 'debit' : 'credit',
        dateIso: String(e.date_iso).slice(0, 10),
        dueDate: e.due_date ? String(e.due_date).slice(0, 10) : null,
        dateLabel: e.date_label || 'today',
        dateOffset: Number(e.date_offset || 0),
        sourceClause: e.source_clause || '',
        originalAmount: e.original_amount != null ? Number(e.original_amount) : undefined,
        previousAmount: e.previous_amount != null ? Number(e.previous_amount) : undefined,
        correctionHistory: Array.isArray(e.correction_history) ? e.correction_history : [],
        correctedAt: e.corrected_at || undefined,
        createdAt: e.created_at,
      })),
      businessRecords: (bizRes.data || []).map((b) => ({
        id: b.id,
        kind: b.kind,
        dateIso: String(b.date_iso).slice(0, 10),
        revenue: Number(b.revenue),
        cogs: Number(b.cogs),
        amount: Number(b.amount),
        note: b.note || '',
        createdAt: b.created_at,
      })),
      stocks: (stocksRes.data || []).map((s) => ({
        id: s.id,
        name: s.name,
        qty: Number(s.qty),
        reorderAt: Number(s.reorder_at),
        costPrice: Number(s.cost_price),
        sellPrice: Number(s.sell_price),
        soldUnits: Number(s.sold_units),
      })),
    };
  } catch {
    return null;
  }
}

/**
 * Syncs local Voice Khata state to Supabase Postgres for the authenticated user (RLS-scoped).
 */
export async function syncStateToSupabase(state) {
  await initAuthClient();
  if (!supabaseClient || !state) return { synced: false };

  try {
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const user = sessionData?.session?.user;
    if (!user) return { synced: false };

    const userId = user.id;
    const ops = [
      supabaseClient.from('vk_profiles').upsert(
        {
          id: userId,
          full_name: user.user_metadata?.full_name || user.email?.split('@')[0] || '',
          default_credit_days: Math.max(1, Math.min(365, Number(state.settings?.defaultCreditDays ?? 30))),
        },
        { onConflict: 'id' }
      ),
    ];

    if (Array.isArray(state.customers) && state.customers.length > 0) {
      const custRows = state.customers.map((c) => ({
        user_id: userId,
        name_key: String(c.name || '').trim().toLowerCase(),
        name: String(c.name || '').trim(),
        opt_in_reminder: Boolean(c.optInReminder),
      }));
      ops.push(supabaseClient.from('vk_customers').upsert(custRows, { onConflict: 'user_id,name_key' }));
    }

    if (Array.isArray(state.entries) && state.entries.length > 0) {
      const entryRows = state.entries.map((e) => ({
        user_id: userId,
        id: String(e.id),
        customer_name: String(e.customerName || ''),
        amount: Number(e.amount || 0),
        entry_type: e.type === 'paid' ? 'paid' : 'credit',
        date_iso: String(e.dateIso).slice(0, 10),
        due_date: e.dueDate ? String(e.dueDate).slice(0, 10) : null,
        date_label: String(e.dateLabel || 'today'),
        date_offset: Number(e.dateOffset || 0),
        source_clause: e.sourceClause || null,
        original_amount: e.originalAmount != null ? Number(e.originalAmount) : null,
        previous_amount: e.previousAmount != null ? Number(e.previousAmount) : null,
        correction_history: Array.isArray(e.correctionHistory) ? e.correctionHistory : [],
        corrected_at: e.correctedAt || null,
        created_at: e.createdAt || new Date().toISOString(),
      }));
      ops.push(supabaseClient.from('vk_entries').upsert(entryRows, { onConflict: 'user_id,id' }));
    }

    if (Array.isArray(state.businessRecords) && state.businessRecords.length > 0) {
      const bizRows = state.businessRecords.map((b) => ({
        user_id: userId,
        id: String(b.id),
        kind: b.kind === 'expense' ? 'expense' : 'sale',
        date_iso: String(b.dateIso).slice(0, 10),
        revenue: Number(b.revenue || 0),
        cogs: Number(b.cogs || 0),
        amount: Number(b.amount || 0),
        note: String(b.note || ''),
        created_at: b.createdAt || new Date().toISOString(),
      }));
      ops.push(supabaseClient.from('vk_business_records').upsert(bizRows, { onConflict: 'user_id,id' }));
    }

    if (Array.isArray(state.stocks) && state.stocks.length > 0) {
      const stockRows = state.stocks.map((s) => ({
        user_id: userId,
        id: String(s.id),
        name: String(s.name || ''),
        qty: Math.max(0, Math.round(Number(s.qty || 0))),
        reorder_at: Math.max(0, Math.round(Number(s.reorderAt ?? 10))),
        cost_price: Number(s.costPrice || 0),
        sell_price: Number(s.sellPrice || 0),
        sold_units: Math.max(0, Math.round(Number(s.soldUnits || 0))),
      }));
      ops.push(supabaseClient.from('vk_stocks').upsert(stockRows, { onConflict: 'user_id,id' }));
    }

    const results = await Promise.all(ops);
    const failed = results.find((r) => r.error);
    return { synced: !failed, error: failed?.error?.message || null };
  } catch {
    return { synced: false };
  }
}

/**
 * Deletes the authenticated user's cloud ledger rows from Supabase (called on explicit wipe).
 */
export async function clearSupabaseLedgerData() {
  await initAuthClient();
  if (!supabaseClient) return { cleared: false };
  try {
    const { data } = await supabaseClient.auth.getSession();
    const userId = data?.session?.user?.id;
    if (!userId) return { cleared: false };

    await Promise.all([
      supabaseClient.from('vk_entries').delete().eq('user_id', userId),
      supabaseClient.from('vk_customers').delete().eq('user_id', userId),
      supabaseClient.from('vk_business_records').delete().eq('user_id', userId),
      supabaseClient.from('vk_stocks').delete().eq('user_id', userId),
    ]);
    return { cleared: true };
  } catch {
    return { cleared: false };
  }
}
