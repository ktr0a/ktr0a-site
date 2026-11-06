/* ═══════════════════════════════════════════════════════════════════════════
   agents.js: the swarm (SPEC §5): simulation + canvas rendering

   Each agent is a little coloured mouse-cursor arrow that flies around the page.
   Positions are in DOCUMENT coordinates (drawn at y - scrollY) so an agent
   working on a section scrolls with it. Goals may be fixed (viewport space), e.g.
   a nav link or the boot orbit; they are converted to document space per frame.

   Modes (set by the director, or by the swarm's own choreography):
     orbit   boot: circling one of two clusters around the centre logo tile
     free    ballistic flight with drag (the scatter burst)
     seek    fly to `goal` with arrival (task travel)
     hold    stick to `goal` tightly (working: typing, tracing a wireframe)
     wander  idle; small groups fly lined up behind a leader near the frontier
     depart  stream off toward the top-right, then die

   Rendering uses pre-rendered sprites (one per colour and glyph, glow baked in)
   drawn with a single setTransform each, so 40+ agents with trails stay cheap.
   ═══════════════════════════════════════════════════════════════════════════ */

export const PALETTE = ["#4cc9f0", "#f72585", "#ffd60a", "#9d6bff", "#2ee59d", "#ff8c42"];
export const QA_RED = "#ff3b3b";

// Classic pointer arrow, tip at (0,0), ~15 px tall.
const ARROW = [
  [0, 0],
  [0, 15.5],
  [3.9, 11.9],
  [6.6, 17.6],
  [9.1, 16.5],
  [6.5, 10.9],
  [11.6, 10.9],
];
// Rotation that turns the arrow's own heading (tip direction, up-left) into +x.
const ARROW_HEADING = Math.atan2(-11, -4.6);

const MAX_SPEED = 1600; // px per build-second
// + marks: short "++++++" rows behind fast agents (scatter, long flights), never page-wide debris
const MARK_LIFE = 0.38;
const MARK_SPACING = 14;
const MARK_SPEED = 900;
const MARK_MAX = 7; // per agent: only its newest marks stay
const BOOT_OFFSET = 190; // cluster centre distance from the logo tile (desktop)
const BOOT_SWAY = 60;
const TRAIL_SPACING = 7;
const TRAIL_LIFE = 0.16;
const RING_ALPHA = 0.42; // start screen: the waiting ring is see-through until the visitor presses start
const RING_SPEED = 0.85; // rad/s around the logo tile
const RING_LEAN = 0.38; // rad: tips point at the tile, leaning a little into the direction of travel

const rand = (a, b) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;

/** Cheap smooth 1D value noise in -1..1 (for the flight wobble). */
function noise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

/* ───────────────────────────── sprites ───────────────────────────── */

function makeSprite(w, h, dpr, ax, ay, paint) {
  const c = document.createElement("canvas");
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  paint(g);
  return { img: c, w, h, ax, ay };
}

