/**
 * hero3d.js: the hero sculpture (three.js r169, loaded lazily through the import map).
 *
 * A glossy electric-blue ribbon knot (a twisted, flattened sweep along a closed trefoil-like curve)
 * with warm amber orbs gliding along it like packets on a loop. Physical material + PMREM room
 * reflections, key/rim lights, ACES tone mapping and a subtle bloom that mostly catches the orbs.
 *
 *   export async function mountHero3D(container, { animate = true } = {}) → { setAnimate(bool), dispose() }
 *
 * Contract (SPEC §7):
 *  - Never throws. If WebGL2 / the CDN / anything else fails, the container's `.hero3d-fallback`
 *    stays visible, a console.warn is logged and a no-op handle is returned.
 *  - Adds `is-ready` to the container after the first frame was rendered (CSS may fade the fallback).
 *  - Canvas is aria-hidden, pointer-events:none and sized to the container (ResizeObserver).
 *  - Renders only while animating AND on screen (IntersectionObserver) AND the tab is visible.
 *  - DPR ≤ 2 (≤ 1.5 on small / coarse-pointer devices); frame rate capped to ~60 fps.
 *  - setAnimate(false) renders one still frame and stops the loop; dispose() frees GPU resources.
 *
 * Transparency + bloom: UnrealBloomPass normally blends additively over its input *including alpha*,
 * which turns a transparent canvas into a black box. We disable that internal blend and composite
 * ourselves (see COMPOSITE_FRAG): the surface keeps its own alpha and the glow is written as a valid
 * premultiplied layer whose alpha equals its brightness, so it adds light over the page background.
 */

/* ── tunables ─────────────────────────────────────────────────────────────────────────────── */

const COLORS = {
  ribbon: 0x1a72ff,      // electric blue, nudged toward cyan so ACES doesn't drift it to violet
  ribbonCore: 0x0b3fd0,  // faint self-light so shadowed sides stay saturated blue, not black
  orb: 0xffb814,         // saturated gold body
  orbGlow: 0xffa000,     // amber emission (ACES pushes the hot core toward yellow)
  orbLight: 0xff9a1f,
  key: 0xffffff,
  rimCool: 0x58a0ff,
  rimWarm: 0xffbf6e,
};

const KNOT = {
  scale: 0.42,           // overall size of the trefoil
  stretchY: 1.2,         // slightly vertical composition
  depth: 1.15,           // z amplitude of the over/under crossings
  width: 0.27,           // ribbon half-width
  thickness: 0.095,      // ribbon half-thickness
  squareness: 2.7,       // superellipse exponent of the cross-section (2 = ellipse)
  twistHalfTurns: 5,     // half-turns of the band over one loop (odd → a Möbius-like turn)
};

const ORBS = { count: 6, radius: 0.205, speed: 0.026 /* loops per second */ };

const BLOOM = { strength: 0.75, radius: 0.0, threshold: 0.48, gain: 1.0 };

const ENV_WALL = 0.05; // albedo of RoomEnvironment's walls/boxes before PMREM (1 = stock)

const MIN_FRAME_MS = 1000 / 66; // cap rendering at ~60 fps on high-refresh displays

/* ── public API ───────────────────────────────────────────────────────────────────────────── */

const NOOP_HANDLE = Object.freeze({ setAnimate() {}, dispose() {} });

export async function mountHero3D(container, { animate = true } = {}) {
  if (!container || typeof window === 'undefined') return NOOP_HANDLE;

  // Create the context ourselves: lets us bail out quietly (three logs console.error on failure).
  const canvas = document.createElement('canvas');
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,          // MSAA happens in our own render target
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
    });
  } catch (_) { gl = null; }
  if (!gl) {
    console.warn('[hero3d] WebGL2 is not available; keeping the static fallback.');
    return NOOP_HANDLE;
  }

  let mods;
  try {
    mods = await Promise.all([
      import('three'),
      import('three/addons/environments/RoomEnvironment.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
      import('three/addons/postprocessing/Pass.js'),
    ]);
  } catch (err) {
    releaseContext(gl);
    console.warn('[hero3d] could not load three.js; keeping the static fallback.', err);
    return NOOP_HANDLE;
  }

  const cleanups = []; // teardown steps registered by createHero, run in reverse order
  try {
    return await createHero(mods, container, canvas, gl, animate, cleanups);
  } catch (err) {
    runCleanups(cleanups);
    canvas.remove();
    releaseContext(gl);
    container.classList.remove('is-ready');
    console.warn('[hero3d] failed to initialise; keeping the static fallback.', err);
    return NOOP_HANDLE;
  }
}

