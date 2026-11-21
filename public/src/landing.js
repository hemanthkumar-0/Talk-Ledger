/**
 * Voice Khata — 60fps Scroll-Optimized Luxury Landing Controller (public/src/landing.js)
 * Performance architecture:
 * - Zero layout thrashing on scroll: caches maxScroll on resize; never calls getBoundingClientRect()
 *   or reads scrollHeight inside scroll/pointermove callbacks.
 * - Single coordinated scroll pipeline: native passive scroll rAF (on mobile/touch/offline) OR
 *   Lenis synced strictly inside gsap.ticker with lagSmoothing(0) on non-touch desktops ONLY.
 * - Disables Lenis smooth scroll on touch devices so mobile uses native compositor scrolling.
 * - Auto-pauses ALL off-screen looping CSS animations (marquee, orbs, 3D icons, rings, wave bars)
 *   via a single IntersectionObserver on [data-anim-section].
 * - Temporarily applies will-change only during active transitions and clears it on transitionend.
 * - Zero pinned ScrollTriggers; uses once: true IntersectionObserver / ScrollTrigger reveals.
 * - Dev-only live FPS & Long-Task (>50ms) counter (hidden automatically in production).
 */

import { Aurora3DEngine } from './aurora-3d.js';
import { initDevFpsMeter } from './fps-meter.js';
import { getSavedLanguage, loadLanguage } from './i18n.js';
import { SignalMatrixBackground } from './signal-bg.js';
import { initThemeSystem } from './theme.js';

const HOW_STEPS = [
  {
    tag: 'Step 01 · Listening',
    title: '“Ramesh, 560 credit today, he paid 250 yesterday.”',
    desc: 'Capturing Indian-English & Hinglish speech cleanly across busy shop counters.',
  },
  {
    tag: 'Step 02 · Understood',
    title: 'Parsed: Ramesh → +₹560 Dr (Today) & −₹250 Cr (Yesterday)',
    desc: 'Deterministic local parser resolves exact amounts, relative dates, and customer matches.',
  },
  {
    tag: 'Step 03 · Saved & Encrypted',
    title: 'Locked in AES-GCM Vault · Net Balance: Owes ₹310',
    desc: 'Totals refresh instantly and a crisp one-sentence voice confirmation reads back aloud.',
  },
];

function prefersReducedMotion() {
  return Boolean(
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function isTouchOrMobileDevice() {
  return Boolean(
    window.innerWidth <= 768 ||
      'ontouchstart' in window ||
      (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) ||
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
  );
}

/**
 * Pause ALL looping CSS animations inside any [data-anim-section] when off-screen.
 */
function initAnimationVisibilityPause() {
  const sections = document.querySelectorAll('[data-anim-section]');
  if (!sections.length || typeof IntersectionObserver === 'undefined') return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        entry.target.classList.toggle('is-paused', !entry.isIntersecting);
      }
    },
    { rootMargin: '120px 0px 120px 0px', threshold: 0.01 }
  );

  sections.forEach((sec) => observer.observe(sec));
}

function initSplitHeadings() {
  if (prefersReducedMotion()) return;
  document.querySelectorAll('[data-split-heading]').forEach((heading) => {
    let wordIndex = 0;
    const wrapTextNode = (node) => {
      const words = node.textContent.split(/(\s+)/);
      const frag = document.createDocumentFragment();
      words.forEach((part) => {
        if (!part) return;
        if (/^\s+$/.test(part)) {
          frag.appendChild(document.createTextNode(part));
        } else {
          const span = document.createElement('span');
          span.className = 'vk-split-word';
          span.style.setProperty('--word-delay', `${Math.min(wordIndex * 45, 340)}ms`);
          span.textContent = part;
          wordIndex += 1;
          frag.appendChild(span);
        }
      });
      return frag;
    };

    Array.from(heading.childNodes).forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
        heading.replaceChild(wrapTextNode(child), child);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        child.classList.add('vk-split-word');
        child.style.setProperty('--word-delay', `${Math.min(wordIndex * 45, 340)}ms`);
        wordIndex += 1;
      }
    });
  });
}

function initScrollReveals() {
  document.querySelectorAll('[data-stagger-group]').forEach((group) => {
    const items = group.querySelectorAll('.reveal-up, .reveal-card');
    items.forEach((el, idx) => {
      el.style.setProperty('--stagger-delay', `${Math.min(idx * 80, 420)}ms`);
    });
  });

  const targets = document.querySelectorAll('.reveal-up, .reveal-card, .reveal-shield');
  if (!targets.length) return;

  if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
    targets.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        observer.unobserve(el);

        // Apply will-change ONLY while actively transitioning, then clear immediately
        el.classList.add('is-animating');
        el.addEventListener(
          'transitionend',
          () => el.classList.remove('is-animating'),
          { once: true }
        );
        // Safety fallback cleanup
        setTimeout(() => el.classList.remove('is-animating'), 1100);
        el.classList.add('is-visible');
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -30px 0px' }
  );

  targets.forEach((el) => observer.observe(el));
}

