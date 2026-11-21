/**
 * TalkLedger Theme Controller (Light / Dark / System + Scrolltide #c-lather Soap-Bubble Switch)
 * - Follows prefers-color-scheme live when set to "system" (default)
 * - Persists user choice in localStorage
 * - Updates <meta name="theme-color"> and dynamic PWA <link rel="manifest">
 * - Triggers an iridescent soap-bubble flood transition (respecting prefers-reduced-motion)
 */

const STORAGE_KEY = 'talkledger-theme';
const THEME_COLORS = {
  light: '#FAF8F5',
  dark: '#0B1120',
};

const mediaQuery =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

const listeners = new Set();

export function getSavedThemeMode() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    // ignore
  }
  return 'system';
}

export function resolveTheme(mode = getSavedThemeMode()) {
  if (mode === 'dark' || mode === 'light') return mode;
  return mediaQuery && mediaQuery.matches ? 'dark' : 'light';
}

function updateThemeColorAndManifest(resolved) {
  const color = THEME_COLORS[resolved] || THEME_COLORS.light;

  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', color);

  const manifestLink = document.querySelector('link[rel="manifest"]');
  if (manifestLink) {
    const nextHref = `/manifest.webmanifest?theme=${resolved}`;
    if (manifestLink.getAttribute('href') !== nextHref) {
      manifestLink.setAttribute('href', nextHref);
    }
  }
}

function triggerLatherFlood(originEl, nextResolved) {
  const prefersReduced =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced || !originEl) return;

  const rect = originEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const ripple = document.createElement('div');
  ripple.className = `lather-flood lather-flood--${nextResolved}`;
  ripple.style.setProperty('--cx', `${cx}px`);
  ripple.style.setProperty('--cy', `${cy}px`);
  ripple.setAttribute('aria-hidden', 'true');
  document.body.appendChild(ripple);

  window.requestAnimationFrame(() => ripple.classList.add('is-expanding'));
  setTimeout(() => ripple.remove(), 580);
}

export function applyThemeMode(mode = getSavedThemeMode(), options = {}) {
  const cleanMode = mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'system';
  const prevResolved = document.documentElement.dataset.theme || resolveTheme();
  const nextResolved = resolveTheme(cleanMode);

  try {
    localStorage.setItem(STORAGE_KEY, cleanMode);
  } catch {
    // ignore
  }

  if (options.animate && prevResolved !== nextResolved) {
    triggerLatherFlood(options.originEl, nextResolved);
  }

  document.documentElement.dataset.theme = nextResolved;
  document.documentElement.dataset.themeMode = cleanMode;
  document.documentElement.style.colorScheme = nextResolved;

  updateThemeColorAndManifest(nextResolved);
  syncThemeControls(cleanMode, nextResolved);

  window.dispatchEvent(
    new CustomEvent('talkledger:themechange', {
      detail: { mode: cleanMode, resolved: nextResolved },
    })
  );

  listeners.forEach((fn) => fn({ mode: cleanMode, resolved: nextResolved }));
  return { mode: cleanMode, resolved: nextResolved };
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function syncThemeControls(mode, resolved) {
  const isDark = resolved === 'dark';

  document.querySelectorAll('.lather-toggle-btn').forEach((btn) => {
    btn.classList.toggle('is-dark', isDark);
    btn.setAttribute('aria-pressed', String(isDark));
  });

  document.querySelectorAll('[data-theme-choice]').forEach((btn) => {
    const active = btn.dataset.themeChoice === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', String(active));
  });
}

export function initThemeSystem() {
  const initialMode = getSavedThemeMode();
  applyThemeMode(initialMode, { animate: false });

  // Live update if OS theme changes while set to System
  if (mediaQuery) {
    const onSystemChange = () => {
      if (getSavedThemeMode() === 'system') {
        applyThemeMode('system', { animate: false });
      }
    };
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onSystemChange);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(onSystemChange);
    }
  }

  // Bind Lather soap-bubble quick toggle (cycles Light <-> Dark)
  document.querySelectorAll('.lather-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const curr = document.documentElement.dataset.theme || 'light';
      const next = curr === 'dark' ? 'light' : 'dark';
      btn.classList.remove('is-bubbling');
      void btn.offsetWidth;
      btn.classList.add('is-bubbling');
      applyThemeMode(next, { animate: true, originEl: btn });
    });
  });

  // Bind 3-way Light / Dark / System selector
  document.querySelectorAll('[data-theme-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const choice = btn.dataset.themeChoice;
      applyThemeMode(choice, { animate: true, originEl: btn });
    });
  });
}