/* ── implementation ───────────────────────────────────────────────────────────────────────── */

async function createHero(mods, container, canvas, gl, animateInitially, cleanups) {
  const [THREE, { RoomEnvironment }, { UnrealBloomPass }, { FullScreenQuad }] = mods;
  const small = matchMedia('(max-width: 640px), (pointer: coarse)').matches;
  const finePointer = matchMedia('(pointer: fine)').matches;
  // Quality tier: lighter mesh, fewer orb lights and a lower DPR cap on phones / tablets.
  const Q = small
    ? { tubular: 300, radial: 28, orbSegments: 24, orbLights: 3, maxDpr: 1.5 }
    : { tubular: 520, radial: 40, orbSegments: 36, orbLights: ORBS.count, maxDpr: 2 };

  const state = {
    animate: !!animateInitially,
    inView: true,
    pageVisible: !document.hidden,
    contextLost: false,
    contextRestored: false,
    disposed: false,
    width: 0, height: 0, dpr: 0,
    readyFlagged: false,
  };

  /* renderer ------------------------------------------------------------------------------- */

  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, alpha: true, premultipliedAlpha: true, antialias: false });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  canvas.setAttribute('aria-hidden', 'true');
  canvas.className = 'hero3d-canvas';
  Object.assign(canvas.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block',
    pointerEvents: 'none', opacity: '0', transition: 'opacity 700ms cubic-bezier(.2,.7,.2,1)',
  });
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

  const initialDpr = Math.min(window.devicePixelRatio || 1, Q.maxDpr);
  const sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,           // HDR, so the bloom threshold sees real highlight energy
    samples: initialDpr >= 1.75 ? 2 : 4, // MSAA (cheaper when the DPR already supersamples)
  });

  /* scene ---------------------------------------------------------------------------------- */

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  camera.position.set(0, 0, 10);

  let envTarget = null;
  const buildEnvironment = () => {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    // Studio-ise the room: dim the white walls/boxes so only its light panels stay bright. Broad
    // grey reflections would wash the saturated blue out to lavender; crisp panels read as gloss.
    room.traverse((o) => { if (o.isMesh && o.material?.isMeshStandardMaterial) o.material.color.setScalar(ENV_WALL); });
    envTarget = pmrem.fromScene(room, 0.04);
    room.dispose?.();
    pmrem.dispose();
    scene.environment = envTarget.texture;
  };
  buildEnvironment();
  scene.environmentIntensity = 1.0;

  // Lights: a soft key from upper-left-front, a cool rim from behind-left and a warm rim from
  // behind-right that echoes the orbs. The orbs also carry small point lights (warm spill).
  const key = new THREE.DirectionalLight(COLORS.key, 0.9);
  key.position.set(-2.5, 3.5, 5);
  const rimCool = new THREE.DirectionalLight(COLORS.rimCool, 2.2);
  rimCool.position.set(-4, 2.5, -5);
  const rimWarm = new THREE.DirectionalLight(COLORS.rimWarm, 1.2);
  rimWarm.position.set(4.5, -1.5, -3.5);
  scene.add(key, rimCool, rimWarm);

  // Hierarchy: root (float + pointer parallax) → spin (idle motion) → pose (static tilt) → meshes.
  const root = new THREE.Group();
  const spin = new THREE.Group();
  const pose = new THREE.Group();
  pose.rotation.set(-0.38, 0.0, 0.18);
  root.add(spin);
  spin.add(pose);
  scene.add(root);

  /* ribbon --------------------------------------------------------------------------------- */

  const curve = createTrefoilCurve(THREE);
  const ribbon = buildRibbon(THREE, curve, Q.tubular, Q.radial);

  const ribbonMaterial = new THREE.MeshPhysicalMaterial({
    color: COLORS.ribbon,
    emissive: COLORS.ribbonCore,
    emissiveIntensity: 0.12,
    metalness: 0.45,     // "candy paint": blue-tinted reflections under a clear lacquer
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
  });
  const ribbonMesh = new THREE.Mesh(ribbon.geometry, ribbonMaterial);
  pose.add(ribbonMesh);

  /* orbs ----------------------------------------------------------------------------------- */

  const orbGeometry = new THREE.SphereGeometry(1, Q.orbSegments, Math.round(Q.orbSegments * 0.75));
  const orbMaterial = new THREE.MeshPhysicalMaterial({
    color: COLORS.orb,
    emissive: COLORS.orbGlow,
    emissiveIntensity: 0.7,
    roughness: 0.28,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.1,
  });
  const orbs = [];
  for (let i = 0; i < ORBS.count; i++) {
    const mesh = new THREE.Mesh(orbGeometry, orbMaterial);
    // Slight size variety reads as more organic than identical beads.
    const r = ORBS.radius * (1 + 0.14 * Math.sin(i * 2.3 + 0.7));
    mesh.scale.setScalar(r);
    pose.add(mesh);
    let light = null;
    if (i < Q.orbLights) {
      light = new THREE.PointLight(COLORS.orbLight, 0.16, 1.4, 2);
      pose.add(light);
    }
    orbs.push({ mesh, light, r, phase: i / ORBS.count, wobble: i * 1.7 });
  }

  // Framing: fit the (rotation-invariant) bounding sphere into the view with a little room for glow.
  ribbon.geometry.computeBoundingSphere();
  const fitRadius = ribbon.geometry.boundingSphere.radius + ORBS.radius * 0.6;

  /* post-processing ------------------------------------------------------------------------ */

  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  // We composite the bloom ourselves (alpha-correct); stop the pass from blending into its input.
  bloom.blendMaterial.colorWrite = false;
  // Clamp HDR fireflies (tiny clearcoat glints) before they enter the mip chain, where single hot
  // texels otherwise turn into blocky squares. No-op if the shader text ever differs.
  const hp = bloom.materialHighPassFilter;
  hp.fragmentShader = hp.fragmentShader.replace(
    'vec4 texel = texture2D( tDiffuse, vUv );',
    'vec4 texel = texture2D( tDiffuse, vUv ); texel.rgb *= min( 1.0, 2.5 / max( max( texel.r, max( texel.g, texel.b ) ), 1e-4 ) );',
  );
  hp.needsUpdate = true;
  // Tighter falloff than the stock mip weights: a hot glow around the orbs, not a haze.
  bloom.compositeMaterial.uniforms.bloomFactors.value = [1.0, 0.75, 0.45, 0.2, 0.08];

  const compositeMaterial = new THREE.ShaderMaterial({
    name: 'Hero3DComposite',
    uniforms: {
      tScene: { value: sceneTarget.texture },
      tBloom: { value: bloom.renderTargetsHorizontal[0].texture },
      uBloomGain: { value: BLOOM.gain },
    },
    vertexShader: COMPOSITE_VERT,
    fragmentShader: COMPOSITE_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const compositeQuad = new FullScreenQuad(compositeMaterial);

  /* animation state ------------------------------------------------------------------------ */

  let simTime = 0;
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };     // target and smoothed parallax (-1..1)
  const tmpP = new THREE.Vector3();

  function update(dt) {
    const t = simTime;

    // Pointer parallax, frame-rate independent lerp.
    const k = 1 - Math.exp(-dt * 3.2);
    pointer.sx += (pointer.x - pointer.sx) * k;
    pointer.sy += (pointer.y - pointer.sy) * k;

    // Gentle float + parallax on the root, slow idle rotation on the spin group.
    root.position.y = Math.sin(t * 0.75) * 0.07;
    root.rotation.y = pointer.sx * 0.38;
    root.rotation.x = pointer.sy * 0.24;
    spin.rotation.z = t * 0.11;                       // the emblem turns slowly in its own plane
    spin.rotation.y = Math.sin(t * 0.23) * 0.5;       // and sways in depth so the crossings read
    spin.rotation.x = Math.sin(t * 0.17 + 1.1) * 0.16;

    // Orbs glide along the loop; a tiny per-orb surge keeps them from moving like a rigid chain.
    for (const o of orbs) {
      const u = fract(o.phase + t * ORBS.speed + 0.012 * Math.sin(t * 0.9 + o.wobble));
      ribbon.pointAt(u, tmpP);
      o.mesh.position.copy(tmpP);
      const pulse = 1 + 0.04 * Math.sin(t * 2.1 + o.wobble);
      o.mesh.scale.setScalar(o.r * pulse);
      if (o.light) o.light.position.copy(tmpP);
    }
    orbMaterial.emissiveIntensity = 0.7 + 0.07 * Math.sin(t * 1.3);
  }

  function render() {
    if (state.width === 0 || state.height === 0 || state.contextLost) return;
    renderer.setRenderTarget(sceneTarget);
    renderer.clear();
    renderer.render(scene, camera);
    bloom.render(renderer, null, sceneTarget, 0, false);
    compositeMaterial.uniforms.tBloom.value = bloom.renderTargetsHorizontal[0].texture;
    renderer.setRenderTarget(null);
    compositeQuad.render(renderer);

    if (!state.readyFlagged) {
      state.readyFlagged = true;
      canvas.style.opacity = '1';
      container.classList.add('is-ready');
    }
  }

  /* loop ----------------------------------------------------------------------------------- */

  let rafId = 0;
  let running = false;
  let lastFrame = 0;

  const shouldRun = () => state.animate && state.inView && state.pageVisible
    && !state.contextLost && !state.disposed && state.width > 0 && state.height > 0;

  function tick(now) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    const elapsed = now - lastFrame;
    if (elapsed < MIN_FRAME_MS) return;
    lastFrame = now;
    const dt = Math.min(elapsed / 1000, 0.1); // clamp so a long stall never jumps the motion
    simTime += dt;
    update(dt);
    render();
  }

  function syncLoop() {
    const want = shouldRun();
    if (want && !running) {
      running = true;
      lastFrame = performance.now() - MIN_FRAME_MS; // render on the very next frame
      rafId = requestAnimationFrame(tick);
    } else if (!want && running) {
      running = false;
      cancelAnimationFrame(rafId);
    }
  }

  function renderStill() {
    if (state.disposed) return;
    update(0);
    render();
  }

  /* sizing --------------------------------------------------------------------------------- */

  function resize() {
    if (state.disposed) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, Q.maxDpr);
    if (w === state.width && h === state.height && dpr === state.dpr) return;
    state.width = w; state.height = h; state.dpr = dpr;
    if (w === 0 || h === 0) { syncLoop(); return; }

    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    const pw = Math.max(1, Math.floor(w * dpr));
    const ph = Math.max(1, Math.floor(h * dpr));
    sceneTarget.setSize(pw, ph);
    bloom.setSize(pw, ph);

    // Fit the bounding sphere in both directions (whichever is tighter wins).
    camera.aspect = w / h;
    const vHalf = THREE.MathUtils.degToRad(camera.fov) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    const dist = fitRadius / Math.sin(Math.min(vHalf, hHalf));
    camera.position.set(0, 0, dist * 1.04);
    camera.near = Math.max(0.1, dist - fitRadius * 3);
    camera.far = dist + fitRadius * 3;
    camera.updateProjectionMatrix();

    if (!running) renderStill(); // keep a correct still frame when paused / not animating
    syncLoop();
  }

  const ro = new ResizeObserver(resize); // observed once the programs are compiled (below)
  cleanups.push(() => ro.disconnect());

  const onWindowResize = () => resize(); // catches DPR changes (zoom, moving between screens)
  window.addEventListener('resize', onWindowResize, { passive: true });
  cleanups.push(() => window.removeEventListener('resize', onWindowResize));

  /* visibility ----------------------------------------------------------------------------- */

  const io = new IntersectionObserver((entries) => {
    const entry = entries[entries.length - 1];
    state.inView = entry.isIntersecting;
    syncLoop();
  }, { rootMargin: '120px 0px' });
  cleanups.push(() => io.disconnect());

  const onVisibility = () => { state.pageVisible = !document.hidden; syncLoop(); };
  document.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

  /* pointer parallax (fine pointers only) -------------------------------------------------- */

  if (finePointer) {
    const onPointerMove = (e) => {
      if (e.pointerType === 'touch') return;
      // Viewport-relative: no layout reads, and the sculpture "looks" toward the cursor anywhere.
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    // Pointer left the window (no related target): ease back to the neutral pose.
    const onPointerOut = (e) => { if (!e.relatedTarget) { pointer.x = 0; pointer.y = 0; } };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerout', onPointerOut, { passive: true });
    cleanups.push(() => {
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerout', onPointerOut);
    });
  }

  /* context loss --------------------------------------------------------------------------- */

  const onContextLost = (e) => {
    e.preventDefault();
    state.contextLost = true;
    state.readyFlagged = false;
    canvas.style.opacity = '0';
    container.classList.remove('is-ready'); // let the CSS fallback show again
    syncLoop();
  };
  const onContextRestored = () => {
    state.contextLost = false;
    state.contextRestored = true;
    try {
      // The PMREM output lived only in the lost context. Drop it without dispose(): its GL handles
      // belong to the dead context and deleting them would only raise WebGL warnings.
      envTarget = null;
      buildEnvironment();
      renderStill();
      syncLoop();
    } catch (err) {
      console.warn('[hero3d] could not restore the WebGL context.', err);
    }
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  cleanups.push(() => {
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
  });

  /* GPU teardown --------------------------------------------------------------------------- */

  cleanups.unshift(() => {
    // Registered first → runs last. After a context restore, three's pre-loss bookkeeping still
    // listens on these objects and would try to delete dead handles (WebGL warnings); losing the
    // context below frees every GPU allocation anyway, so per-object disposal is skipped then.
    if (!state.contextRestored) {
      ribbon.geometry.dispose();
      ribbonMaterial.dispose();
      orbGeometry.dispose();
      orbMaterial.dispose();
      envTarget?.dispose();
      sceneTarget.dispose();
      bloom.dispose();
      compositeMaterial.dispose();
      compositeQuad.dispose();
    }
    renderer.dispose();                                    // drops three's context listeners first…
    if (!state.contextLost) renderer.forceContextLoss();   // …so releasing the context stays silent
    canvas.remove();
  });

  /* first frame ---------------------------------------------------------------------------- */

  container.appendChild(canvas);

  // Compile the scene's programs for the render target they will draw into (no tone mapping),
  // without blocking the main thread where KHR_parallel_shader_compile is available.
  renderer.setRenderTarget(sceneTarget);
  try {
    if (renderer.extensions.has('KHR_parallel_shader_compile')) await renderer.compileAsync(scene, camera);
    else renderer.compile(scene, camera);
  } finally {
    renderer.setRenderTarget(null);
  }

  resize();     // sizes everything and renders a still frame (marks is-ready)
  ro.observe(container);
  io.observe(container);
  syncLoop();

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    running = false;
    cancelAnimationFrame(rafId);
    container.classList.remove('is-ready');
    runCleanups(cleanups);
  }

  return {
    setAnimate(on) {
      if (state.disposed) return;
      on = !!on;
      if (on === state.animate) return;
      state.animate = on;
      if (!on) {
        running = false;
        cancelAnimationFrame(rafId);
        renderStill(); // one crisp still of the current pose
      }
      syncLoop();
    },
    dispose,
  };
}

