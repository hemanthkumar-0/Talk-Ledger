/**
 * Voice Khata — Ultra-Lightweight Aurora 3D Shader Engine (public/src/aurora-3d.js)
 * Performance-tuned for steady 60fps scrolling:
 * - Single hero-only WebGL canvas on desktop (>= 768px); skips WebGL completely on mobile
 *   and low-memory devices so mid-range phones rely on crisp 0ms CSS radial gradients.
 * - Capped at 1.0 DPR and 30fps (33ms frame budget) with 3-octave FBM (3x less GPU work).
 * - Automatically pauses via IntersectionObserver when off-screen, on hidden tabs,
 *   AND briefly yields during active scroll bursts so scroll compositing gets 100% GPU priority.
 */

const VERT_SRC = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`;

const FRAG_SRC = `
  precision mediump float;
  varying vec2 v_uv;
  uniform float u_time;
  uniform vec2 u_res;
  uniform vec2 u_pointer;
  uniform float u_dark;
  uniform float u_energy;
  uniform float u_mode;
  uniform float u_state;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.55;
    mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
    for (int i = 0; i < 3; i++) {
      v += a * noise(p);
      p = rot * p * 2.02 + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = v_uv;
    float aspect = u_res.x / max(1.0, u_res.y);
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

    vec2 ptr = (u_pointer - 0.5) * vec2(aspect, 1.0);
    p -= ptr * (0.11 + u_mode * 0.10);

    float speed = 0.25 + u_energy * 0.5 + (u_state > 1.5 && u_state < 2.5 ? 0.4 : 0.0);
    float t = u_time * speed;

    vec2 q = vec2(
      fbm(p * 1.35 + vec2(t * 0.4, -t * 0.24)),
      fbm(p * 1.35 + vec2(-t * 0.3 + 4.1, t * 0.36))
    );
    float f = fbm(p * 1.55 + 2.1 * q);

    float ribbonA = exp(-abs(p.y * 1.45 + sin(p.x * 2.0 + t * 1.1 + q.x * 2.8) * 0.32 - 0.08) * (3.6 - u_mode * 0.9));
    float ribbonB = exp(-abs(p.y * 1.25 - cos(p.x * 1.6 - t * 0.88 + q.y * 3.0) * 0.34 + 0.12) * (3.2 - u_mode * 0.7));

    vec3 navyDeep   = vec3(0.067, 0.094, 0.153); // #111827
    vec3 navyCard   = vec3(0.098, 0.135, 0.220); // #151C2C
    vec3 goldMain   = vec3(0.788, 0.663, 0.380); // #C9A961
    vec3 goldLight  = vec3(0.910, 0.835, 0.639); // #E8D5A3
    vec3 ivorySoft  = vec3(0.961, 0.961, 0.941); // #F5F5F0

    vec3 c1 = navyCard;
    vec3 c2 = goldMain;
    vec3 c3 = goldLight;
    vec3 c4 = mix(navyDeep, ivorySoft, 0.18);

    if (u_state > 0.5 && u_state < 1.5) {
      c2 = goldLight;
      c3 = ivorySoft;
    } else if (u_state > 2.5 && u_state < 3.5) {
      c2 = vec3(0.290, 0.871, 0.502);
      c3 = goldLight;
    } else if (u_state > 3.5) {
      c2 = vec3(0.973, 0.443, 0.443);
      c3 = goldMain;
    }

    vec3 col = mix(c1, c2, clamp(f * 0.95, 0.0, 1.0));
    col = mix(col, c3, clamp(ribbonA * 0.52 + u_energy * 0.22, 0.0, 1.0));
    col = mix(col, c4, clamp(ribbonB * 0.36 * q.x, 0.0, 0.48));

    float dist = length(p * vec2(0.84, 1.04));
    float halo = exp(-dist * dist * (2.05 - u_mode * 0.42));
    float alphaBase = mix(0.22, 0.40, u_dark);
    float alphaMode = mix(alphaBase, 0.68, u_mode);
    float alpha = clamp((ribbonA * 0.48 + ribbonB * 0.36 + halo * 0.46) * alphaMode, 0.0, 0.82);

    float edgeFade = smoothstep(0.0, 0.16, uv.y) * smoothstep(1.0, 0.82, uv.y);
    if (u_mode < 0.5) {
      alpha *= edgeFade;
    }

    gl_FragColor = vec4(col, alpha);
  }
