/**
 * Voice Khata — Aurora AI 3D Animated Auth Scene (public/src/auth-scene.js)
 * - Immediately launches zero-dependency WebGL Aurora 3D Silk Shader background.
 * - Lazily loads Three.js v0.169.0 to render an interactive 3D Aurora Constellation:
 *   floating Ledger Book + iridescent Geodesic Aurora Core + 3 counter-rotating luminous
 *   orbital rings + orbiting Microphone & Rupee Coin + 90 floating luminescent particles
 *   + dynamic cyan/violet/marigold aurora point lights.
 * - If Three.js CDN is offline, seamlessly upgrades to a live 60fps 2D/3D Canvas Aurora
 *   Orbital Core so the login screen stays vivid & animated everywhere.
 * - Full safeguards: prefers-reduced-motion static SVG, DPR <= 2, offscreen/tab pause, full dispose().
 */

import { Aurora3DEngine } from './aurora-3d.js';

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
    this.errorShakeTimer = 0;
    this.successTimer = 0;
    this.fallbackActive = false;
    this.auroraBg = null;
    this.canvasFallbackRaf = null;

    this.reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  async init() {
    if (!this.mountEl || this.disposed) return;

    // 1. Mount full-pane WebGL Aurora Silk Shader behind the 3D scene immediately
    const pane = this.mountEl.closest('.auth-scene-pane');
    if (pane) {
      let bgCanvas = pane.querySelector('.auth-aurora-bg-canvas');
      if (!bgCanvas) {
        bgCanvas = document.createElement('canvas');
        bgCanvas.className = 'auth-aurora-bg-canvas';
        bgCanvas.setAttribute('aria-hidden', 'true');
        pane.prepend(bgCanvas);
      }
      this.auroraBg = new Aurora3DEngine(bgCanvas, { mode: 'auth' });
      this.auroraBg.init();
      this.auroraBg.setState(this.state);
    }

    // 2. Respect prefers-reduced-motion cleanly
    if (this.reducedMotion) {
      this.activateStaticFallback('reduced-motion');
      return;
    }

    // 3. Start animated Canvas Aurora Orb immediately while Three.js streams in
    this.startCanvasOrbFallback('loading');

    const lowMem = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 2;
    if (lowMem || !isWebGLSupported()) {
      return;
    }

    try {
      this.THREE = await import(THREE_CDN_URL);
      if (this.disposed) return;
      this.stopCanvasOrbFallback();
      this.buildScene();
      this.bindLifecycle();
      this.startLoop();
    } catch {
      // Keep the smooth zero-dependency animated Canvas Aurora Orb running!
    }
  }

  startCanvasOrbFallback(reason = 'canvas-aurora') {
    if (!this.mountEl || this.disposed) return;
    this.mountEl.dataset.fallback = reason;
    this.mountEl.innerHTML = '';

    const canvas = document.createElement('canvas');
    canvas.className = 'auth-orb-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    this.mountEl.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const t0 = performance.now();

    const draw = (now) => {
      if (this.disposed || this.renderer) return;
      const rect = this.mountEl.getBoundingClientRect();
      const w = Math.max(220, rect.width || 360);
      const h = Math.max(200, rect.height || 300);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const t = (now - t0) * 0.001;
      const cx = w * 0.5 + this.pointer.x * 16;
      const cy = h * 0.5 + this.pointer.y * 12;
      const pulse = 1 + this.micVolume * 0.25 + (this.state === 'processing' ? 0.08 * Math.sin(t * 8) : 0);
      const baseR = Math.min(w, h) * 0.24 * pulse;

      // Volumetric aurora orb core
      const coreGrad = ctx.createRadialGradient(
        cx - baseR * 0.25,
        cy - baseR * 0.28,
        baseR * 0.1,
        cx,
        cy,
        baseR * 1.45
      );
      if (this.state === 'success') {
        coreGrad.addColorStop(0, 'rgba(245, 245, 240, 0.95)');
        coreGrad.addColorStop(0.38, 'rgba(74, 222, 128, 0.72)');
        coreGrad.addColorStop(0.75, 'rgba(201, 169, 97, 0.36)');
        coreGrad.addColorStop(1, 'rgba(74, 222, 128, 0)');
      } else if (this.state === 'error') {
        coreGrad.addColorStop(0, 'rgba(245, 245, 240, 0.92)');
        coreGrad.addColorStop(0.42, 'rgba(248, 113, 113, 0.78)');
        coreGrad.addColorStop(1, 'rgba(248, 113, 113, 0)');
      } else {
        coreGrad.addColorStop(0, 'rgba(245, 245, 240, 0.96)');
        coreGrad.addColorStop(0.32, 'rgba(232, 213, 163, 0.88)');
        coreGrad.addColorStop(0.65, 'rgba(201, 169, 97, 0.56)');
        coreGrad.addColorStop(1, 'rgba(168, 136, 63, 0)');
      }

      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR * 1.45, 0, Math.PI * 2);
      ctx.fill();

      // 3 Counter-rotating 3D-projected champagne-gold & ivory orbital rings
      const rings = [
        { rx: baseR * 1.65, ry: baseR * 0.62, rot: t * 0.55, color: 'rgba(232, 213, 163, 0.68)', lw: 1.8 },
        { rx: baseR * 1.42, ry: baseR * 0.56, rot: -t * 0.72 + 1.1, color: 'rgba(201, 169, 97, 0.62)', lw: 1.6 },
        { rx: baseR * 1.88, ry: baseR * 0.48, rot: t * 0.36 + 2.2, color: 'rgba(245, 245, 240, 0.34)', lw: 1.2 },
      ];
      for (const ring of rings) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(ring.rot);
        ctx.strokeStyle = ring.color;
        ctx.lineWidth = ring.lw;
        ctx.beginPath();
        ctx.ellipse(0, 0, ring.rx, ring.ry, 0, 0, Math.PI * 2);
        ctx.stroke();

        // Orbiting bright node on each ring
        const nodeAngle = t * 1.8 + ring.rot;
        const nx = Math.cos(nodeAngle) * ring.rx;
        const ny = Math.sin(nodeAngle) * ring.ry;
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = ring.color;
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(nx, ny, 4.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Crisp Rupee emblem at center
      ctx.fillStyle = 'rgba(19, 29, 51, 0.88)';
      ctx.font = `700 ${Math.round(baseR * 0.78)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('₹', cx, cy + 2);

      ctx.restore();
      this.canvasFallbackRaf = window.requestAnimationFrame(draw);
    };

    this.canvasFallbackRaf = window.requestAnimationFrame(draw);
  }

  stopCanvasOrbFallback() {
    if (this.canvasFallbackRaf !== null) {
      window.cancelAnimationFrame(this.canvasFallbackRaf);
      this.canvasFallbackRaf = null;
    }
  }

  activateStaticFallback(reason = 'static') {
    this.fallbackActive = true;
    this.stopCanvasOrbFallback();
    this.disposeWebGLOnly();
    if (!this.mountEl) return;
    this.mountEl.dataset.fallback = reason;
    this.mountEl.innerHTML = `
      <div class="auth-svg-fallback" aria-hidden="true">
        <svg viewBox="0 0 280 240" width="240" height="205" fill="none">
          <ellipse cx="140" cy="120" rx="96" ry="42" stroke="#C9A961" stroke-width="1.6" opacity="0.55"/>
          <ellipse cx="140" cy="120" rx="78" ry="62" stroke="#E8D5A3" stroke-width="1.4" opacity="0.45"/>
          <circle cx="140" cy="120" r="46" fill="url(#vkStaticAura)"/>
          <text x="140" y="132" text-anchor="middle" fill="#0B0F19" font-size="36" font-weight="700">₹</text>
          <defs>
            <radialGradient id="vkStaticAura" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(130 108) rotate(50) scale(60)">
              <stop stop-color="#F5F5F0"/>
              <stop offset="0.45" stop-color="#E8D5A3"/>
              <stop offset="1" stop-color="#C9A961"/>
            </radialGradient>
          </defs>
        </svg>
      </div>
    `;
  }

  buildScene() {
    const THREE = this.THREE;
    const width = Math.max(240, this.mountEl.clientWidth || 380);
    const height = Math.max(200, this.mountEl.clientHeight || 360);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 60);
    this.camera.position.set(0, 0.25, 6.6);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.mountEl.innerHTML = '';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.renderer.domElement.style.pointerEvents = 'none';
    this.mountEl.appendChild(this.renderer.domElement);

    // Luxury Gold & Ivory 3D Studio Lighting Rig
    const hemi = new THREE.HemisphereLight(0xfaf8f5, 0x0b0f19, 1.15);
    const cyanLight = new THREE.PointLight(0xe8d5a3, 4.2, 16);
    cyanLight.position.set(3.2, 2.4, 3.6);
    const violetLight = new THREE.PointLight(0xc9a961, 4.0, 16);
    violetLight.position.set(-3.4, -1.8, 3.2);
    const goldLight = new THREE.PointLight(0xf5f5f0, 3.0, 14);
    goldLight.position.set(0.4, 3.4, -2.2);
    this.scene.add(hemi, cyanLight, violetLight, goldLight);

    const root = new THREE.Group();
    this.scene.add(root);

    // 1. Luxury Gold & Midnight Navy Geodesic Core
    const auraCoreGroup = new THREE.Group();
    const innerOrbMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#C9A961'),
      emissive: new THREE.Color('#A8883F'),
      emissiveIntensity: 0.48,
      roughness: 0.18,
      metalness: 0.65,
      clearcoat: 1.0,
      clearcoatRoughness: 0.12,
    });
    const innerOrb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.95, 3), innerOrbMat);

    const wireMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#E8D5A3'),
      wireframe: true,
      transparent: true,
      opacity: 0.32,
    });
    const outerWire = new THREE.Mesh(new THREE.IcosahedronGeometry(1.22, 2), wireMat);

    // Floating midnight-navy & gold-embossed ledger inside the constellation
    const bookGroup = new THREE.Group();
    const coverMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#151C2C'),
      roughness: 0.34,
      metalness: 0.42,
      emissive: new THREE.Color('#0B0F19'),
      emissiveIntensity: 0.35,
    });
    const spineMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#A8883F'),
      roughness: 0.32,
      metalness: 0.62,
    });
    const goldMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#C9A961'),
      roughness: 0.24,
      metalness: 0.78,
      emissive: new THREE.Color('#A8883F'),
      emissiveIntensity: 0.24,
    });
    const bookBody = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.18, 0.2), coverMat);
    const bookSpine = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.2, 16), spineMat);
    bookSpine.position.x = -0.45;
    const bookEmblem = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.036, 12, 32), goldMat);
    bookEmblem.position.set(0.05, 0.05, 0.13);
    bookGroup.add(bookBody, bookSpine, bookEmblem);
    bookGroup.position.set(0, 0, 1.38);
    bookGroup.scale.setScalar(0.86);

    auraCoreGroup.add(innerOrb, outerWire);
    root.add(auraCoreGroup, bookGroup);

    // 2. Three Counter-Rotating Champagne Gold & Ivory Orbital Rings
    const ringMatA = new THREE.MeshStandardMaterial({
      color: 0xe8d5a3,
      emissive: 0xc9a961,
      emissiveIntensity: 0.65,
      roughness: 0.22,
      metalness: 0.72,
      transparent: true,
      opacity: 0.82,
    });
    const ringMatB = new THREE.MeshStandardMaterial({
      color: 0xc9a961,
      emissive: 0xa8883f,
      emissiveIntensity: 0.52,
      roughness: 0.28,
      metalness: 0.65,
      transparent: true,
      opacity: 0.68,
    });
    const ringMatC = new THREE.MeshStandardMaterial({
      color: 0xf5f5f0,
      emissive: 0xc9a961,
      emissiveIntensity: 0.35,
      roughness: 0.3,
      metalness: 0.5,
      transparent: true,
      opacity: 0.45,
    });

    const ringA = new THREE.Mesh(new THREE.TorusGeometry(1.78, 0.024, 16, 80), ringMatA);
    ringA.rotation.set(Math.PI * 0.36, 0.25, 0);
    const ringB = new THREE.Mesh(new THREE.TorusGeometry(2.08, 0.02, 16, 84), ringMatB);
    ringB.rotation.set(Math.PI * 0.62, -0.42, 0.3);
    const ringC = new THREE.Mesh(new THREE.TorusGeometry(2.36, 0.016, 14, 92), ringMatC);
    ringC.rotation.set(Math.PI * 0.22, 0.65, -0.4);
    root.add(ringA, ringB, ringC);

    // 3. Orbiting Gold Rupee Coin + Voice Mic Satellites
    const coinPivot = new THREE.Group();
    const coinGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.075, 28);
    coinGeo.rotateX(Math.PI / 2);
    const coin = new THREE.Mesh(coinGeo, goldMat.clone());
    coin.position.set(1.92, 0.62, 0.35);
    coinPivot.add(coin);
    root.add(coinPivot);

    const micPivot = new THREE.Group();
    const micGroup = new THREE.Group();
    const micMat = goldMat.clone();
    const micCapsule = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.3, 8, 16), micMat);
    const micStand = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 12), coverMat);
    micStand.position.y = -0.32;
    const micBase = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.05, 16), spineMat);
    micBase.position.y = -0.44;
    micGroup.add(micCapsule, micStand, micBase);
    micGroup.position.set(-1.86, -0.34, 0.45);
    micPivot.add(micGroup);
    root.add(micPivot);

    // 4. 90 Luminescent 3D Aurora Starfield Particles
    const particleCount = 90;
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const palette = [
      new THREE.Color('#E8D5A3'),
      new THREE.Color('#C9A961'),
      new THREE.Color('#F5F5F0'),
      new THREE.Color('#A8883F'),
    ];
    for (let i = 0; i < particleCount; i += 1) {
      const radius = 1.65 + Math.random() * 2.1;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = radius * Math.cos(phi);
      const col = palette[i % palette.length];
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    pGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const pMat = new THREE.PointsMaterial({
      size: 0.068,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const particles = new THREE.Points(pGeo, pMat);
    root.add(particles);

    this.objects = {
      root,
      auraCoreGroup,
      innerOrb,
      innerOrbMat,
      outerWire,
      wireMat,
      bookGroup,
      ringA,
      ringB,
      ringC,
      coinPivot,
      coin,
      micPivot,
      micGroup,
      particles,
      cyanLight,
      violetLight,
      goldLight,
      coverMat,
      spineMat,
      goldMat,
      micMat,
    };
  }

  updateThemeColors() {
    if (!this.THREE || !this.objects.coverMat) return;
    this.objects.coverMat.color.set(getCssColorHex('--bg-card', '#151C2C'));
    this.objects.spineMat.color.set(getCssColorHex('--gold-dark', '#A8883F'));
    this.objects.goldMat.color.set(getCssColorHex('--gold', '#C9A961'));
  }

  setState(nextState) {
    this.state = nextState;
    this.auroraBg?.setState(nextState);

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
      this.successTimer = 1.8;
      this.spawnConfetti();
    }
  }

  setMicVolume(vol) {
    this.micVolume = Math.max(0, Math.min(1, Number(vol) || 0));
    this.auroraBg?.setEnergy(this.micVolume);
  }

  spawnConfetti() {
    if (!this.THREE || !this.scene) return;
    const THREE = this.THREE;
    const palette = [0xe8d5a3, 0xc9a961, 0xf5f5f0, 0x4ade80];
    for (let i = 0; i < 32; i += 1) {
      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.065, 0),
        new THREE.MeshStandardMaterial({
          color: palette[i % palette.length],
          emissive: palette[i % palette.length],
          emissiveIntensity: 0.6,
          roughness: 0.3,
        })
      );
      mesh.position.set(0, 0.25, 0.6);
      const velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 0.18,
        0.06 + Math.random() * 0.12,
        (Math.random() - 0.5) * 0.14
      );
      this.scene.add(mesh);
      this.confetti.push({ mesh, velocity, life: 1.6 });
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
      const h = Math.max(180, this.mountEl.clientHeight);
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

      const {
        root,
        auraCoreGroup,
        innerOrb,
        innerOrbMat,
        outerWire,
        bookGroup,
        ringA,
        ringB,
        ringC,
        coinPivot,
        coin,
        micPivot,
        micGroup,
        particles,
        cyanLight,
        violetLight,
        goldLight,
        micMat,
      } = this.objects;

      const speedMult =
        this.state === 'processing'
          ? 2.8
          : this.state === 'listening'
          ? 1.9 + this.micVolume * 1.4
          : this.state === 'typing'
          ? 1.45
          : 1.0;

      // Smooth pointer + tilt parallax
      const targetRotY = (this.pointer.x * 0.36 + this.tilt.x * 0.32);
      const targetRotX = (this.pointer.y * 0.24 + this.tilt.y * 0.24);
      root.rotation.y += (targetRotY - root.rotation.y) * 0.06;
      root.rotation.x += (targetRotX - root.rotation.x) * 0.06;

      // Core aurora orb breathing + color pulse
      const breathe = 1 + Math.sin(elapsed * 2.1) * 0.05 + this.micVolume * 0.24;
      innerOrb.scale.setScalar(breathe);
      outerWire.scale.setScalar(1 + Math.cos(elapsed * 1.6) * 0.06 + this.micVolume * 0.32);
      auraCoreGroup.rotation.y += dt * 0.48 * speedMult;
      auraCoreGroup.rotation.x += dt * 0.24 * speedMult;
      outerWire.rotation.z -= dt * 0.35 * speedMult;

      // Dynamic state colors on core orb (restrained luxury palette)
      if (this.state === 'success') {
        innerOrbMat.color.lerp(new this.THREE.Color('#4ADE80'), 0.1);
        innerOrbMat.emissive.lerp(new this.THREE.Color('#4ADE80'), 0.08);
      } else if (this.state === 'error') {
        innerOrbMat.color.lerp(new this.THREE.Color('#F87171'), 0.14);
        innerOrbMat.emissive.lerp(new this.THREE.Color('#F87171'), 0.1);
      } else if (this.state === 'listening') {
        innerOrbMat.color.lerp(new this.THREE.Color('#E8D5A3'), 0.1);
        innerOrbMat.emissive.lerp(new this.THREE.Color('#C9A961'), 0.1);
      } else {
        innerOrbMat.color.lerp(new this.THREE.Color('#C9A961'), 0.05);
        innerOrbMat.emissive.lerp(new this.THREE.Color('#A8883F'), 0.05);
      }

      // Floating glass ledger gently bobs in front
      bookGroup.position.y = Math.sin(elapsed * 1.65) * 0.14;
      bookGroup.rotation.y = Math.sin(elapsed * 0.85) * 0.28;
      bookGroup.rotation.z = Math.cos(elapsed * 0.7) * 0.05;

      // Counter-rotating luminous orbital rings
      ringA.rotation.z += dt * 0.65 * speedMult;
      ringB.rotation.z -= dt * 0.52 * speedMult;
      ringC.rotation.y += dt * 0.38 * speedMult;

      // Satellites
      coinPivot.rotation.y += dt * 0.55 * speedMult;
      coin.rotation.y += dt * 1.8 * speedMult;
      coin.position.y = 0.55 + Math.sin(elapsed * 2.2) * 0.14;

      micPivot.rotation.y -= dt * 0.42 * speedMult;
      micGroup.position.y = -0.3 + Math.cos(elapsed * 2.0) * 0.14;
      const micScale = 1 + this.micVolume * 0.32;
      micGroup.scale.setScalar(micScale);
      micMat.emissiveIntensity = 0.28 + this.micVolume * 1.25;

      // Orbiting particles & lights
      particles.rotation.y += dt * 0.14 * speedMult;
      particles.rotation.x = Math.sin(elapsed * 0.3) * 0.18;

      cyanLight.position.x = Math.cos(elapsed * 0.7) * 3.6;
      cyanLight.position.y = Math.sin(elapsed * 0.9) * 2.4;
      violetLight.position.x = Math.sin(elapsed * 0.6) * -3.6;
      violetLight.position.y = Math.cos(elapsed * 0.8) * 2.2;
      goldLight.intensity = 3.2 + this.micVolume * 3.5;

      // Error shake recoil
      if (this.errorShakeTimer > 0) {
        this.errorShakeTimer = Math.max(0, this.errorShakeTimer - dt);
        root.position.x = Math.sin(this.errorShakeTimer * 44) * 0.18 * (this.errorShakeTimer / 0.55);
      } else {
        root.position.x = 0;
      }

      // Update success particle bursts
      for (let i = this.confetti.length - 1; i >= 0; i -= 1) {
        const c = this.confetti[i];
        c.life -= dt;
        c.velocity.y -= dt * 0.18;
        c.mesh.position.add(c.velocity);
        c.mesh.rotation.x += dt * 6;
        c.mesh.rotation.y += dt * 5;
        c.mesh.scale.setScalar(Math.max(0.01, c.life / 1.6));
        if (c.life <= 0) {
          this.scene.remove(c.mesh);
          c.mesh.geometry.dispose();
          c.mesh.material.dispose();
          this.confetti.splice(i, 1);
        }
      }

      this.renderer.render(this.scene, this.camera);
      this.rafId = window.requestAnimationFrame(frame);
    };

    this.rafId = window.requestAnimationFrame(frame);
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
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.scene = null;
    this.camera = null;
  }

  dispose() {
    this.disposed = true;
    this.stopCanvasOrbFallback();
    this.disposeWebGLOnly();
    if (this.auroraBg) {
      this.auroraBg.dispose();
      this.auroraBg = null;
    }
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this._onPointer) window.removeEventListener('pointermove', this._onPointer);
    if (this._onTheme) window.removeEventListener('talkledger:themechange', this._onTheme);
    if (this._onVisibility) document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._onOrientation) window.removeEventListener('deviceorientation', this._onOrientation);
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}
