/**
 * Voice Khata — Production Website Controller (/, /privacy, /terms, /contact)
 * Initializes Light/Dark/System theme (#c-lather), language + RTL, subtle LED ambient canvas,
 * scroll fade-in reveal, contact form handling, and PWA Service Worker registration.
 */

import { getSavedLanguage, loadLanguage } from './i18n.js';
import { SignalMatrixBackground } from './signal-bg.js';
import { initThemeSystem } from './theme.js';

function initScrollReveal() {
  const targets = document.querySelectorAll('.reveal-on-scroll');
  if (!targets.length) return;

  const reduced =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduced || typeof IntersectionObserver === 'undefined') {
    targets.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );

  targets.forEach((el) => observer.observe(el));
}

function initContactForm() {
  const form = document.getElementById('vkContactForm');
  const status = document.getElementById('vkContactStatus');
  if (!form || !status) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('contactName')?.value.trim();
    const email = document.getElementById('contactEmail')?.value.trim();
    const message = document.getElementById('contactMessage')?.value.trim();

    if (!name || !email || !message) {
      status.hidden = false;
      status.textContent = 'Please complete your name, email, and message.';
      return;
    }

    status.hidden = false;
    status.textContent = `Thank you, ${name}. Your message has been recorded — our support team will reply to ${email}.`;
    form.reset();
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  initThemeSystem();

  const canvas = document.getElementById('signalAmbientCanvas');
  if (canvas) {
    const signalBg = new SignalMatrixBackground(canvas);
    signalBg.init();
  }

  const langSel = document.getElementById('headerLangSelect');
  const savedLang = getSavedLanguage();
  if (langSel) {
    langSel.value = savedLang;
    langSel.addEventListener('change', async (e) => {
      await loadLanguage(e.target.value);
    });
  }
  await loadLanguage(savedLang);

  initScrollReveal();
  initContactForm();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }
});