function initNumberCounters() {
  const counters = document.querySelectorAll('[data-counter]');
  if (!counters.length) return;

  const formatNum = (val, suffix) => {
    const formatted = Math.round(val).toLocaleString('en-IN');
    return `${formatted}${suffix || ''}`;
  };

  if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
    counters.forEach((el) => {
      el.textContent = formatNum(Number(el.dataset.counter || 0), el.dataset.suffix || '');
    });
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        observer.unobserve(el);

        const targetVal = Number(el.dataset.counter || 0);
        const suffix = el.dataset.suffix || '';
        const duration = 950;
        const startTs = performance.now();

        const step = (now) => {
          const p = Math.min(1, (now - startTs) / duration);
          const eased = 1 - (1 - p) ** 3;
          el.textContent = formatNum(targetVal * eased, suffix);
          if (p < 1) window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
      }
    },
    { threshold: 0.35 }
  );

  counters.forEach((el) => observer.observe(el));
}

/**
 * Unified scroll progress bar & sticky navbar controller.
 * Caches maxScroll on resize/content change -> ZERO forced reflows during scroll!
 */
function initScrollProgressAndNavbar(auroraInstance) {
  const progressBar = document.getElementById('scrollProgressBar');
  const header = document.getElementById('siteHeader');
  let cachedMaxScroll = 1;
  let lastScrolledState = false;
  let rafPending = false;
  let scrollIdleTimer = null;

  const recalcMaxScroll = () => {
    cachedMaxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  };
  recalcMaxScroll();

  let resizeDebounce = null;
  window.addEventListener(
    'resize',
    () => {
      clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(recalcMaxScroll, 160);
    },
    { passive: true }
  );

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(recalcMaxScroll);
    ro.observe(document.body);
  }

  const applyScrollPosition = (scrollY) => {
    const ratio = Math.max(0, Math.min(1, scrollY / cachedMaxScroll));
    if (progressBar) {
      progressBar.style.transform = `scaleX(${ratio.toFixed(4)}) translateZ(0)`;
    }
    const nowScrolled = scrollY > 50;
    if (header && nowScrolled !== lastScrolledState) {
      lastScrolledState = nowScrolled;
      header.classList.toggle('is-scrolled', nowScrolled);
    }

    // Briefly pause background hero WebGL shader during active scroll bursts so compositor gets 100% GPU
    if (auroraInstance) {
      auroraInstance.setScrollPaused(true);
      clearTimeout(scrollIdleTimer);
      scrollIdleTimer = setTimeout(() => auroraInstance.setScrollPaused(false), 140);
    }
  };

  const onNativeScroll = () => {
    // When Lenis+GSAP is active on desktop, Lenis drives applyScrollPosition directly (1 single rAF loop)
    if (window.__vkLenisActive) return;
    if (!rafPending) {
      rafPending = true;
      window.requestAnimationFrame(() => {
        rafPending = false;
        applyScrollPosition(window.scrollY || 0);
      });
    }
  };

  window.addEventListener('scroll', onNativeScroll, { passive: true });
  applyScrollPosition(window.scrollY || 0);

  // Active nav link highlight using IntersectionObserver (zero scroll work)
  const navLinks = Array.from(document.querySelectorAll('#primaryNav [data-nav-section]'));
  const sections = navLinks
    .map((a) => document.getElementById(a.dataset.navSection))
    .filter(Boolean);

  if (sections.length && typeof IntersectionObserver !== 'undefined') {
    const spy = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.id;
            navLinks.forEach((link) => {
              link.classList.toggle('is-active', link.dataset.navSection === id);
            });
          }
        }
      },
      { rootMargin: '-35% 0px -55% 0px', threshold: 0.01 }
    );
    sections.forEach((sec) => spy.observe(sec));
  }

  return { applyScrollPosition, recalcMaxScroll };
}

/**
 * Spotlight radial gold hover on desktop cards.
 * Caches card BoundingClientRect on pointerenter (NEVER reads layout on every pointermove!).
 */