function buildSprites(colors, dpr, scale) {
  const out = {};
  for (const color of colors) {
    const s = scale;
    const arrow = makeSprite(34 * s, 36 * s, dpr, 9 * s, 8 * s, (g) => {
      g.translate(9 * s, 8 * s);
      g.scale(s, s);
      g.beginPath();
      ARROW.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.shadowColor = color;
      g.shadowBlur = 7;
      g.fillStyle = color;
      g.fill();
      g.shadowBlur = 0;
      g.lineJoin = "round";
      g.lineWidth = 1;
      g.strokeStyle = shade(color, 0.5);
      g.stroke();
      // tiny highlight along the left edge for a glossy read
      g.beginPath();
      g.moveTo(1.2, 2.5);
      g.lineTo(1.2, 11.5);
      g.strokeStyle = "rgba(255,255,255,0.55)";
      g.stroke();
    });
    const ibeam = makeSprite(20 * s, 28 * s, dpr, 10 * s, 14 * s, (g) => {
      g.translate(10 * s, 14 * s);
      g.scale(s, s);
      g.shadowColor = color;
      g.shadowBlur = 6;
      g.strokeStyle = color;
      g.lineWidth = 1.8;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(-3.5, -8.5);
      g.quadraticCurveTo(0, -8, 0, -6);
      g.quadraticCurveTo(0, -8, 3.5, -8.5);
      g.moveTo(0, -6);
      g.lineTo(0, 6);
      g.moveTo(-3.5, 8.5);
      g.quadraticCurveTo(0, 8, 0, 6);
      g.quadraticCurveTo(0, 8, 3.5, 8.5);
      g.stroke();
    });
    const cross = makeSprite(26 * s, 26 * s, dpr, 13 * s, 13 * s, (g) => {
      g.translate(13 * s, 13 * s);
      g.scale(s, s);
      g.shadowColor = color;
      g.shadowBlur = 6;
      g.strokeStyle = color;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(-7, 0);
      g.lineTo(-2, 0);
      g.moveTo(2, 0);
      g.lineTo(7, 0);
      g.moveTo(0, -7);
      g.lineTo(0, -2);
      g.moveTo(0, 2);
      g.lineTo(0, 7);
      g.stroke();
      g.fillStyle = "#fff";
      g.fillRect(-0.75, -0.75, 1.5, 1.5);
    });
    const plus = makeSprite(12, 12, dpr, 6, 6, (g) => {
      g.translate(6, 6);
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(-3.5, 0);
      g.lineTo(3.5, 0);
      g.moveTo(0, -3.5);
      g.lineTo(0, 3.5);
      g.stroke();
    });
    out[color] = { arrow, ibeam, cross, plus };
  }
  return out;
}

/* ───────────────────────────── swarm ───────────────────────────── */

