/**
 * Scrolltide #c-signal Inspired Interactive LED-Matrix Background
 * Renders a crisp dot-matrix LED field beneath a hairline crosshair reticle
 * with an interactive pointer-orbit comet, soft diagonal rain shimmer, and
 * audio-reactive spectrogram pulse. Respects prefers-reduced-motion & hidden tabs.
 */

export class SignalMatrixBackground {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.rafId = null;
    this.time = 0;
    this.pointer = { x: 0.5, y: 0.45, active: false };
    this.audioEnergy = 0;
    this.visible = true;
    this.reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  init() {
    if (!this.canvas || !this.ctx) return;

    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });

    this._onPointerMove = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      this.pointer.x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this.pointer.y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      this.pointer.active = true;
    };
    window.addEventListener('pointermove', this._onPointerMove, { passive: true });

    this._onVisibility = () => {
      if (document.hidden) this.pause();
      else if (!this.reducedMotion) this.start();
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    this._onTheme = () => {
      if (this.reducedMotion) this.renderFrame();
    };
    window.addEventListener('talkledger:themechange', this._onTheme);

    if (this.reducedMotion) {
      this.renderFrame();
    } else {
      this.start();
    }
  }

  setAudioEnergy(val) {
    this.audioEnergy = Math.max(0, Math.min(1, Number(val) || 0));
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  start() {
    if (this.rafId !== null || this.reducedMotion) return;
    const loop = () => {
      this.time += 0.018;
      this.renderFrame();
      this.rafId = window.requestAnimationFrame(loop);
    };
    this.rafId = window.requestAnimationFrame(loop);
  }

  pause() {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  renderFrame() {
    if (!this.ctx || !this.width || !this.height) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const isDark = document.documentElement.dataset.theme === 'dark';

    ctx.clearRect(0, 0, w, h);

    // Subtle hairline crosshair reticle (signature Signal detail)
    const cx = w * 0.5;
    const cy = h * 0.48;
    ctx.strokeStyle = isDark ? 'rgba(190, 242, 100, 0.09)' : 'rgba(19, 29, 51, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();

    // Orbiting comet focal point (follows pointer softly or glides in elliptical orbit)
    const orbitX = this.pointer.active
      ? this.pointer.x * w
      : cx + Math.cos(this.time * 0.75) * Math.min(w * 0.28, 280);
    const orbitY = this.pointer.active
      ? this.pointer.y * h
      : cy + Math.sin(this.time * 0.55) * Math.min(h * 0.24, 150);

    const spacing = w < 640 ? 22 : 20;
    const cols = Math.ceil(w / spacing);
    const rows = Math.ceil(h / spacing);
    const radiusMax = Math.min(w, h) * 0.36;

    const baseDot = isDark ? 'rgba(148, 163, 184, 0.16)' : 'rgba(19, 29, 51, 0.11)';

    for (let r = 0; r <= rows; r += 1) {
      const y = r * spacing;
      for (let c = 0; c <= cols; c += 1) {
        const x = c * spacing;
        const dx = x - orbitX;
        const dy = y - orbitY;
        const dist = Math.hypot(dx, dy);

        // Ambient diagonal rain wave + comet proximity + optional mic spectrogram pulse
        const rainWave = Math.sin(c * 0.45 - this.time * 2.1 + r * 0.25) * 0.5 + 0.5;
        const cometGlow = Math.max(0, 1 - dist / radiusMax);
        const energy = Math.min(
          1,
          cometGlow * cometGlow * 0.95 + (rainWave > 0.86 ? 0.22 : 0) + this.audioEnergy * 0.35 * rainWave
        );

        const dotR = energy > 0.18 ? 1.5 + energy * 1.45 : 1.15;

        if (energy > 0.2) {
          if (isDark) {
            ctx.fillStyle =
              cometGlow > 0.45
                ? `rgba(230, 168, 37, ${(0.25 + energy * 0.65).toFixed(2)})`
                : `rgba(163, 230, 53, ${(0.18 + energy * 0.42).toFixed(2)})`;
          } else {
            ctx.fillStyle =
              cometGlow > 0.45
                ? `rgba(122, 20, 36, ${(0.16 + energy * 0.42).toFixed(2)})`
                : `rgba(230, 168, 37, ${(0.18 + energy * 0.48).toFixed(2)})`;
          }
        } else {
          ctx.fillStyle = baseDot;
        }

        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