`;

const FRAME_INTERVAL_MS = 33.3; // Cap ambient background aurora to 30fps

export class Aurora3DEngine {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.mode = options.mode === 'auth' ? 1 : 0;
    this.state = 'idle';
    this.energy = 0;
    this.targetEnergy = 0;
    this.pointer = { x: 0.5, y: 0.5 };
    this.targetPointer = { x: 0.5, y: 0.5 };
    this.running = false;
    this.disposed = false;
    this.inViewport = true;
    this.scrollPaused = false;
    this.rafId = null;
    this.lastDrawTs = 0;
    this.gl = null;
    this.ctx2d = null;
    this.program = null;
    this.uniforms = {};
    this.startTs = performance.now();

    this.reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  init() {
    if (!this.canvas || this.disposed) return false;

    // On mobile (<= 768px) or low-memory devices, skip heavy WebGL on hero — CSS radial glow renders at 60fps
    const isMobileHero = this.mode === 0 && window.innerWidth <= 768;
    const isLowPower = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 2;
    if (isMobileHero || (this.mode === 0 && isLowPower)) {
      this.canvas.style.display = 'none';
      return false;
    }

    this.resize();

    const gl =
      this.canvas.getContext('webgl', { alpha: true, antialias: false, powerPreference: 'low-power' }) ||
      this.canvas.getContext('experimental-webgl', { alpha: true });

    if (gl && this.initWebGL(gl)) {
      this.gl = gl;
    } else {
      this.ctx2d = this.canvas.getContext('2d');
    }

    this.bindEvents();
    this.renderFrame(performance.now());
    if (!this.reducedMotion) {
      this.start();
    }
    return true;
  }

  initWebGL(gl) {
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return false;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return false;
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.useProgram(prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.program = prog;
    this.buffer = buf;
    this.uniforms = {
      time: gl.getUniformLocation(prog, 'u_time'),
      res: gl.getUniformLocation(prog, 'u_res'),
      pointer: gl.getUniformLocation(prog, 'u_pointer'),
      dark: gl.getUniformLocation(prog, 'u_dark'),
      energy: gl.getUniformLocation(prog, 'u_energy'),
      mode: gl.getUniformLocation(prog, 'u_mode'),
      state: gl.getUniformLocation(prog, 'u_state'),
    };
    return true;
  }

  setState(nextState) {
    this.state = nextState || 'idle';
    if (nextState === 'listening') this.targetEnergy = Math.max(this.targetEnergy, 0.55);
    else if (nextState === 'processing') this.targetEnergy = 0.85;
    else if (nextState === 'success') this.targetEnergy = 0.9;
    else if (nextState === 'error') this.targetEnergy = 0.75;
    else this.targetEnergy = 0;
  }

  setEnergy(level) {
    this.targetEnergy = Math.max(0, Math.min(1, Number(level) || 0));
  }

  setScrollPaused(paused) {
    this.scrollPaused = Boolean(paused);
  }

  getStateIndex() {
    if (this.state === 'listening') return 1;
    if (this.state === 'processing') return 2;
    if (this.state === 'success') return 3;
    if (this.state === 'error') return 4;
    return 0;
  }

  isDarkTheme() {
    if (this.mode === 1) return true;
    return document.documentElement.dataset.theme === 'dark';
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(160, Math.round(rect.width || window.innerWidth));
    const h = Math.max(140, Math.round(rect.height || 480));
    // Soft ambient shader renders cleanly at 0.75–1.0 DPR (~3x less GPU fill cost than 1.75 DPR)
    const scale = this.mode === 0 ? 0.75 : 1.0;
    const targetW = Math.round(w * scale);
    const targetH = Math.round(h * scale);

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    if (this.gl) {
      this.gl.viewport(0, 0, targetW, targetH);
    }
  }

  bindEvents() {
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });

    this._onPointer = (e) => {
      if (!this.inViewport) return;
      this.targetPointer.x = Math.max(0, Math.min(1, e.clientX / Math.max(1, window.innerWidth)));
      this.targetPointer.y = Math.max(0, Math.min(1, 1 - e.clientY / Math.max(1, window.innerHeight)));
    };
    window.addEventListener('pointermove', this._onPointer, { passive: true });

    this._onTheme = () => {
      if (this.reducedMotion) this.renderFrame(performance.now());
    };
    window.addEventListener('talkledger:themechange', this._onTheme);

    this._onVis = () => {
      if (document.hidden) this.pause();
      else if (this.inViewport && !this.reducedMotion) this.start();
    };
    document.addEventListener('visibilitychange', this._onVis);

    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver(
        (entries) => {
          this.inViewport = Boolean(entries[0]?.isIntersecting);
          if (!this.inViewport) this.pause();
          else if (!document.hidden && !this.reducedMotion) this.start();
        },
        { threshold: 0.01 }
      );
      this.observer.observe(this.canvas);
    }
  }

  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    const loop = (ts) => {
      if (!this.running || this.disposed) return;
      if (!this.scrollPaused && ts - this.lastDrawTs >= FRAME_INTERVAL_MS) {
        this.lastDrawTs = ts;
        this.renderFrame(ts);
      }
      this.rafId = window.requestAnimationFrame(loop);
    };
    this.rafId = window.requestAnimationFrame(loop);
  }

  pause() {
    this.running = false;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  renderFrame(ts) {
    this.energy += (this.targetEnergy - this.energy) * 0.08;
    this.pointer.x += (this.targetPointer.x - this.pointer.x) * 0.06;
    this.pointer.y += (this.targetPointer.y - this.pointer.y) * 0.06;

    const elapsed = (ts - this.startTs) * 0.001;
    const isDark = this.isDarkTheme();

    if (this.gl && this.program) {
      const gl = this.gl;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(this.uniforms.time, elapsed);
      gl.uniform2f(this.uniforms.res, this.canvas.width, this.canvas.height);
      gl.uniform2f(this.uniforms.pointer, this.pointer.x, this.pointer.y);
      gl.uniform1f(this.uniforms.dark, isDark ? 1.0 : 0.0);
      gl.uniform1f(this.uniforms.energy, this.energy);
      gl.uniform1f(this.uniforms.mode, this.mode);
      gl.uniform1f(this.uniforms.state, this.getStateIndex());
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return;
    }

    if (!this.ctx2d) return;
    const ctx = this.ctx2d;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const blobs = [
      {
        x: w * (0.3 + 0.16 * Math.sin(elapsed * 0.45)),
        y: h * (0.42 + 0.12 * Math.cos(elapsed * 0.35)),
        r: Math.max(w, h) * 0.44,
        c: 'rgba(201, 169, 97, 0.2)',
      },
      {
        x: w * (0.68 + 0.14 * Math.cos(elapsed * 0.38)),
        y: h * (0.48 + 0.12 * Math.sin(elapsed * 0.52)),
        r: Math.max(w, h) * 0.4,
        c: 'rgba(21, 28, 44, 0.38)',
      },
    ];

    for (const b of blobs) {
      const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      grad.addColorStop(0, b.c);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
  }

  dispose() {
    this.disposed = true;
    this.pause();
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this._onPointer) window.removeEventListener('pointermove', this._onPointer);
    if (this._onTheme) window.removeEventListener('talkledger:themechange', this._onTheme);
    if (this._onVis) document.removeEventListener('visibilitychange', this._onVis);
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.gl) {
      if (this.program) this.gl.deleteProgram(this.program);
      if (this.buffer) this.gl.deleteBuffer(this.buffer);
      this.gl = null;
    }
  }
}