/* ── geometry ─────────────────────────────────────────────────────────────────────────────── */

/** Closed trefoil, slightly stretched vertically, with deeper over/under crossings. */
function createTrefoilCurve(THREE) {
  class Trefoil extends THREE.Curve {
    getPoint(t, target = new THREE.Vector3()) {
      const a = t * Math.PI * 2;
      const x = Math.sin(a) + 2 * Math.sin(2 * a);
      const y = Math.cos(a) - 2 * Math.cos(2 * a);
      const z = -Math.sin(3 * a);
      return target.set(x * KNOT.scale, y * KNOT.scale * KNOT.stretchY, z * KNOT.scale * KNOT.depth);
    }
  }
  const curve = new Trefoil();
  curve.arcLengthDivisions = 2000; // accurate getPointAt → even vertex spacing
  return curve;
}

/**
 * Sweeps a twisted superellipse cross-section along the closed curve. Rings wrap (no seam
 * vertices), so computeVertexNormals() yields perfectly smooth shading all the way round.
 * Returns the geometry plus pointAt(u, out): the centreline position at loop parameter u (cheap,
 * interpolated from the precomputed rings) for things that travel along the ribbon.
 */
function buildRibbon(THREE, curve, T, R) {
  if (R % 2) R += 1; // an odd half-twist reconnects ring T to ring 0 shifted by R/2
  const frames = curve.computeFrenetFrames(T, true);
  const P = [], A = [], B = [];         // per-ring centre, major axis, minor axis (T + 1 entries)
  const twist = KNOT.twistHalfTurns * Math.PI;

  for (let i = 0; i <= T; i++) {
    const u = i / T;
    const p = curve.getPointAt(u % 1);
    const n = frames.normals[i], b = frames.binormals[i];
    const ang = twist * u + 0.6;
    const c = Math.cos(ang), s = Math.sin(ang);
    P.push(p);
    A.push(new THREE.Vector3().addScaledVector(n, c).addScaledVector(b, s));
    B.push(new THREE.Vector3().addScaledVector(n, -s).addScaledVector(b, c));
  }

  // Ribbon width breathes along the loop: fuller on the outer lobes, tighter in the crossings.
  const widthAt = (u) => KNOT.width * (0.82 + 0.18 * Math.cos(u * Math.PI * 6));

  const positions = new Float32Array(T * R * 3);
  const e = 2 / KNOT.squareness;
  const ring = new Array(R);
  for (let j = 0; j < R; j++) {
    const v = (j / R) * Math.PI * 2;
    const cv = Math.cos(v), sv = Math.sin(v);
    ring[j] = [Math.sign(cv) * Math.abs(cv) ** e, Math.sign(sv) * Math.abs(sv) ** e];
  }
  let k = 0;
  for (let i = 0; i < T; i++) {
    const w = widthAt(i / T), h = KNOT.thickness;
    const p = P[i], a = A[i], b = B[i];
    for (let j = 0; j < R; j++) {
      const x = ring[j][0] * w, y = ring[j][1] * h;
      positions[k++] = p.x + a.x * x + b.x * y;
      positions[k++] = p.y + a.y * x + b.y * y;
      positions[k++] = p.z + a.z * x + b.z * y;
    }
  }

  const shift = KNOT.twistHalfTurns % 2 ? R / 2 : 0;
  const index = new (T * R > 65535 ? Uint32Array : Uint16Array)(T * R * 6);
  k = 0;
  for (let i = 0; i < T; i++) {
    const last = i === T - 1;
    const i2 = last ? 0 : i + 1;
    for (let j = 0; j < R; j++) {
      const j1 = (j + 1) % R;
      const a = i * R + j;
      const b = i * R + j1;
      const c = i2 * R + (last ? (j + shift) % R : j);
      const d = i2 * R + (last ? (j1 + shift) % R : j1);
      index[k++] = a; index[k++] = c; index[k++] = b;
      index[k++] = b; index[k++] = c; index[k++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();

  function pointAt(u, out) {
    const f = fract(u) * T;
    const i = Math.min(Math.floor(f), T - 1);
    return out.lerpVectors(P[i], P[i + 1], f - i);
  }

  return { geometry, pointAt };
}

/* ── shaders ──────────────────────────────────────────────────────────────────────────────── */

const COMPOSITE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// toneMapping() and linearToOutputTexel() are injected by three because this ShaderMaterial
// renders to the screen with renderer.toneMapping = ACES and outputColorSpace = sRGB.
const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uBloomGain;
  varying vec2 vUv;

  vec3 toDisplay(vec3 c) {
    #ifdef TONE_MAPPING
      c = toneMapping(c);
    #endif
    return linearToOutputTexel(vec4(c, 1.0)).rgb;
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec4 base = texture2D(tScene, vUv);           // linear HDR, premultiplied (transparent clear)
    // Bloom, faded out toward the canvas border so the halo never ends in a visible edge.
    float edge = 1.0 - smoothstep(0.7, 1.0, length(vUv - 0.5) * 2.0);
    vec3 glowLin = texture2D(tBloom, vUv).rgb * uBloomGain * edge;

    float a = clamp(base.a, 0.0, 1.0);
    vec3 surface = a > 1e-4 ? base.rgb / a : vec3(0.0);
    vec3 lit = toDisplay(surface + glowLin);       // the sculpture itself, with its bloom on top

    // Glow-only layer: dithered against 8-bit banding, alpha = brightness → valid premultiplied
    // colour that composites (almost exactly additively) over the dark page background.
    vec3 glow = max(toDisplay(glowLin) + (hash12(gl_FragCoord.xy) - 0.5) / 255.0, 0.0);
    float glowA = min(max(glow.r, max(glow.g, glow.b)), 1.0);

    gl_FragColor = vec4(lit * a + glow * (1.0 - a), a + glowA * (1.0 - a));
  }
`;

/* ── helpers ──────────────────────────────────────────────────────────────────────────────── */

function fract(x) { return x - Math.floor(x); }

function runCleanups(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    try { steps[i](); } catch (err) { console.warn('[hero3d] cleanup step failed.', err); }
  }
  steps.length = 0;
}

function releaseContext(gl) {
  try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) { /* ignore */ }
}