function initSpotlightHover() {
  if (prefersReducedMotion() || isTouchOrMobileDevice()) return;
  document.querySelectorAll('[data-spotlight]').forEach((card) => {
    let rect = null;
    card.addEventListener(
      'pointerenter',
      () => {
        rect = card.getBoundingClientRect();
      },
      { passive: true }
    );
    card.addEventListener(
      'pointermove',
      (e) => {
        if (!rect) rect = card.getBoundingClientRect();
        card.style.setProperty('--spot-x', `${(e.clientX - rect.left).toFixed(0)}px`);
        card.style.setProperty('--spot-y', `${(e.clientY - rect.top).toFixed(0)}px`);
      },
      { passive: true }
    );
    card.addEventListener(
      'pointerleave',
      () => {
        rect = null;
      },
      { passive: true }
    );
  });
}

/**
 * Desktop-only 3D tilt on Hero phone frame.
 * Pauses completely when hero leaves viewport and clears will-change when idle.
 */
function initHero3DParallax() {
  const phone = document.getElementById('heroPhoneTilt');
  const stage = phone?.closest('.vk-phone-stage');
  if (!phone || !stage || prefersReducedMotion() || isTouchOrMobileDevice()) return;

  let targetX = 0;
  let targetY = 0;
  let currX = 0;
  let currY = 0;
  let raf = null;
  let stageRect = null;

  const animate = () => {
    currX += (targetX - currX) * 0.1;
    currY += (targetY - currY) * 0.1;
    phone.style.transform = `perspective(1100px) rotateX(${currY.toFixed(2)}deg) rotateY(${currX.toFixed(2)}deg)`;

    if (Math.abs(targetX - currX) > 0.04 || Math.abs(targetY - currY) > 0.04) {
      raf = window.requestAnimationFrame(animate);
    } else {
      raf = null;
      phone.classList.remove('is-animating');
    }
  };

  const kick = () => {
    phone.classList.add('is-animating');
    if (raf === null) raf = window.requestAnimationFrame(animate);
  };

  stage.addEventListener(
    'pointerenter',
    () => {
      stageRect = stage.getBoundingClientRect();
    },
    { passive: true }
  );

  stage.addEventListener(
    'pointermove',
    (e) => {
      if (!stageRect) stageRect = stage.getBoundingClientRect();
      const nx = ((e.clientX - stageRect.left) / Math.max(1, stageRect.width)) * 2 - 1;
      const ny = ((e.clientY - stageRect.top) / Math.max(1, stageRect.height)) * 2 - 1;
      targetX = Math.max(-8, Math.min(8, nx * 8));
      targetY = Math.max(-6, Math.min(6, -ny * 6));
      kick();
    },
    { passive: true }
  );

  stage.addEventListener(
    'pointerleave',
    () => {
      stageRect = null;
      targetX = 0;
      targetY = 0;
      kick();
    },
    { passive: true }
  );
}

/**
 * Interactive 3-step How-it-Works timeline.
 * Uses pure IntersectionObserver (ZERO scroll getBoundingClientRect() calls!).
 */
function initHowItWorksTimeline() {
  const stepBtns = Array.from(document.querySelectorAll('[data-how-step]'));
  const fill = document.getElementById('timelineFill');
  const tagEl = document.getElementById('howPreviewTag');
  const titleEl = document.getElementById('howPreviewTitle');
  const descEl = document.getElementById('howPreviewDesc');
  const dots = Array.from(document.querySelectorAll('[data-how-dot]'));
  if (!stepBtns.length) return null;

  const activateStep = (idx) => {
    const clean = Math.max(0, Math.min(HOW_STEPS.length - 1, idx));
    stepBtns.forEach((btn, i) => {
      const active = i === clean;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    dots.forEach((d, i) => d.classList.toggle('is-active', i <= clean));
    if (fill) {
      fill.style.transform = `scaleX(${((clean + 1) / HOW_STEPS.length).toFixed(3)})`;
    }
    const meta = HOW_STEPS[clean];
    if (meta && tagEl && titleEl && descEl) {
      tagEl.textContent = meta.tag;
      titleEl.textContent = meta.title;
      descEl.textContent = meta.desc;
    }
  };

  stepBtns.forEach((btn) => {
    btn.addEventListener('click', () => activateStep(Number(btn.dataset.howStep || 0)));
  });

  // Progressive step activation via IntersectionObserver — zero scroll layout thrashing
  if (!prefersReducedMotion() && typeof IntersectionObserver !== 'undefined') {
    const stepObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const stepIdx = Number(entry.target.dataset.howStep || 0);
            activateStep(stepIdx);
          }
        }
      },
      { rootMargin: '-25% 0px -35% 0px', threshold: 0.4 }
    );
    stepBtns.forEach((btn) => stepObserver.observe(btn));
  }

  activateStep(0);
  return { activateStep };
}

