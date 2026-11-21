/**
 * Voice Khata — Zero-CPU Static Ambient Dot-Matrix Backdrop (public/src/signal-bg.js)
 * Performance fix: replaces the old 60fps per-frame 2,700-dot CPU redraw loop with a
 * crisp single-pass static render (re-painted ONLY on resize or theme change) so
 * scrolling maintains a steady 60fps even on mid-range Android devices.
 */

export class SignalMatrixBackground {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.audioEnergy = 0;
    this.width = 0;
    this.height = 0;
    this.resizeTimer = null;
  }

  init() {
    if (!this.canvas || !this.ctx) return;

    // Skip ambient canvas entirely on mobile viewports for maximum scroll headroom
    if (window.innerWidth <= 768) {
      this.canvas.style.display = 'none';
      return;
    }

    this.resize();

    this._onResize = () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        if (window.innerWidth <= 768) {
          this.canvas.style.display = 'none';
          return;
        }
        this.canvas.style.display = '';
        this.resize();
      }, 180);
    };
    window.addEventListener('resize', this._onResize, { passive: true });

    this._onTheme = () => this.renderStatic();
    window.addEventListener('talkledger:themechange', this._onTheme);
  }

  setAudioEnergy(val) {
    // Keep public method signature intact for /app voice reactivity without spawning a 60fps loop
    this.audioEnergy = Math.max(0, Math.min(1, Number(val) || 0));
  }

  resize() {
    if (!this.canvas || !this.ctx) return;
    const w = Math.max(10, Math.round(window.innerWidth));
    const h = Math.max(10, Math.round(window.innerHeight));
    const dpr = 1; // Ambient subtle grid looks crisp at 1x DPR with 4x smaller GPU texture
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.renderStatic();
  }

  renderStatic() {
    if (!this.ctx || !this.width || !this.height) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const isDark = document.documentElement.dataset.theme === 'dark';

    ctx.clearRect(0, 0, w, h);

    // Subtle hairline crosshair reticle in champagne gold
    const cx = w * 0.5;
    const cy = h * 0.45;
    ctx.strokeStyle = isDark ? 'rgba(201, 169, 97, 0.06)' : 'rgba(11, 15, 25, 0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();

    // Single batched path for dot grid (1 GPU fill call instead of 2,700 per frame)
    const spacing = 36;
    ctx.fillStyle = isDark ? 'rgba(156, 163, 175, 0.09)' : 'rgba(11, 15, 25, 0.06)';
    ctx.beginPath();
    for (let y = spacing * 0.5; y < h; y += spacing) {
      for (let x = spacing * 0.5; x < w; x += spacing) {
        ctx.rect(x, y, 1.5, 1.5);
      }
    }
    ctx.fill();
  }
}
