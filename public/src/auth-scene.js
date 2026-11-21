/**
 * TalkLedger 3D Animated Auth Scene (public/src/auth-scene.js)
 * - Lazily loads Three.js v0.169.0 from cdnjs AFTER the auth form is interactive.
 * - Floating, slowly rotating 3D rounded Ledger Book + orbiting Rupee Coin + Microphone.
 * - Matte materials read live from theme CSS variables and update on theme change.
 * - Reactive states: idle | typing | listening (AnalyserNode volume) | processing | success | error.
 * - Full safeguards: prefers-reduced-motion static SVG, pixelRatio <= 2, WebGL/low-mem/FPS<24 fallback,
 *   pauses on hidden tab or off-screen, aria-hidden="true", full dispose() with zero leaks.
 */

const THREE_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.169.0/three.module.min.js';

function getCssColorHex(varName, fallback) {
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return val || fallback;
}

function isWebGLSupported() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

export class AuthScene3D {
  constructor(mountEl, stateBadgeEl) {
    this.mountEl = mountEl;
    this.stateBadgeEl = stateBadgeEl;
    this.state = 'idle'; // idle | typing | listening | processing | success | error
    this.micVolume = 0;
    this.pointer = { x: 0, y: 0 };
    this.tilt = { x: 0, y: 0 };
    this.disposed = false;
    this.running = false;
    this.inViewport = true;
    this.rafId = null;
    this.THREE = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.objects = {};
    this.confetti = [];
    this.lowFpsStart = null;
    this.errorShakeTimer = 0;
    this.successTimer = 0;
    this.fallbackActive = false;

    this.reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  async init() {
    if (!this.mountEl || this.disposed) return;

    // Show crisp static SVG fallback immediately when reduced-motion, low-memory, or no WebGL
    const lowMem = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 2;
    if (this.reducedMotion || lowMem || !isWebGLSupported()) {
      this.activateStaticFallback(
        this.reducedMotion ? 'reduced-motion' : lowMem ? 'low-memory' : 'no-webgl'
      );
      return;
    }

    // Lazy load Three.js after the auth form is already interactive
    try {
      this.THREE = await import(THREE_CDN_URL);
      if (this.disposed) return;
      this.buildScene();
      this.bindLifecycle();
      this.startLoop();
    } catch {
      this.activateStaticFallback('cdn-offline');
    }
  }

  activateStaticFallback(reason = 'static') {
    this.fallbackActive = true;
    this.disposeWebGLOnly();
    if (!this.mountEl) return;
    this.mountEl.dataset.fallback = reason;
    this.mountEl.innerHTML = `
      <div class="auth-svg-fallback" aria-hidden="true">
        <svg viewBox="0 0 280 240" width="240" height="205" fill="none">
          <ellipse cx="140" cy="212" rx="76" ry="12" fill="currentColor" opacity="0.14"/>
          <!-- Rounded Ledger Book -->
          <rect x="66" y="48" width="136" height="148" rx="16" fill="var(--primary)" />
          <rect x="76" y="54" width="120" height="136" rx="11" fill="var(--surface)" opacity="0.12" />
          <rect x="66" y="48" width="22" height="148" rx="8" fill="var(--burgundy)" />
          <rect x="116" y="96" width="54" height="8" rx="4" fill="var(--accent)" opacity="0.88" />
          <rect x="116" y="114" width="38" height="6" rx="3" fill="var(--surface)" opacity="0.55" />
          <!-- Orbiting Gold Coin -->
          <circle cx="222" cy="74" r="24" fill="var(--accent)" />
          <circle cx="222" cy="74" r="18" stroke="var(--primary)" stroke-width="2" opacity="0.45" />
          <text x="222" y="81" text-anchor="middle" fill="var(--primary)" font-size="20" font-weight="700">₹</text>
          <!-- Orbiting Microphone -->
          <rect x="34" y="112" width="22" height="36" rx="11" fill="var(--accent)" />
          <path d="M26 138C26 149 34 156 45 156C56 156 64 149 64 138" stroke="var(--text-on-dark)" stroke-width="3.5" stroke-linecap="round"/>
          <line x1="45" y1="156" x2="45" y2="168" stroke="var(--text-on-dark)" stroke-width="3.5" stroke-linecap="round"/>
        </svg>
      </div>
    `;
  }

  buildScene() {
    const THREE = this.THREE;
    const width = Math.max(240, this.mountEl.clientWidth || 380);
    const height = Math.max(180, this.mountEl.clientHeight || 360);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 50);
    this.camera.position.set(0, 0.35, 6.4);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.mountEl.innerHTML = '';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.renderer.domElement.style.pointerEvents = 'none';
    this.mountEl.appendChild(this.renderer.domElement);

    // Soft studio lighting
    const hemi = new THREE.HemisphereLight(0xfffaf0, 0x131d33, 1.25);
    const keyLight = new THREE.DirectionalLight(0xfff6e5, 1.35);
    keyLight.position.set(3.5, 4.5, 5);
    const rimLight = new THREE.DirectionalLight(0xe6a825, 0.65);
    rimLight.position.set(-4, -2, -3);
    this.scene.add(hemi, keyLight, rimLight);

    // Root Pivot Group
    const root = new THREE.Group();
    this.scene.add(root);
    this.objects.root = root;

    // 1. Rounded Ledger Book Group
    const bookGroup = new THREE.Group();
    const coverMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(getCssColorHex('--primary', '#131D33')),
      roughness: 0.72,
      metalness: 0.08,
    });
    const spineMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(getCssColorHex('--burgundy', '#7A1424')),
      roughness: 0.68,
      metalness: 0.1,
    });
    const pageMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(getCssColorHex('--surface', '#FAF8F5')),
      roughness: 0.88,
      metalness: 0.0,
    });
    const goldMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(getCssColorHex('--accent', '#E6A825')),
      roughness: 0.42,
      metalness: 0.35,
      emissive: new THREE.Color('#000000'),
      emissiveIntensity: 0,
    });

    const frontCover = new THREE.Mesh(new THREE.BoxGeometry(1.72, 2.25, 0.1), coverMat);
    frontCover.position.z = 0.22;
    const backCover = new THREE.Mesh(new THREE.BoxGeometry(1.72, 2.25, 0.1), coverMat);
    backCover.position.z = -0.22;
    const pages = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.12, 0.36), pageMat);
    pages.position.x = 0.04;
    const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 2.26, 20), spineMat);
    spine.position.x = -0.84;
    const clasp = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.2, 0.14), goldMat);
    clasp.position.set(0.68, 0, 0.24);
    const emblem = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.045, 12, 32), goldMat);
    emblem.position.set(0.08, 0.18, 0.28);

    bookGroup.add(frontCover, backCover, pages, spine, clasp, emblem);
    root.add(bookGroup);

    // 2. Orbiting Gold Coin
    const coinPivot = new THREE.Group();
    const coinGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.09, 28);
    coinGeo.rotateX(Math.PI / 2);
    const coin = new THREE.Mesh(coinGeo, goldMat.clone());
    coin.position.set(1.95, 0.55, 0.4);
    coinPivot.add(coin);
    root.add(coinPivot);

    // 3. Orbiting Microphone
    const micPivot = new THREE.Group();
    const micGroup = new THREE.Group();
    const micMat = goldMat.clone();
    const micCapsule = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.34, 8, 16), micMat);
    const micStand = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.26, 12), coverMat);
    micStand.position.y = -0.38;
    const micBase = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.06, 16), spineMat);
    micBase.position.y = -0.52;
    micGroup.add(micCapsule, micStand, micBase);
    micGroup.position.set(-1.85, -0.25, 0.55);
    micPivot.add(micGroup);
    root.add(micPivot);

    this.objects = {
      root,
      bookGroup,
      coinPivot,
      coin,
      micPivot,
      micGroup,
      coverMat,
      spineMat,
      pageMat,
      goldMat,
      micMat,
    };
  }

  updateThemeColors() {
    if (!this.THREE || !this.objects.coverMat) return;
    this.objects.coverMat.color.set(getCssColorHex('--primary', '#131D33'));
    this.objects.spineMat.color.set(getCssColorHex('--burgundy', '#7A1424'));
    this.objects.pageMat.color.set(getCssColorHex('--surface', '#FAF8F5'));
    this.objects.goldMat.color.set(getCssColorHex('--accent', '#E6A825'));
    this.objects.coin.material.color.set(getCssColorHex('--accent', '#E6A825'));
    this.objects.micMat.color.set(getCssColorHex('--accent', '#E6A825'));
  }

  setState(nextState) {
    this.state = nextState;
    if (this.stateBadgeEl) {
      const labels = {
        idle: 'Ready',
        typing: 'Typing',
        listening: 'Listening',
        processing: 'Processing',
        success: 'Verified',
        error: 'Check input',
      };
      this.stateBadgeEl.textContent = labels[nextState] || 'Ready';
      this.stateBadgeEl.dataset.state = nextState;
    }

    if (nextState === 'error') {
      this.errorShakeTimer = 0.55;
    } else if (nextState === 'success') {
      this.successTimer = 1.6;
      this.spawnConfetti();
    }
  }

  setMicVolume(vol) {
    this.micVolume = Math.max(0, Math.min(1, Number(vol) || 0));
  }

  spawnConfetti() {
    if (!this.THREE || !this.scene) return;
    const THREE = this.THREE;
    const palette = [0xe6a825, 0x0f766e, 0x7a1424, 0x84cc16];
    for (let i = 0; i < 24; i += 1) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.09, 0.09, 0.02),
        new THREE.MeshStandardMaterial({
          color: palette[i % palette.length],
          roughness: 0.45,
        })
      );
      mesh.position.set(0, 0.4, 0.5);
      const velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 0.14,
        0.06 + Math.random() * 0.1,
        (Math.random() - 0.5) * 0.1
      );
      this.scene.add(mesh);
      this.confetti.push({ mesh, velocity, life: 1.4 });
    }
  }

  async enableTiltParallax() {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      try {
        const perm = await DeviceOrientationEvent.requestPermission();
        if (perm !== 'granted') return false;
      } catch {
        return false;
      }
    }

    this._onOrientation = (e) => {
      this.tilt.x = Math.max(-1, Math.min(1, (e.gamma || 0) / 30));
      this.tilt.y = Math.max(-1, Math.min(1, ((e.beta || 45) - 45) / 30));
    };
    window.addEventListener('deviceorientation', this._onOrientation, { passive: true });
    return true;
  }

  bindLifecycle() {
    this._onResize = () => {
      if (!this.renderer || !this.camera || !this.mountEl) return;
      const w = Math.max(200, this.mountEl.clientWidth);
      const h = Math.max(160, this.mountEl.clientHeight);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    };
    window.addEventListener('resize', this._onResize, { passive: true });

    this._onPointer = (e) => {
      this.pointer.x = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
      this.pointer.y = (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1;
    };
    window.addEventListener('pointermove', this._onPointer, { passive: true });

    this._onTheme = () => this.updateThemeColors();
    window.addEventListener('talkledger:themechange', this._onTheme);

    this._onVisibility = () => {
      if (document.hidden) this.pauseLoop();
      else if (this.inViewport) this.startLoop();
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver(
        (entries) => {
          this.inViewport = Boolean(entries[0]?.isIntersecting);
          if (!this.inViewport) this.pauseLoop();
          else if (!document.hidden) this.startLoop();
        },
        { threshold: 0.05 }
      );
      this.observer.observe(this.mountEl);
    }
  }

  startLoop() {
    if (this.running || this.disposed || this.fallbackActive || !this.renderer) return;
    this.running = true;
    let lastTs = performance.now();
    let elapsed = 0;

    const frame = (ts) => {
      if (!this.running || this.disposed) return;
      const dt = Math.min(0.1, (ts - lastTs) / 1000);
      lastTs = ts;
      elapsed += dt;

      // Monitor sustained low FPS (< 24fps for 3 seconds -> drop to static SVG fallback)
      if (dt > 1 / 24) {
        if (this.lowFpsStart === null) this.lowFpsStart = ts;
        else if (ts - this.lowFpsStart > 3000) {
          this.activateStaticFallback('low-fps');
          return;
        }
      } else {
        this.lowFpsStart = null;
      }

      this.stepAnimation(elapsed, dt);
      this.renderer.render(this.scene, this.camera);
      this.rafId = window.requestAnimationFrame(frame);
    };

    this.rafId = window.requestAnimationFrame(frame);
  }

  stepAnimation(t, dt) {
    const { root, bookGroup, coinPivot, coin, micPivot, micGroup, coverMat, micMat } = this.objects;
    if (!root) return;

    // Gentle float + mouse/tilt parallax
    const px = this.pointer.x * 0.22 + this.tilt.x * 0.24;
    const py = this.pointer.y * 0.14 + this.tilt.y * 0.16;
    root.position.y = Math.sin(t * 1.4) * 0.12;
    root.rotation.y += (px - root.rotation.y) * Math.min(1, dt * 4);
    root.rotation.x += (py - root.rotation.x) * Math.min(1, dt * 4);

    // Book rotation & typing lean
    const targetLeanY = this.state === 'typing' ? 0.34 : Math.sin(t * 0.6) * 0.22;
    const targetLeanZ = this.state === 'typing' ? -0.09 : Math.cos(t * 0.5) * 0.04;
    bookGroup.rotation.y += (targetLeanY - bookGroup.rotation.y) * Math.min(1, dt * 5);
    bookGroup.rotation.z += (targetLeanZ - bookGroup.rotation.z) * Math.min(1, dt * 5);

    // Error horizontal shake + crimson emissive tint
    if (this.errorShakeTimer > 0) {
      this.errorShakeTimer = Math.max(0, this.errorShakeTimer - dt);
      bookGroup.position.x = Math.sin(this.errorShakeTimer * 44) * 0.22 * this.errorShakeTimer;
      coverMat.emissive.set('#991B1B');
      coverMat.emissiveIntensity = 0.45 * this.errorShakeTimer;
    } else {
      bookGroup.position.x *= 0.85;
      coverMat.emissiveIntensity = 0;
    }

    // Coin orbit / fast processing spin / success landing
    if (this.state === 'processing') {
      coinPivot.rotation.y += dt * 3.8;
      coin.rotation.y += dt * 11.0;
    } else if (this.state === 'success' && this.successTimer > 0) {
      this.successTimer = Math.max(0, this.successTimer - dt);
      coin.position.x += (0.05 - coin.position.x) * Math.min(1, dt * 6);
      coin.position.y += (0.18 - coin.position.y) * Math.min(1, dt * 6);
      coin.position.z += (0.38 - coin.position.z) * Math.min(1, dt * 6);
    } else {
      coinPivot.rotation.y += dt * 0.55;
      coin.rotation.y += dt * 1.4;
      coin.position.x += (1.95 - coin.position.x) * Math.min(1, dt * 3);
      coin.position.y += (0.55 + Math.sin(t * 2) * 0.14 - coin.position.y) * Math.min(1, dt * 3);
      coin.position.z += (0.4 - coin.position.z) * Math.min(1, dt * 3);
    }

    // Microphone orbit + listening pulse scaled by live AnalyserNode micVolume
    micPivot.rotation.y -= dt * 0.42;
    if (this.state === 'listening') {
      const pulse = 1 + 0.18 * Math.sin(t * 9) + this.micVolume * 0.42;
      micGroup.scale.setScalar(pulse);
      micMat.emissive.set('#E6A825');
      micMat.emissiveIntensity = 0.35 + this.micVolume * 0.55;
    } else {
      micGroup.scale.lerp({ x: 1, y: 1, z: 1 }, Math.min(1, dt * 6));
      micMat.emissiveIntensity = 0;
    }

    // Confetti physics on success
    for (let i = this.confetti.length - 1; i >= 0; i -= 1) {
      const p = this.confetti[i];
      p.life -= dt;
      p.velocity.y -= dt * 0.26;
      p.mesh.position.add(p.velocity);
      p.mesh.rotation.x += dt * 6;
      p.mesh.rotation.y += dt * 4;
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this.confetti.splice(i, 1);
      }
    }
  }

  pauseLoop() {
    this.running = false;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  disposeWebGLOnly() {
    this.pauseLoop();
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    }
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement?.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
    }
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.confetti = [];
  }

  dispose() {
    this.disposed = true;
    this.disposeWebGLOnly();
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('pointermove', this._onPointer);
    window.removeEventListener('talkledger:themechange', this._onTheme);
    window.removeEventListener('deviceorientation', this._onOrientation);
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}