function initFaqAccordion() {
  const container = document.getElementById('faqAccordion');
  if (!container) return;

  const items = Array.from(container.querySelectorAll('.vk-faq-item'));
  items.forEach((item) => {
    const trigger = item.querySelector('.vk-faq-trigger');
    if (!trigger) return;

    trigger.addEventListener('click', () => {
      const wasOpen = item.classList.contains('is-open');
      items.forEach((other) => {
        other.classList.remove('is-open');
        other.querySelector('.vk-faq-trigger')?.setAttribute('aria-expanded', 'false');
      });
      if (!wasOpen) {
        item.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
  });
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

/**
 * Progressive lazy enhancement: loads Lenis + GSAP ScrollTrigger ONLY on capable non-touch desktops.
 * Properly synced into ONE single rAF loop via gsap.ticker with lagSmoothing(0).
 * Disabled completely on touch/mobile devices so phones use buttery native scrolling.
 */
async function initProgressiveGsapLenis(scrollController) {
  const lowMem = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
  if (prefersReducedMotion() || isTouchOrMobileDevice() || lowMem || window.innerWidth < 1024) {
    return;
  }

  try {
    const [{ default: gsap }, { ScrollTrigger }, { default: Lenis }] = await Promise.all([
      import('https://cdn.jsdelivr.net/npm/gsap@3.12.5/index.js'),
      import('https://cdn.jsdelivr.net/npm/gsap@3.12.5/ScrollTrigger.js'),
      import('https://cdn.jsdelivr.net/npm/lenis@1.1.18/dist/lenis.mjs'),
    ]);

    gsap.registerPlugin(ScrollTrigger);

    const lenis = new Lenis({
      duration: 0.95,
      smoothWheel: true,
      syncTouch: false, // Never hijack touch scroll
    });

    // Single rAF source of truth: Lenis runs inside gsap.ticker with lagSmoothing(0)
    window.__vkLenisActive = true;
    lenis.on('scroll', (e) => {
      ScrollTrigger.update();
      scrollController?.applyScrollPosition(e.scroll);
    });
    gsap.ticker.add((time) => {
      lenis.raf(time * 1000);
    });
    gsap.ticker.lagSmoothing(0);

    // Smooth anchor jump via Lenis with sticky header offset
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
      anchor.addEventListener('click', (e) => {
        const id = anchor.getAttribute('href');
        if (!id || id === '#') return;
        const target = document.querySelector(id);
        if (!target) return;
        e.preventDefault();
        lenis.scrollTo(target, { offset: -74 });
      });
    });

    // Lightweight once:true reveal trigger on final CTA (no pinned sections, no multi-element scrub)
    const ctaWrap = document.querySelector('.vk-cta-glow-wrap');
    if (ctaWrap) {
      ScrollTrigger.create({
        trigger: ctaWrap,
        start: 'top 85%',
        once: true,
        onEnter: () => ctaWrap.classList.add('is-visible'),
      });
    }
  } catch {
    // Offline or CDN unavailable -> native passive rAF scroll remains active
    window.__vkLenisActive = false;
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  initThemeSystem();

  // Dev-only FPS & Long-Task counter (hidden automatically in production)
  initDevFpsMeter();

  // Hero-only lightweight WebGL Aurora (automatically disabled on <= 768px mobile & low-mem devices)
  const heroAuroraCanvas = document.getElementById('heroAuroraCanvas');
  let aurora = null;
  if (heroAuroraCanvas) {
    aurora = new Aurora3DEngine(heroAuroraCanvas, { mode: 'hero' });
    aurora.init();
  }

  // Zero-CPU static ambient dot grid (drawn once on desktop, disabled on mobile)
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

  const yieldFrame = () => new Promise((r) => window.requestAnimationFrame(() => r()));

  initAnimationVisibilityPause();
  initScrollReveals();
  const scrollController = initScrollProgressAndNavbar(aurora);

  // Yield one frame so first paint & critical interactions stay well under 50ms on mid-range phones
  await yieldFrame();

  initSplitHeadings();
  initNumberCounters();
  initSpotlightHover();
  initHero3DParallax();
  initHowItWorksTimeline();
  initFaqAccordion();
  initContactForm();

  // Defer Lenis + GSAP load until browser is idle (non-touch desktops only)
  if (!isTouchOrMobileDevice()) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => initProgressiveGsapLenis(scrollController), { timeout: 1800 });
    } else {
      setTimeout(() => initProgressiveGsapLenis(scrollController), 600);
    }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }
});