export function createSwarm({ scale = 1 } = {}) {
  let agents = [];
  let marks = []; // + crosshair marks dropped by fast agents
  let sprites = null;
  let dpr = 1;
  let vw = 0;
  let vh = 0;
  let nextId = 1;
  let colorCursor = Math.floor(Math.random() * PALETTE.length);
  let spawned = 0; // total ever spawned this run (for "Rebuilt by N agents")
  let boot = null; // { cx, cy } viewport centre of the orbit
  let ring = null; // start screen: { cx, cy, r } viewport centre and radius of the waiting ring
  const flock = new Map(); // leader id → wander goal state

  /** Viewport rectangle idle agents wander in (set by the director). */
  const idleArea = { x0: 0.12, y0: 0.18, x1: 0.88, y1: 0.78 }; // fractions of the viewport

  function ensureSprites() {
    if (!sprites) sprites = buildSprites([...PALETTE, QA_RED, "#ffffff"], dpr, scale);
  }

  function spawn({ x, y, vx = 0, vy = 0, color, qa = false, mode = "wander" } = {}) {
    const c = qa ? QA_RED : color || PALETTE[colorCursor++ % PALETTE.length];
    const a = {
      id: nextId++,
      color: c,
      qa,
      x,
      y,
      vx,
      vy,
      angle: 0,
      mode,
      goal: null,
      glyph: "arrow",
      arrived: false,
      task: null,
      trail: [],
      tx: x,
      ty: y,
      markAcc: 0,
      marks: [], // this agent's live + marks (oldest first)
      seed: Math.random() * 1000,
      speedMul: rand(0.85, 1.1),
      delay: 0,
      born: 0,
      dead: false,
      orbit: null,
      alpha: 1, // drawn opacity, eases toward alphaTo
      alphaTo: 1,
      ring: null, // { i, n } on the start screen's waiting ring
    };
    agents.push(a);
    spawned++;
    return a;
  }

  /** Spawns just outside a random viewport edge (or the given one), flying inward. */
  function spawnAtEdge(scrollY, opts = {}) {
    const edge = opts.edge || ["left", "right", "top", "bottom"][Math.floor(Math.random() * 4)];
    let x;
    let y;
    if (edge === "left" || edge === "right") {
      x = edge === "left" ? -24 : vw + 24;
      y = rand(0.15, 0.85) * vh;
    } else {
      x = rand(0.1, 0.9) * vw;
      y = edge === "top" ? -24 : vh + 24;
    }
    const dx = vw / 2 - x;
    const dy = vh / 2 - y;
    const d = Math.hypot(dx, dy) || 1;
    return spawn({ ...opts, x, y: y + scrollY, vx: (dx / d) * 700, vy: (dy / d) * 700 });
  }

  /* ── choreography ── */

  /**
   * Start screen: a see-through ring of cursors circles the logo tile, tips pointing at it, as if
   * they were waiting for the visitor to press it. startBoot() takes them over at full opacity.
   */
  function startRing(cx, cy, { n = 8, r = 58 } = {}) {
    ring = { cx, cy, r };
    for (let i = 0; i < n; i++) {
      const a = spawn({ x: cx, y: cy, mode: "ring" });
      a.ring = { i, n };
      a.alpha = 0;
      a.alphaTo = RING_ALPHA;
    }
  }

  /** The viewport changed while the ring waits (resize): keep it centred. */
  function moveRing(cx, cy) {
    if (ring) Object.assign(ring, { cx, cy });
  }

  /**
   * Boot: agents circle two loose clusters left and right of a viewport point; on portrait
   * screens the clusters sit above and below it, so both swarms stay fully on screen.
   */
  function startBoot(cx, cy) {
    const portrait = vh > vw * 1.15;
    const k = Math.max(0.5, Math.min(1, Math.min(vw, vh) / 760)); // cluster size follows the screen
    boot = {
      cx,
      cy,
      portrait,
      offset: portrait ? Math.min(BOOT_OFFSET, vh * 0.17) : Math.min(BOOT_OFFSET, vw * 0.27),
      sway: portrait ? Math.min(BOOT_SWAY, vw * 0.1) : BOOT_SWAY,
    };
    ring = null;
    agents.forEach((a, i) => {
      const side = i % 2 ? 1 : -1;
      a.mode = "orbit";
      a.ring = null;
      a.alphaTo = 1; // the waiting ring (if any) lights up as the boot takes it over
      a.orbit = {
        side,
        r: rand(26, 105) * k,
        squash: rand(0.55, 0.85),
        w: side * rand(1.5, 2.6),
        ph: rand(0, TAU),
      };
    });
  }

  /**
   * Scatter: the swarm bursts out, dropping + marks. Agents that already got a task (mode
   * "seek" with a goal) burst straight toward it; everyone else flies outward from the centre.
   */
  function scatter(scrollY) {
    const c = boot || { cx: vw / 2, cy: vh / 2 };
    for (const a of agents) {
      if (a.mode === "seek" && a.goal) {
        const g = goalDoc(a.goal, scrollY);
        const ang = Math.atan2(g.y - a.y, g.x - a.x) + rand(-0.3, 0.3);
        const sp = rand(1300, 1900);
        a.vx = Math.cos(ang) * sp;
        a.vy = Math.sin(ang) * sp;
        a.orbit = null;
        continue;
      }
      const dx = a.x - c.cx;
      const dy = a.y - scrollY - c.cy;
      const ang = Math.atan2(dy, dx) + rand(-0.5, 0.5);
      const sp = rand(1500, 2300);
      a.vx = Math.cos(ang) * sp;
      a.vy = Math.sin(ang) * sp * 0.85;
      a.mode = "free";
      a.freeUntil = rand(0.28, 0.42);
      a.orbit = null;
    }
    boot = null;
  }

  /** Final departure toward the top-right, staggered. */
  function departAll() {
    agents.forEach((a, i) => {
      if (a.dead) return;
      a.mode = "depart";
      a.task = null;
      a.glyph = "arrow";
      a.delay = i * 0.022 + rand(0, 0.08);
      a.goal = { x: vw + 90 + rand(0, 160), y: -90 - rand(0, 220), fixed: true };
    });
  }

  /* ── simulation ── */

  function steer(a, gx, gy, dt, maxSpeed, accel, wobble) {
    const dx = gx - a.x;
    const dy = gy - a.y;
    const dist = Math.hypot(dx, dy);
    // close enough: report arrival (the director switches to "hold", which glues the agent on)
    a.arrived = dist < 7 && Math.hypot(a.vx, a.vy) < 260;
    if (dist < 0.5) {
      a.vx = a.vy = 0;
      return;
    }
    const want = maxSpeed * Math.min(1, dist / 120);
    let tvx = (dx / dist) * want;
    let tvy = (dy / dist) * want;
    if (wobble && dist > 60) {
      const n = noise(a.seed + a.t * 1.7) * wobble * Math.min(1, dist / 300);
      tvx += (-dy / dist) * n;
      tvy += (dx / dist) * n;
    }
    let ax = tvx - a.vx;
    let ay = tvy - a.vy;
    const am = Math.hypot(ax, ay);
    const lim = accel * dt;
    if (am > lim) {
      ax = (ax / am) * lim;
      ay = (ay / am) * lim;
    }
    a.vx += ax;
    a.vy += ay;
    a.x += a.vx * dt;
    a.y += a.vy * dt;
  }

  function goalDoc(goal, scrollY) {
    return { x: goal.x, y: goal.fixed ? goal.y + scrollY : goal.y };
  }

  function stepAgent(a, dt, t, scrollY) {
    a.t = t;
    if (a.alpha !== a.alphaTo) {
      const k = 1 - Math.exp(-dt * 5);
      a.alpha += (a.alphaTo - a.alpha) * k;
      if (Math.abs(a.alphaTo - a.alpha) < 0.005) a.alpha = a.alphaTo;
    }
    switch (a.mode) {
      case "ring": {
        const R = ring || { cx: vw / 2, cy: vh / 2, r: 58 };
        const th = (a.ring ? (a.ring.i / a.ring.n) * TAU : 0) + RING_SPEED * t;
        const nx = R.cx + Math.cos(th) * R.r;
        const ny = scrollY + R.cy + Math.sin(th) * R.r;
        if (!a.ringPlaced) {
          a.ringPlaced = true;
          a.tx = nx; // no trail from the spawn point to the ring
          a.ty = ny;
        }
        a.x = nx;
        a.y = ny;
        a.vx = -Math.sin(th) * R.r * RING_SPEED;
        a.vy = Math.cos(th) * R.r * RING_SPEED;
        a.ringTh = th;
        break;
      }
      case "orbit": {
        const o = a.orbit;
        const c = boot || { cx: vw / 2, cy: vh / 2, portrait: false, offset: BOOT_OFFSET, sway: BOOT_SWAY };
        const rot = t * 0.55 + (o.side > 0 ? 0 : Math.PI);
        // the two cluster centres swing slowly around the tile (left/right, or above/below)
        const along = Math.cos(rot) * c.offset;
        const across = Math.sin(rot) * c.sway;
        const ccx = c.cx + (c.portrait ? across : along);
        const ccy = c.cy + (c.portrait ? along : across);
        const ph = o.ph + o.w * t;
        steer(a, ccx + Math.cos(ph) * o.r, scrollY + ccy + Math.sin(ph) * o.r * o.squash, dt, 900, 6000, 0);
        break;
      }
      case "free": {
        const drag = Math.exp(-dt * 2.4);
        a.vx *= drag;
        a.vy *= drag;
        a.x += a.vx * dt;
        a.y += a.vy * dt;
        a.freeUntil -= dt;
        if (a.freeUntil <= 0) a.mode = "wander";
        break;
      }
      case "seek":
      case "depart": {
        if (a.mode === "depart" && a.delay > 0) {
          a.delay -= dt;
          // drift while waiting so nobody freezes in place
          a.x += a.vx * dt;
          a.y += a.vy * dt;
          a.vx *= 0.9;
          a.vy *= 0.9;
          break;
        }
        if (!a.goal) break;
        const g = goalDoc(a.goal, scrollY);
        // Long trips (a task half a page away) dash: up to +60 % speed beyond ~450 px, easing back
        // to cruise speed as the agent closes in, so work that just became ready isn't left waiting.
        const far = a.mode === "seek" ? Math.min(0.6, Math.max(0, (Math.hypot(g.x - a.x, g.y - a.y) - 450) / 900)) : 0;
        steer(a, g.x, g.y, dt, MAX_SPEED * a.speedMul * (a.mode === "depart" ? 1.15 : 1 + far), 7000 + far * 5000, a.mode === "depart" ? 260 : 170);
        if (a.mode === "depart" && (a.x > vw + 40 || a.y < scrollY - 40)) a.dead = true;
        break;
      }
      case "hold": {
        if (!a.goal) break;
        const g = goalDoc(a.goal, scrollY);
        const k = 1 - Math.exp(-dt * 22);
        const nx = a.x + (g.x - a.x) * k;
        const ny = a.y + (g.y - a.y) * k;
        a.vx = (nx - a.x) / (dt || 1);
        a.vy = (ny - a.y) / (dt || 1);
        a.x = nx;
        a.y = ny;
        a.arrived = Math.hypot(g.x - a.x, g.y - a.y) < 3;
        break;
      }
      case "wander":
        // handled per flock in updateFlocks()
        break;
    }
  }

  /**
   * Idle agents form small groups (3–4) in id order. The first of each group is the
   * leader and drifts between random points of the idle area; the others line up
   * behind it, which reads as the reel's ▶▶▶▶ formations.
   */
  function updateFlocks(dt, t, scrollY) {
    const idle = agents.filter((a) => a.mode === "wander" && !a.dead);
    const size = 4;
    const alive = new Set();
    for (let i = 0; i < idle.length; i += size) {
      const leader = idle[i];
      alive.add(leader.id);
      let st = flock.get(leader.id);
      if (!st || t > st.until || st.reached) {
        st = {
          x: (idleArea.x0 + Math.random() * (idleArea.x1 - idleArea.x0)) * vw,
          y: (idleArea.y0 + Math.random() * (idleArea.y1 - idleArea.y0)) * vh,
          until: t + rand(0.9, 1.8),
          reached: false,
        };
        flock.set(leader.id, st);
      }
      steer(leader, st.x, st.y + scrollY, dt, 520, 2600, 220);
      if (leader.arrived || Math.hypot(st.x - leader.x, st.y + scrollY - leader.y) < 30) st.reached = true;
      const sp = Math.hypot(leader.vx, leader.vy) || 1;
      const hx = leader.vx / sp;
      const hy = leader.vy / sp;
      for (let j = 1; j < size && i + j < idle.length; j++) {
        const f = idle[i + j];
        const gap = 17 * j;
        steer(f, leader.x - hx * gap, leader.y - hy * gap, dt, 900, 5200, 0);
      }
    }
    for (const id of flock.keys()) if (!alive.has(id)) flock.delete(id);
  }

  function trailAndMarks(a, t) {
    if (a.mode === "ring") {
      // the waiting ring is slow and calm: crisp cursors, no ghost trail
      a.tx = a.x;
      a.ty = a.y;
      return;
    }
    const dx = a.x - a.tx;
    const dy = a.y - a.ty;
    const d = Math.hypot(dx, dy);
    if (d >= TRAIL_SPACING) {
      a.trail.push({ x: a.tx, y: a.ty, angle: a.angle, t });
      if (a.trail.length > 6) a.trail.shift();
      a.tx = a.x;
      a.ty = a.y;
    }
    const speed = Math.hypot(a.vx, a.vy);
    if (speed > MARK_SPEED && a.mode !== "hold") {
      a.markAcc += d;
      if (a.markAcc >= MARK_SPACING && marks.length < 400) {
        a.markAcc = 0;
        const m = { x: a.x, y: a.y, t, color: a.color, dead: false };
        marks.push(m);
        a.marks.push(m);
        if (a.marks.length > MARK_MAX) a.marks.shift().dead = true; // keep the row short
      }
    } else a.markAcc = 0;
  }

  function updateAngle(a, dt) {
    if (a.mode === "ring") {
      a.angle = a.ringTh + Math.PI - RING_LEAN - ARROW_HEADING;
      return;
    }
    const speed = Math.hypot(a.vx, a.vy);
    const target = speed > 160 ? Math.atan2(a.vy, a.vx) - ARROW_HEADING : 0;
    let diff = target - a.angle;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    a.angle += diff * Math.min(1, dt * 16);
  }

  function update(dt, t, scrollY) {
    // sub-step so 4x speed stays stable
    const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      const tt = t - dt + h * (s + 1);
      for (const a of agents) if (!a.dead) stepAgent(a, h, tt, scrollY);
      updateFlocks(h, tt, scrollY);
    }
    for (const a of agents) {
      if (a.dead) continue;
      updateAngle(a, dt);
      trailAndMarks(a, t);
    }
    agents = agents.filter((a) => !a.dead);
    if (marks.length) {
      marks = marks.filter((m) => !m.dead && t - m.t < MARK_LIFE);
      for (const a of agents) if (a.marks.length && t - a.marks[0].t >= MARK_LIFE) a.marks = a.marks.filter((m) => t - m.t < MARK_LIFE);
    }
  }

  /* ── rendering ── */

  function blit(ctx, sp, x, y, angle, alpha) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    ctx.globalAlpha = alpha;
    ctx.setTransform(dpr * c, dpr * s, -dpr * s, dpr * c, dpr * x, dpr * y);
    ctx.drawImage(sp.img, -sp.ax, -sp.ay, sp.w, sp.h);
  }

  function draw(ctx, t, scrollY) {
    ensureSprites();
    for (const m of marks) {
      const y = m.y - scrollY;
      if (y < -10 || y > vh + 10) continue;
      const age = (t - m.t) / MARK_LIFE;
      blit(ctx, sprites[m.color].plus, m.x, y, 0, 0.9 * (1 - age) * (1 - age));
    }
    for (const a of agents) {
      const y = a.y - scrollY;
      if (y < -60 || y > vh + 60 || a.x < -60 || a.x > vw + 60) continue;
      const sp = sprites[a.color];
      const speed = Math.hypot(a.vx, a.vy);
      // trail: fading copies at recent positions (only visible while moving)
      for (let i = 0; i < a.trail.length; i++) {
        const tr = a.trail[i];
        const age = (t - tr.t) / TRAIL_LIFE;
        if (age >= 1) continue;
        const alpha = (1 - age) * 0.5 * ((i + 1) / a.trail.length) * a.alpha;
        blit(ctx, sp.arrow, tr.x, tr.y - scrollY, tr.angle, alpha);
      }
      const glyph = speed > 420 ? "arrow" : a.glyph;
      if (glyph === "arrow") blit(ctx, sp.arrow, a.x, y, a.angle, a.alpha);
      else blit(ctx, sp[glyph], a.x, y, 0, a.alpha);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
  }

  return {
    PALETTE,
    idleArea,
    spawn,
    spawnAtEdge,
    startRing,
    moveRing,
    startBoot,
    scatter,
    departAll,
    update,
    draw,
    resize(width, height, ratio) {
      vw = width;
      vh = height;
      if (ratio !== dpr) sprites = null;
      dpr = ratio;
    },
    clear() {
      agents = [];
      marks = [];
      flock.clear();
      spawned = 0;
      boot = null;
      ring = null;
    },
    /** A new run's clock starts at 0: drop trails and + marks stamped with the old clock. */
    resetClock() {
      marks = [];
      for (const a of agents) {
        a.trail = [];
        a.marks = [];
      }
    },
    /** Agents still on screen and not leaving. */
    get count() {
      let n = 0;
      for (const a of agents) if (a.mode !== "depart") n++;
      return n;
    },
    get spawned() {
      return spawned;
    },
    get agents() {
      return agents;
    },
    /** True while anything (agents or fading marks) is still visible. */
    get busy() {
      return agents.length > 0 || marks.length > 0;
    },
  };
}
