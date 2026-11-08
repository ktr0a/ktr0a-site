/**
 * herograph.js: the hero "vault map" (plain Canvas 2D, no libraries).
 *
 * A quiet, blueprint-precise map of Uni OS, the plain-Markdown vault that a team of agents runs: a central
 * vault hub (crosshair, snapped onto the hero's 56 px grid), the four first-semester courses on an
 * orbit ring around it (each with a status pip and a fan of note leaves) and a small inbox near the
 * upper-right edge where notes come in. A few of the build's agent cursors keep working after the
 * build: carriers pick a note up at the inbox, take it through the vault to its course and file it
 * (a new leaf appears in their colour and settles to grey, the course's oldest leaf fades so the
 * count stays put, the course pip blinks green, the route they walked keeps a faint trace for a
 * moment); a coordinator makes slow rounds of the course hubs along the orbit ring. The inbox, the
 * vault and the link between them take one carrier at a time, and so does a course's spoke until
 * its carrier is back past the vault: the other waits where it is until its turn, so the two never
 * meet head-on on a line. Mostly monochrome: colour only comes from agents, their traces and
 * status pips.
 *
 *   export async function mountHeroGraph(container, { animate = true } = {}) → { setAnimate(bool), dispose() }
 *
 * Contract:
 *  - Never throws. On any failure it logs a console.warn and returns a frozen no-op handle (the
 *    visual area simply stays empty).
 *  - The canvas is aria-hidden and pointer-events:none, sized to the container (ResizeObserver).
 *  - Renders only while animating AND on screen (IntersectionObserver) AND the tab is visible AND the
 *    hero layer is revealed; paced to ~60 fps on any refresh rate; the backing store follows the
 *    screen's DPR up to 3 (2 for a canvas past ~2.4 M device px), DPR changes are caught (zoom,
 *    moving between screens).
 *  - Deterministic: a seeded PRNG drives the layout and the choreography, so every visit starts
 *    from the same picture.
 *  - Grows in (vault, links, courses, leaves, inbox, agents) when the build reveals the hero layer
 *    (`is-built` on the closest [data-layer]); a short grow when there is no build (or after a skip).
 *  - setAnimate(false) parks every agent at a node and renders one complete still (with the name of
 *    the note that was filed last beside its leaf); true resumes.
 *  - The layout is fitted per size so no node, label or parked agent sits under the facts panel
 *    (.hero-now) that overlaps the visual; only faint links may pass under the glass.
 *  - Debug only (localStorage ktr0a:debug = "1" or ?debug in the URL): window.__heroGraphStats =
 *    { frames, drawMsTotal, drawMsMax, agents, layout }, removed again by dispose().
 */

import { ARROW, PALETTE } from "./build/agents.js";

const NOOP_HANDLE = Object.freeze({ setAnimate() {}, dispose() {} });

/* ── layout (design px: 1 unit = 1 px on the 460 px desktop square) ──────────────────────────── */

const DESIGN = 460;
const RING = 126;                 // the course hubs' orbit radius around the vault
const SLOTS = 6;                  // leaf slots per course: five hold a note, one is the next free spot
const LEAF_DIST = [35, 43];       // leaf distance from its hub, alternating (a slight zigzag fan)
const GRID = 56;                  // the hero's blueprint grid (style.css .hero::before)
const SEED = 0x6b747230;          // "ktr0"

// ang: place on the orbit (deg, screen space: 0 = right, clockwise). fan: leaf spread around the
// outward direction (deg). tags: label anchors relative to the hub (px, not scaled) + alignment,
// in order of preference (the layout takes the first one clear of other labels, nodes and links).
// notes: the next lecture / sheet number filed into this course ("Lecture 8", "Sheet 6"); they
// count up and wrap inside the semester so far (MAX_LECTURE, MAX_SHEET).
const COURSES = [
  { label: "DISCRETE MATH", ang: -140, fan: [-40, 56], tags: [[10, -6, "l"], [-10, 9, "r"], [0, -15, "c"]], notes: [8, 6] },
  { label: "A&D", ang: 4, fan: [-56, 52], tags: [[-8, -14, "r"], [0, -15, "c"], [-8, 14, "r"], [0, 15, "c"]], notes: [7, 5] },
  { label: "LIN ALG", ang: 58, fan: [-64, 16], tags: [[9, -14, "l"], [0, -15, "c"], [-10, -10, "r"]], notes: [6, 4] },
  { label: "PROGRAMMING", ang: 166, fan: [-46, 38], tags: [[14, 14, "l"], [0, -15, "c"], [-10, 13, "r"]], notes: [8, 7] },
];
// Fallback label spots around any hub, tried after the course's own list (upper ones first).
const RING_TAGS = [
  [0, -15, "c"], [9, -13, "l"], [-9, -13, "r"], [11, -6, "l"], [-11, -6, "r"], [11, 6, "l"], [-11, 6, "r"],
  [9, 13, "l"], [-9, 13, "r"], [0, 15, "c"], [0, -22, "c"], [14, -19, "l"], [-14, -19, "r"], [0, 22, "c"],
  [14, 19, "l"], [-14, 19, "r"],
];
// An agent's footprint relative to its spot on a path (px, x0 y0 x1 y1), as drawn at AGENT_SCALE:
// the arrow (its tip 1.5 px down and right of the spot) in four boxes, then the note a carrier
// drags (last box). Used to keep course labels off the agents' paths.
const FOOT = [
  1.5, 1.5, 4.6, 13.9, 4.6, 4.5, 7.5, 10.2, 7.5, 8, 10.8, 10.2, 4.6, 10.2, 8.8, 15.6,
  10.5, 13.5, 14.5, 18.5,
];
const FOOT_X = 14.5;              // its reach right of and below the spot
const FOOT_Y = 18.5;
// Where a filed note's name may go around its leaf, in order of preference (placeNote): [kind, a, b]
//   0 beside it: a = 1 outward / -1 inward side, b = shifted down (px)
//   1 beyond it, away from its hub (out past the fan): a = gap (px)
//   2 diagonally: a = 1 outward / -1 inward side, b = -1 above / 1 below
//   3 centred above (b = -1) or below (b = 1)
//   4 a ring of fallbacks: a = gap (px), b = direction (× 22.5 deg, screen space)
const NOTE_SPOTS = [
  [0, 1, 0], [1, 6, 0], [3, 0, -1], [2, 1, -1], [0, 1, -8], [0, 1, 8], [0, -1, 0], [0, -1, -8],
  [0, -1, 8], [2, -1, -1], [1, 12, 0], [1, 18, 0], [2, 1, 1], [2, -1, 1], [3, 0, 1],
];
for (const gap of [8, 14, 20]) for (let d = 0; d < 16; d++) NOTE_SPOTS.push([4, gap, d]);
const INBOX_ANG = -46;            // deg, from the vault
const INBOX_DIST = 1.5;           // × orbit radius
const SHAPES = [1, 1.3, 1.65];    // orbit aspect ratios the fitter may use (wider for short free areas)
const SHAPE_BIAS = [1, 0.93, 0.87];

/* ── look ────────────────────────────────────────────────────────────────────────────────────── */

const BG = "#08080a";
const INK = "#c9cdd4";            // leaves and notes (--text-2)
const LABEL_INK = "#9ea4ae";      // --text-3
const GREEN = "#22e07a";
const LINE_MAIN = "rgba(255,255,255,0.15)";
const LINE_LEAF = "rgba(255,255,255,0.085)";
const LINE_RING = "rgba(255,255,255,0.085)";
const LINE_TRAIL = "rgba(255,255,255,0.17)"; // the stretch of orbit the coordinator just walked
const HUB_STROKE = "rgba(255,255,255,0.55)";
const LEAF_ALPHA = 0.42;
const COURSE_ALPHA = 0.85;        // course labels
const LABEL_ALPHA = 0.78;         // VAULT, INBOX (a step quieter than the courses)
const PIP_REST = 0.3;             // resting status pip (in sync): dim green
const COURSE_PX = 10.5;
const LABEL_PX = 9.5;
const NOTE_PX = 9;
const NOTE_ALPHA = 0.62;
const TRACE_ALPHA = 0.26;         // the route a carrier just walked, in its colour (≤ 0.28)
const LEAF_R = 2;
const HUB_R = 3.6;
const DASH_RING = [1.5, 4.5];
const DASH_STUB = [2, 3];
const NO_DASH = [];

/* ── motion ──────────────────────────────────────────────────────────────────────────────────── */

const FRAME_MS = 1000 / 60;       // ~60 fps on high-refresh displays (paced by a due time, see tick())
const GROW_S = 2.2;               // full grow-in when the build reveals the hero
const GROW_SHORT = 0.55;          // time factor for the short grow (no build / after a skip)
const CRUISE = 56;                // carrier speed along links (design px / s)
const ARC_CRUISE = 36;            // coordinator speed along the orbit
const ACCEL_S = 0.9;              // accelerate / decelerate time at each end of a trip
const CORNER = 9;                 // px: trips round their corners through a node
const AGENT_SCALE = 0.8;          // × the build agents' arrow
const CARRIERS = [0, 5];          // PALETTE indices: cyan, orange
const COORDINATOR = 3;            // purple
const LIT_TAU = 3.2;              // s: a filed leaf's colour decays to grey
const PIP_TAU = 1.8;
const FADE_S = 1.3;               // the oldest leaf's fade-out
const NEW_S = 0.55;               // a new leaf's spoke + pop
const DRIFT = 1.3;                // px: leaves breathe around their place
const PUSH = 5;                   // px: leaves ease away from the visitor's pointer
const PUSH_R = 64;
const Q_MAX = 3;                  // notes waiting in the inbox
const MAX_LECTURE = 8;            // note names stay inside the semester so far (week 8): they wrap
const MAX_SHEET = 7;
const PICKUP_S = 1.0;             // pauses: at the inbox, the vault, the leaf, a course hub
const SORT_S = 0.55;
const FILE_S = 1.8;
const CHECK_S = 2.8;
const TRACE_S = 1.3;              // a walked link's trace fades over this
const CLEAR_R = 14;               // px: two agents closer than this would overlap (the arrow is ~9 × 14 px)
const VAULT_ZONE = 22;            // px: one carrier at a time inside this radius around the vault
const TURN_GAP = 0.25;            // s: slack between two carriers' turns at the vault
const RETRY_S = 0.2;              // s: a carrier waiting for its turn checks again after this

/* ── canvas ──────────────────────────────────────────────────────────────────────────────────── */

const MAX_DPR = 3;                // backing store: the screen's pixel ratio, up to 3×,
const MAX_BACKING = 2.4e6;        // while it stays under this many device px (else 2×)

/* ── public API ──────────────────────────────────────────────────────────────────────────────── */

export async function mountHeroGraph(container, { animate = true } = {}) {
  if (!container || typeof window === "undefined" || typeof document === "undefined") return NOOP_HANDLE;
  const cleanups = []; // teardown steps registered during setup, run in reverse order
  try {
    return createHeroGraph(container, !!animate, cleanups);
  } catch (err) {
    runCleanups(cleanups); // a half-built map leaves no canvas, observer or listener behind
    console.warn("[herograph] could not start; the hero visual stays empty.", err);
    return NOOP_HANDLE;
  }
}

/* ── implementation ──────────────────────────────────────────────────────────────────────────── */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const NC = COURSES.length;
const VAULT = 0;
const INBOX = 1;
const HUB0 = 2;
const LEAF0 = HUB0 + NC;
const N = LEAF0 + NC * SLOTS;
const leafOf = (c, j) => LEAF0 + c * SLOTS + j;

// agent phases and tasks
const PAUSE = 0;
const TRAVEL = 1;
const ARC = 2;
const TO_INBOX = 0;
const PICKUP = 1;
const TO_VAULT = 2;
const SORT = 3;
const TO_LEAF = 4;
const FILE = 5;
const ROUND = 6;
const CHECK = 7;

function createHeroGraph(container, animateInitially, cleanups) {
  const root = document.documentElement;
  const layer = container.closest("[data-layer]");
  const hero = container.closest(".hero");
  const panel = hero ? hero.querySelector(".hero-now") : null;
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available");
  container.appendChild(canvas);
  cleanups.push(() => canvas.remove());
  const stats = { frames: 0, drawMsTotal: 0, drawMsMax: 0, agents: null, layout: null };
  const debug = debugOn();
  if (debug) {
    window.__heroGraphStats = stats;
    cleanups.push(() => {
      if (window.__heroGraphStats === stats) delete window.__heroGraphStats;
    });
  }

  const state = {
    animate: animateInitially,
    inView: true,
    pageVisible: !document.hidden,
    shown: isShown(),
    disposed: false,
    broken: false,
    w: 0,
    h: 0,
    dpr: 0,
  };

  /* geometry ----------------------------------------------------------------------------------- */

  const rngLayout = mulberry32(SEED);
  const rng = mulberry32(SEED ^ 0x5bd1e995); // choreography (separate stream: layout never shifts)

  const parent = new Int16Array(N);
  const courseOf = new Int8Array(N).fill(-1);
  parent[VAULT] = -1;
  parent[INBOX] = VAULT;
  const leafRad = new Float32Array(N);
  const leafAng = new Float32Array(N);
  for (let c = 0; c < NC; c++) {
    parent[HUB0 + c] = VAULT;
    courseOf[HUB0 + c] = c;
    for (let j = 0; j < SLOTS; j++) {
      const i = leafOf(c, j);
      parent[i] = HUB0 + c;
      courseOf[i] = c;
      leafRad[i] = LEAF_DIST[j % 2] + (rngLayout() - 0.5) * 4;
      leafAng[i] = (rngLayout() - 0.5) * 5 * DEG;
    }
  }
  const shapes = SHAPES.map(buildShape);

  /** World positions (design px, vault at 0,0) for an orbit of the given aspect ratio. */
  function buildShape(aspect) {
    const rx = RING * Math.sqrt(aspect);
    const ry = RING / Math.sqrt(aspect);
    const wx = new Float32Array(N);
    const wy = new Float32Array(N);
    const phi = new Float32Array(NC);
    for (let c = 0; c < NC; c++) {
      const C = COURSES[c];
      const p = C.ang * DEG;
      phi[c] = p;
      const hx = rx * Math.cos(p);
      const hy = ry * Math.sin(p);
      wx[HUB0 + c] = hx;
      wy[HUB0 + c] = hy;
      const out = Math.atan2(hy, hx);
      for (let j = 0; j < SLOTS; j++) {
        const i = leafOf(c, j);
        const a = out + (C.fan[0] + ((C.fan[1] - C.fan[0]) * j) / (SLOTS - 1)) * DEG + leafAng[i];
        wx[i] = hx + Math.cos(a) * leafRad[i];
        wy[i] = hy + Math.sin(a) * leafRad[i];
      }
    }
    const ia = INBOX_ANG * DEG;
    wx[INBOX] = rx * Math.cos(ia) * INBOX_DIST;
    wy[INBOX] = ry * Math.sin(ia) * INBOX_DIST;
    return { aspect, rx, ry, wx, wy, phi };
  }

  // screen space (CSS px inside the canvas), recomputed by layout()
  const bx = new Float32Array(N); // base positions
  const by = new Float32Array(N);
  const X = new Float32Array(N); // live positions (base + breathing + pointer push)
  const Y = new Float32Array(N);
  const pushX = new Float32Array(N);
  const pushY = new Float32Array(N);
  const driftW1 = new Float32Array(N);
  const driftW2 = new Float32Array(N);
  const driftP1 = new Float32Array(N);
  const driftP2 = new Float32Array(N);
  for (let i = LEAF0; i < N; i++) {
    driftW1[i] = 0.42 + rngLayout() * 0.36;
    driftW2[i] = 0.38 + rngLayout() * 0.36;
    driftP1[i] = rngLayout() * TAU;
    driftP2[i] = rngLayout() * TAU;
  }
  const geo = { shape: shapes[0], s: 1, vx: 0, vy: 0, rx: 0, ry: 0, stubX: 0, stubY: 0, avoid: null };
  let stubGrad = null;

  /* labels and sprites ------------------------------------------------------------------------- */

  const measure = document.createElement("canvas").getContext("2d");
  let courseLabels = [];
  let tagCands = []; // candidate label boxes per course
  let tagBoxes = [];  // the chosen one per course
  let vaultTag = null; // the VAULT label's box (always above the vault)
  let vaultLabel = null;
  let inboxLabel = null;
  let noteCache = new Map();
  // layout-time obstacles shared by the label resolver and the note placer: boxes (x0, y0, x1, y1;
  // the first nodeBoxes values are nodes, then labels) and links (node index pairs)
  const obstacles = [];
  const links = [];
  let nodeBoxes = 0;
  let agentSprites = new Map();
  let vaultSprite = null;

  function textSprite(text, px, tracking) {
    const font = `500 ${px}px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;
    measure.font = font;
    if ("letterSpacing" in measure) measure.letterSpacing = `${tracking}px`;
    const tw = Math.ceil(measure.measureText(text).width);
    const w = tw + 2;
    const h = Math.ceil(px * 1.5);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w * state.dpr));
    c.height = Math.max(1, Math.ceil(h * state.dpr));
    const g = c.getContext("2d");
    g.scale(state.dpr, state.dpr);
    g.font = font;
    if ("letterSpacing" in g) g.letterSpacing = `${tracking}px`;
    g.fillStyle = LABEL_INK;
    g.textBaseline = "middle";
    g.fillText(text, 1, h / 2 + 0.5);
    // dw / dh: the bitmap's exact size in CSS px, so it is blitted 1:1 onto device pixels
    return { img: c, w, h, tw, dw: c.width / state.dpr, dh: c.height / state.dpr };
  }

  /** The build's arrow cursor, smaller: a dark rim and a soft dark drop shadow (no coloured glow). */
  function arrowSprite(color) {
    const s = AGENT_SCALE;
    const pad = 6; // room for the shadow
    const dpr = state.dpr;
    const w = Math.ceil(12 * s + pad * 2);
    const h = Math.ceil(18 * s + pad * 2);
    const c = document.createElement("canvas");
    c.width = Math.ceil(w * dpr);
    c.height = Math.ceil(h * dpr);
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    g.translate(pad, pad);
    g.scale(s, s);
    g.beginPath();
    ARROW.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    // shadow sizes are in bitmap pixels (the transform does not scale them)
    g.shadowColor = "rgba(0,0,0,0.65)";
    g.shadowBlur = 4 * dpr;
    g.shadowOffsetY = 1 * dpr;
    g.fillStyle = color;
    g.fill();
    g.shadowColor = "transparent";
    g.shadowBlur = 0;
    g.shadowOffsetY = 0;
    g.lineJoin = "round";
    g.lineWidth = 1;
    g.strokeStyle = shade(color, 0.45); // the agent colour, ~55 % toward black
    g.stroke();
    g.beginPath(); // the same glossy left-edge highlight as the build agents
    g.moveTo(1.2, 2.5);
    g.lineTo(1.2, 11.5);
    g.strokeStyle = "rgba(255,255,255,0.5)";
    g.stroke();
    return { img: c, w, h, ax: pad, ay: pad, dw: c.width / dpr, dh: c.height / dpr };
  }

  /** The vault glyph: ring, centre dot, crosshair ticks and short registration hairlines. */
  function makeVaultSprite() {
    const S = 84;
    const c = document.createElement("canvas");
    c.width = Math.ceil(S * state.dpr);
    c.height = Math.ceil(S * state.dpr);
    const g = c.getContext("2d");
    g.scale(state.dpr, state.dpr);
    const m = S / 2;
    g.lineWidth = 1;
    for (let k = 0; k < 4; k++) {
      const ux = k === 0 ? 1 : k === 2 ? -1 : 0;
      const uy = k === 1 ? 1 : k === 3 ? -1 : 0;
      const end = k === 3 ? 20 : 41; // the upward hairline stops short of the VAULT label
      const grad = g.createLinearGradient(m + ux * 17, m + uy * 17, m + ux * end, m + uy * end);
      grad.addColorStop(0, "rgba(255,255,255,0.16)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.strokeStyle = grad;
      g.beginPath();
      g.moveTo(m + ux * 17, m + uy * 17);
      g.lineTo(m + ux * end, m + uy * end);
      g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.5)";
      g.beginPath();
      g.moveTo(m + ux * 9, m + uy * 9);
      g.lineTo(m + ux * 13.5, m + uy * 13.5);
      g.stroke();
    }
    g.beginPath();
    g.arc(m, m, 5, 0, TAU);
    g.fillStyle = BG;
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.78)";
    g.stroke();
    g.beginPath();
    g.arc(m, m, 1.5, 0, TAU);
    g.fillStyle = "#f4f5f7";
    g.fill();
    return { img: c, w: S, h: S };
  }

  function buildSprites() {
    courseLabels = COURSES.map((C) => textSprite(C.label, COURSE_PX, 0.7));
    tagCands = COURSES.map((C, c) => C.tags.concat(RING_TAGS).map((t) => courseTagBox(c, t)));
    tagBoxes = tagCands.map((list) => list[0]);
    vaultLabel = textSprite("VAULT", LABEL_PX, 0.7);
    inboxLabel = textSprite("INBOX", LABEL_PX, 0.7);
    vaultTag = vaultTagBox(0, -VAULT_TAG_Y);
    noteCache = new Map();
    // every note name a filing can show, so no text is rasterised inside the frame loop
    for (let n = 1; n <= MAX_LECTURE; n++) noteSprite(`Lecture ${n}`);
    for (let n = 1; n <= MAX_SHEET; n++) noteSprite(`Sheet ${n}`);
    for (const C of courses) C.note = C.noteText ? noteSprite(C.noteText) : null;
    agentSprites = new Map();
    for (const i of [...CARRIERS, COORDINATOR]) agentSprites.set(i, arrowSprite(PALETTE[i]));
    vaultSprite = makeVaultSprite();
    for (const a of agents) a.sprite = agentSprites.get(a.colorIdx);
  }

  function noteSprite(text) {
    let s = noteCache.get(text);
    if (!s) {
      s = textSprite(text, NOTE_PX, 0.2);
      noteCache.set(text, s);
    }
    return s;
  }

  /* label boxes (px offsets from their node), shared by the fitter and the renderer -------------- */

  const PIP_W = 10; // pip (4 px) + gap before the text
  function courseTagBox(c, [dx, dy, align]) {
    const gw = PIP_W + courseLabels[c].tw;
    const x0 = align === "l" ? dx : align === "r" ? dx - gw : dx - gw / 2;
    return { x0, y0: dy - 6, x1: x0 + gw, y1: dy + 6 };
  }
  // The VAULT label sits above the vault (an agent parked on the vault hangs below its tip); the
  // resolver may nudge it along these offsets, but never flips it below.
  const VAULT_TAG_Y = 28;
  const VAULT_TAG_ALT = [[0, -28], [0, -32], [0, -24], [-8, -28], [8, -28], [-8, -32], [8, -32], [0, -36]];
  const vaultTagBox = (dx, dy) => ({ x0: dx - vaultLabel.tw / 2, y0: dy - 6, x1: dx + vaultLabel.tw / 2, y1: dy + 6 });
  const inboxTagBox = () => ({ x0: -11 - inboxLabel.tw, y0: -6, x1: -11, y1: 6 });

  /* fitting: biggest scale whose nodes and labels stay inside the square and off the facts panel
     (and so does the arrow of an agent parked on a node) ----------------------------------------- */

  function panelRect(w, h) {
    if (!panel) return null;
    const pr = panel.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    if (pr.width < 1 || pr.height < 1) return null;
    const r = { x0: pr.left - cr.left, y0: pr.top - cr.top, x1: pr.right - cr.left, y1: pr.bottom - cr.top };
    if (r.x1 <= 0 || r.y1 <= 0 || r.x0 >= w || r.y0 >= h) return null;
    return r;
  }

  function gridPhase() {
    if (!hero) return null;
    const hr = hero.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    // background-position: center top, size 56 px; the 1 px line sits at each tile's left/top edge
    return {
      x: (hr.width - GRID) / 2 + 0.5 - (cr.left - hr.left),
      y: 0.5 - (cr.top - hr.top),
    };
  }

  function fit(w, h) {
    const PAD = 8;
    const M = 10;
    const M_FOOT = 6; // a parked agent's arrow keeps this much off the panel
    const avoid = panelRect(w, h);
    geo.avoid = avoid;
    const ax0 = avoid ? avoid.x0 - M : 0;
    const ay0 = avoid ? avoid.y0 - M : 0;
    const ax1 = avoid ? avoid.x1 + M : 0;
    const ay1 = avoid ? avoid.y1 + M : 0;
    const boxes = [];
    const feet = []; // where an agent parked on each node hangs (tested against the panel only)
    const tags = tagCands.map((list) => list[0]);
    const vTag = vaultTagBox(0, -VAULT_TAG_Y);
    const iTag = inboxTagBox();

    const collect = (sh, s) => {
      boxes.length = 0;
      feet.length = 0;
      const add = (x0, y0, x1, y1) => boxes.push(x0, y0, x1, y1);
      for (let i = 0; i < N; i++) {
        const r = i === VAULT ? 15 : i === INBOX ? 7 : i < LEAF0 ? 6 : 5;
        const x = sh.wx[i] * s;
        const y = sh.wy[i] * s;
        add(x - r, y - r, x + r, y + r);
        // the arrow below and to the right of it (with a carrier's note at the inbox and the vault)
        const note = i === VAULT || i === INBOX;
        feet.push(x + 1, y + 1, x + (note ? FOOT_X : 11.5), y + (note ? FOOT_Y : 16.5));
      }
      for (let c = 0; c < NC; c++) {
        const x = sh.wx[HUB0 + c] * s;
        const y = sh.wy[HUB0 + c] * s;
        add(x + tags[c].x0, y + tags[c].y0, x + tags[c].x1, y + tags[c].y1);
      }
      add(vTag.x0, vTag.y0, vTag.x1, vTag.y1);
      const ix = sh.wx[INBOX] * s;
      const iy = sh.wy[INBOX] * s;
      add(ix + iTag.x0, iy + iTag.y0, ix + iTag.x1, iy + iTag.y1);
      // the first two queued notes beside the inbox
      const len = Math.hypot(ix, iy) || 1;
      for (const d of [12, 19]) add(ix + (ix / len) * d - 3, iy + (iy / len) * d - 3, ix + (ix / len) * d + 3, iy + (iy / len) * d + 3);
    };
    const clear = (vx, vy) => {
      if (!avoid) return true;
      for (let k = 0; k < boxes.length; k += 4) {
        if (vx + boxes[k + 2] > ax0 && vx + boxes[k] < ax1 && vy + boxes[k + 3] > ay0 && vy + boxes[k + 1] < ay1) return false;
      }
      for (let k = 0; k < feet.length; k += 4) {
        if (vx + feet[k + 2] > avoid.x0 - M_FOOT && vx + feet[k] < avoid.x1 + M_FOOT && vy + feet[k + 3] > avoid.y0 - M_FOOT && vy + feet[k + 1] < avoid.y1 + M_FOOT) return false;
      }
      return true;
    };

    const sHi = (Math.min(w, h) / DESIGN) * 1.12; // may grow a little past the design size
    const anchorX = w * 0.52;
    const anchorY = h * 0.46;
    let best = null;
    for (let si = 0; si < shapes.length; si++) {
      const sh = shapes[si];
      for (let s = sHi; s >= sHi * 0.4; s -= sHi * 0.02) {
        collect(sh, s);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let k = 0; k < boxes.length; k += 4) {
          minX = Math.min(minX, boxes[k]);
          minY = Math.min(minY, boxes[k + 1]);
          maxX = Math.max(maxX, boxes[k + 2]);
          maxY = Math.max(maxY, boxes[k + 3]);
        }
        const vxLo = PAD - minX, vxHi = w - PAD - maxX;
        const vyLo = PAD - minY, vyHi = h - PAD - maxY;
        if (vxLo > vxHi || vyLo > vyHi) continue;
        let found = null;
        let bestD = Infinity;
        const STEPS = 14;
        for (let iy = 0; iy <= STEPS; iy++) {
          for (let ix = 0; ix <= STEPS; ix++) {
            const vx = vxLo + ((vxHi - vxLo) * ix) / STEPS;
            const vy = vyLo + ((vyHi - vyLo) * iy) / STEPS;
            if (!clear(vx, vy)) continue;
            const d = (vx - anchorX) ** 2 + (vy - anchorY) ** 2;
            if (d < bestD) {
              bestD = d;
              found = { vx, vy };
            }
          }
        }
        if (!found) continue;
        const score = s * SHAPE_BIAS[si];
        if (!best || score > best.score) {
          // Snap the vault onto the nearest grid crossing that keeps everything clear.
          let { vx, vy } = found;
          const gp = gridPhase();
          if (gp) {
            const gx = gp.x + Math.round((vx - gp.x) / GRID) * GRID;
            const gy = gp.y + Math.round((vy - gp.y) / GRID) * GRID;
            let bestSnap = null;
            for (const cx of [gx, gx - GRID, gx + GRID]) {
              for (const cy of [gy, gy - GRID, gy + GRID]) {
                if (cx < vxLo || cx > vxHi || cy < vyLo || cy > vyHi || !clear(cx, cy)) continue;
                const d = (cx - vx) ** 2 + (cy - vy) ** 2;
                if (d <= (GRID * 0.75) ** 2 && (!bestSnap || d < bestSnap.d)) bestSnap = { cx, cy, d };
              }
            }
            if (bestSnap) {
              vx = bestSnap.cx;
              vy = bestSnap.cy;
            }
          }
          best = { score, si, s, vx, vy };
        }
        break;
      }
    }
    return best || { si: 0, s: sHi * 0.6, vx: w / 2, vy: h * 0.42 };
  }

  function layout() {
    const f = fit(state.w, state.h);
    const sh = shapes[f.si];
    geo.shape = sh;
    geo.s = f.s;
    geo.vx = f.vx;
    geo.vy = f.vy;
    geo.rx = sh.rx * f.s;
    geo.ry = sh.ry * f.s;
    for (let i = 0; i < N; i++) {
      bx[i] = f.vx + sh.wx[i] * f.s;
      by[i] = f.vy + sh.wy[i] * f.s;
      X[i] = bx[i];
      Y[i] = by[i];
    }
    const dx = bx[INBOX] - bx[VAULT];
    const dy = by[INBOX] - by[VAULT];
    const len = Math.hypot(dx, dy) || 1;
    geo.stubX = dx / len;
    geo.stubY = dy / len;
    resolveLabels();
    // the filed notes' names (the still frame shows the latest one) follow the new layout
    for (const C of courses) if (C.note && C.noteLeaf >= 0) placeNote(C, C.noteLeaf);
    stubGrad = ctx.createLinearGradient(bx[INBOX] + geo.stubX * 8, by[INBOX] + geo.stubY * 8, bx[INBOX] + geo.stubX * 74, by[INBOX] + geo.stubY * 74);
    stubGrad.addColorStop(0, "rgba(255,255,255,0.16)");
    stubGrad.addColorStop(1, "rgba(255,255,255,0)");
    if (debug) stats.layout = layoutSnapshot(f);
  }

  /** Debug only: what the fitter and the label resolver decided (boxes in canvas px). */
  function layoutSnapshot(f) {
    const box = (x, y, b) => [x + b.x0, y + b.y0, x + b.x1, y + b.y1];
    const labels = COURSES.map((C, c) => [C.label, ...box(bx[HUB0 + c], by[HUB0 + c], tagBoxes[c])]);
    labels.push(["VAULT", ...box(bx[VAULT], by[VAULT], vaultTag)]);
    labels.push(["INBOX", ...box(bx[INBOX], by[INBOX], inboxTagBox())]);
    const C = recent[0] >= 0 ? courses[courseOf[recent[0]]] : null;
    const note = C && C.note && C.noteLeaf === recent[0]
      ? [C.noteText, bx[C.noteLeaf] + C.noteDx, by[C.noteLeaf] + C.noteDy, bx[C.noteLeaf] + C.noteDx + C.note.w, by[C.noteLeaf] + C.noteDy + C.note.h]
      : null;
    return {
      w: state.w,
      h: state.h,
      dpr: state.dpr,
      fit: { shape: f.si, s: +f.s.toFixed(4), vx: +f.vx.toFixed(2), vy: +f.vy.toFixed(2) },
      panel: geo.avoid,
      labels,
      note,
      nodes: Array.from(bx, (x, i) => [+x.toFixed(2), +by[i].toFixed(2)]),
      parent: Array.from(parent),
    };
  }

  /**
   * Labels are fixed-size while the map scales, so on small squares they can crowd each other.
   * The VAULT label goes above the vault (nudged along VAULT_TAG_ALT if that spot is taken); then
   * each course label takes its first candidate spot that stays inside the canvas and clear of the
   * panel, the other labels, every node and every link (its own list first, then a ring of spots
   * around the hub; if none is clear, the least crowded one). Layout time only.
   */
  function resolveLabels() {
    obstacles.length = 0;
    for (let i = 0; i < N; i++) {
      const r = i === VAULT ? 14 : i === INBOX ? 7 : i < LEAF0 ? 5 : 4.5;
      obstacles.push(bx[i] - r, by[i] - r, bx[i] + r, by[i] + r);
    }
    nodeBoxes = obstacles.length;
    const ix = bx[INBOX];
    const iy = by[INBOX];
    const ib = inboxTagBox();
    obstacles.push(ix + ib.x0, iy + ib.y0, ix + ib.x1, iy + ib.y1);
    links.length = 0;
    for (let c = 0; c < NC; c++) links.push(VAULT, HUB0 + c);
    links.push(VAULT, INBOX);
    for (let i = LEAF0; i < N; i++) links.push(parent[i], i);

    const vx = bx[VAULT];
    const vy = by[VAULT];
    vaultTag = bestBox(vx, vy, VAULT_TAG_ALT.map(([dx, dy]) => vaultTagBox(dx, dy)));
    obstacles.push(vx + vaultTag.x0, vy + vaultTag.y0, vx + vaultTag.x1, vy + vaultTag.y1);
    for (let c = 0; c < NC; c++) {
      const hx = bx[HUB0 + c];
      const hy = by[HUB0 + c];
      const pick = bestBox(hx, hy, tagCands[c], true);
      tagBoxes[c] = pick;
      obstacles.push(hx + pick.x0, hy + pick.y0, hx + pick.x1, hy + pick.y1);
    }
  }

  /**
   * The first box (offsets from x, y) with no penalty, else the least crowded one. With `paths`
   * (the course labels), of the boxes with no penalty the one agents walk over least (pathCost).
   */
  function bestBox(x, y, list, paths = false) {
    let best = list[0];
    let bestP = Infinity;
    let clear = null;
    let clearC = Infinity;
    for (const b of list) {
      const p = penalty(x + b.x0, y + b.y0, x + b.x1, y + b.y1);
      if (p === 0) {
        if (!paths) return b;
        const c = pathCost(x + b.x0, y + b.y0, x + b.x1, y + b.y1);
        if (c === 0) return b;
        if (c < clearC) {
          clearC = c;
          clear = b;
        }
      } else if (p < bestP) {
        bestP = p;
        best = b;
      }
    }
    return clear || best;
  }

  /**
   * How badly a box (canvas px) collides with the layout: outside the canvas or on the panel
   * (1000 each), on a label (20), a node (4) or a link (1 each). 0 = clear. No allocations.
   */
  function penalty(x0, y0, x1, y1) {
    let p = 0;
    if (x0 < 3 || y0 < 3 || x1 > state.w - 3 || y1 > state.h - 3) p += 1000;
    const av = geo.avoid;
    if (av && x1 > av.x0 - 6 && x0 < av.x1 + 6 && y1 > av.y0 - 6 && y0 < av.y1 + 6) p += 1000;
    const occ = obstacles;
    for (let k = 0; k < occ.length; k += 4) {
      if (x1 > occ[k] - 2 && x0 < occ[k + 2] + 2 && y1 > occ[k + 1] - 2 && y0 < occ[k + 3] + 2) p += k < nodeBoxes ? 4 : 20;
    }
    for (let k = 0; k < links.length; k += 2) {
      const ax = bx[links[k]];
      const ay = by[links[k]];
      const dx = bx[links[k + 1]] - ax;
      const dy = by[links[k + 1]] - ay;
      // quick reject: the link's bounding box misses the box
      if (Math.max(ax, ax + dx) < x0 - 1 || Math.min(ax, ax + dx) > x1 + 1 || Math.max(ay, ay + dy) < y0 - 1 || Math.min(ay, ay + dy) > y1 + 1) continue;
      const steps = Math.max(2, Math.ceil(Math.hypot(dx, dy) / 2));
      for (let q = 0; q <= steps; q++) {
        const px = ax + (dx * q) / steps;
        const py = ay + (dy * q) / steps;
        if (px > x0 - 1 && px < x1 + 1 && py > y0 - 1 && py < y1 + 1) {
          p += 1;
          break;
        }
      }
    }
    return p;
  }

  /**
   * How long agents would cover a box (canvas px) on their way: px of path from which an agent's
   * arrow (and the note a carrier drags) would overlap it, as they hang below and to the right of
   * the line. The orbit ring (the coordinator's rounds) and the links at the vault count fully,
   * a leaf's spoke a quarter (one filing in six walks it). Layout time only.
   */
  function pathCost(x0, y0, x1, y1) {
    let c = 0;
    for (let k = 0; k < links.length; k += 2) {
      const ax = bx[links[k]];
      const ay = by[links[k]];
      const dx = bx[links[k + 1]] - ax;
      const dy = by[links[k + 1]] - ay;
      if (Math.max(ax, ax + dx) < x0 - FOOT_X || Math.min(ax, ax + dx) > x1 || Math.max(ay, ay + dy) < y0 - FOOT_Y || Math.min(ay, ay + dy) > y1) continue;
      const len = Math.hypot(dx, dy);
      const steps = Math.max(2, Math.ceil(len));
      const w = (links[k] === VAULT ? 1 : 0.25) * (len / steps); // per px of path
      for (let q = 0; q <= steps; q++) {
        if (footOver(ax + (dx * q) / steps, ay + (dy * q) / steps, x0, y0, x1, y1, FOOT.length)) c += w;
      }
    }
    // the orbit ring: the coordinator's rounds (it carries no note)
    const rx = geo.rx;
    const ry = geo.ry;
    const steps = Math.ceil(Math.PI * (rx + ry));
    const w = (Math.PI * (rx + ry)) / steps;
    for (let q = 0; q < steps; q++) {
      const a = (q / steps) * TAU;
      if (footOver(bx[VAULT] + rx * Math.cos(a), by[VAULT] + ry * Math.sin(a), x0, y0, x1, y1, FOOT.length - 4)) c += w;
    }
    return c;
  }

  /** Would an agent at (px, py) cover the box? (the first n values of FOOT) */
  function footOver(px, py, x0, y0, x1, y1, n) {
    if (px + 1.5 >= x1 || px + FOOT_X <= x0 || py + 1.5 >= y1 || py + FOOT_Y <= y0) return false;
    for (let k = 0; k < n; k += 4) {
      if (px + FOOT[k] < x1 && px + FOOT[k + 2] > x0 && py + FOOT[k + 1] < y1 && py + FOOT[k + 3] > y0) return true;
    }
    return false;
  }

  /* simulation state --------------------------------------------------------------------------- */

  let simT = 0;       // agent clock: runs once the graph has grown
  let clock = 0;      // breathing clock
  let growT = 0;      // time since the reveal
  let growK = 1;      // 1 = full grow, GROW_SHORT = short grow
  let still = false;  // rendering the parked still frame

  const slotState = new Int8Array(N); // leaves: 0 empty, 1 live, 2 fading
  const bornAt = new Float32Array(N).fill(-1e4);
  const fadeAt = new Float32Array(N).fill(-1e4);
  const litAt = new Float32Array(N).fill(-1e4);
  const litCol = new Int8Array(N);
  const recent = [-1, -1, -1]; // the last three filed leaves (the still frame keeps them lit)
  // the trace a carrier leaves on the links it walked with a note, per link (indexed by its child node)
  const traceAt = new Float32Array(N).fill(-1e4);
  const traceCol = new Int8Array(N);

  const courses = COURSES.map((C, c) => ({
    busy: -1,         // the carrier filing into this course (from the vault until it is back past it)
    pipAt: -1e4,
    pingAt: -1e4,
    pingCol: COORDINATOR,
    noteAt: -1e4,
    noteLeaf: -1,
    noteText: "",
    note: null,
    noteDx: 0,        // the note name's offset from its leaf (picked once, clear of labels)
    noteDy: 0,
    next: 0,          // alternates lecture / sheet
    lecture: C.notes[0],
    sheet: C.notes[1],
    c,
  }));

  // five live leaves per course, staggered ages, one free slot
  for (let c = 0; c < NC; c++) {
    const free = Math.floor(rngLayout() * SLOTS);
    for (let j = 0; j < SLOTS; j++) {
      const i = leafOf(c, j);
      if (j === free) continue;
      slotState[i] = 1;
      bornAt[i] = -100 - ((j - free + SLOTS) % SLOTS) * 9 - rngLayout() * 4;
    }
  }

  // inbox queue: distances of the waiting notes along the incoming stub
  const qd = new Float32Array(Q_MAX);
  let qn = 2;
  qd[0] = 12;
  qd[1] = 18.5;
  let qNext = 3.2;

  // course visiting order for carriers: seeded, no immediate repeats
  const order = [];
  for (let k = 0, prev = -1; k < 40; k++) {
    let c = Math.floor(rng() * NC);
    if (c === prev) c = (c + 1 + Math.floor(rng() * (NC - 1))) % NC;
    order.push(c);
    prev = c;
  }
  let orderPos = 0;

  const agents = [];
  function makeAgent(colorIdx, role) {
    const a = {
      id: agents.length,
      role,
      colorIdx,
      color: PALETTE[colorIdx],
      sprite: null,
      phase: PAUSE,
      task: 0,
      node: VAULT,
      path: new Int16Array(6),
      seg: new Float32Array(5),
      n: 0,
      t0: 0,
      dur: 1,
      accel: 0.3,
      until: 0,
      pickAt: 0,
      carrying: false,
      course: -1,
      slot: -1,
      arcFrom: 0,
      arcTo: 0,
      arcEnd: -1e4, // when the last walk along the orbit ended (its trail fades after)
      releaseAt: 0, // on its way back to the inbox: when it is past the vault (its course frees up)
      hub: 0,
      legK: 0,      // the route segment it is on, and how far along it (0…1)
      legU: 0,
      legDone: 0,   // segments of this trip already handed to the trace
      x: 0,
      y: 0,
    };
    agents.push(a);
    return a;
  }

  // The opening tableau (also the still frame when animations are off at load): one carrier at
  // the inbox picking up a note, one that just filed a lecture into A&D (its name shows in the
  // still frame), the coordinator checking in on Programming.
  {
    const c0 = makeAgent(CARRIERS[0], "carrier");
    c0.task = PICKUP;
    c0.node = INBOX;
    c0.carrying = true;
    c0.until = 1.5;
    const c1 = makeAgent(CARRIERS[1], "carrier");
    const slotAD = firstSlot(1, 0);
    const filedAD = leafOf(1, slotAD);
    c1.task = FILE;
    c1.node = filedAD;
    c1.course = 1;
    c1.slot = slotAD;
    c1.until = 0.8;
    courses[1].busy = c1.id;
    litAt[filedAD] = -0.4;
    litCol[filedAD] = CARRIERS[1];
    courses[1].pipAt = -0.4;
    courses[1].noteLeaf = filedAD; // noteAt stays in the past: the live map does not replay it
    courses[1].noteText = nextNoteName(courses[1]);
    const k = makeAgent(COORDINATOR, "coordinator");
    k.task = CHECK;
    k.node = HUB0 + 3;
    k.hub = 3;
    k.until = 2.4;
    // two earlier filings, still faintly tinted
    const l1 = leafOf(2, firstSlot(2, 1));
    litAt[l1] = -3.2;
    litCol[l1] = CARRIERS[0];
    const l2 = leafOf(0, firstSlot(0, 2));
    litAt[l2] = -6.5;
    litCol[l2] = CARRIERS[1];
    recent[0] = filedAD;
    recent[1] = l1;
    recent[2] = l2;
  }

  /** The course's next note name: lecture and sheet take turns, each wraps inside the semester so far. */
  function nextNoteName(C) {
    const lecture = C.next++ % 2 === 0;
    const text = lecture ? `Lecture ${C.lecture++}` : `Sheet ${C.sheet++}`;
    if (C.lecture > MAX_LECTURE) C.lecture = 1;
    if (C.sheet > MAX_SHEET) C.sheet = 1;
    return text;
  }

  /** The n-th live leaf slot of a course (for the opening tableau). */
  function firstSlot(c, nth) {
    for (let j = 0, seen = 0; j < SLOTS; j++) {
      if (slotState[leafOf(c, j)] === 1 && seen++ === nth) return j;
    }
    return 0;
  }

  /* routes ------------------------------------------------------------------------------------- */

  const upA = new Int16Array(4);
  const upB = new Int16Array(4);
  /** Writes the tree path from → to into a.path (leaf → hub → vault ← inbox …). */
  function route(a, from, to) {
    let na = 0;
    let nb = 0;
    for (let v = from; v >= 0; v = parent[v]) upA[na++] = v;
    for (let v = to; v >= 0; v = parent[v]) upB[nb++] = v;
    // drop the shared ancestors except the lowest one
    while (na > 1 && nb > 1 && upA[na - 2] === upB[nb - 2]) {
      na--;
      nb--;
    }
    let n = 0;
    for (let k = 0; k < na; k++) a.path[n++] = upA[k];
    for (let k = nb - 2; k >= 0; k--) a.path[n++] = upB[k];
    a.n = n;
  }

  function startTrip(a, from, to, task) {
    route(a, from, to);
    let len = 0;
    for (let k = 0; k < a.n - 1; k++) len += dist(a.path[k], a.path[k + 1]);
    a.phase = TRAVEL;
    a.task = task;
    a.t0 = simT;
    a.dur = tripDur(len);
    a.accel = tripAccel(a.dur);
    a.node = to;
    a.legK = 0;
    a.legU = 0;
    a.legDone = 0;
  }

  const dist = (i, j) => Math.hypot(bx[j] - bx[i], by[j] - by[i]);
  const tripDur = (len) => len / (CRUISE * geo.s) + ACCEL_S;
  const tripAccel = (dur) => Math.min(0.45, ACCEL_S / dur);
  /** Seconds after setting off at which a trip of len px has covered d px. */
  function tripTimeAt(len, d) {
    const dur = tripDur(len);
    if (d <= 0) return 0;
    if (d >= len) return dur;
    return invProfile(d / len, tripAccel(dur)) * dur;
  }

  /* turns: the inbox and the vault hold one carrier at a time ---------------------------------- */

  // [winS, winE]: when an agent is (or will be) within VAULT_ZONE px of the vault, set by vaultWindow()
  let winS = 0;
  let winE = 0;
  /** Seconds a carrier needs to get VAULT_ZONE px away from the vault once it sets off for a course. */
  const leaveS = () => tripTimeAt((RING + LEAF_DIST[1]) * geo.s, VAULT_ZONE);

  /** The stretch of time agent o spends at the vault on its current plan; false if none. */
  function vaultWindow(o) {
    if (o.role !== "carrier") return false;
    if (o.phase === PAUSE) {
      if (o.task !== SORT) return false;
      winS = -1e9;
      winE = Math.max(o.until, simT) + leaveS();
      return true;
    }
    if (o.phase !== TRAVEL) return false;
    let total = 0;
    let dV = -1;
    for (let k = 0; k < o.n; k++) {
      if (o.path[k] === VAULT) dV = total;
      if (k < o.n - 1) total += dist(o.path[k], o.path[k + 1]);
    }
    if (dV < 0 || total <= 0) return false;
    winS = dV - VAULT_ZONE <= 0 ? -1e9 : o.t0 + invProfile((dV - VAULT_ZONE) / total, o.accel) * o.dur;
    winE = dV + VAULT_ZONE >= total
      ? o.t0 + o.dur + (o.task === TO_VAULT ? SORT_S + leaveS() : 0)
      : o.t0 + invProfile((dV + VAULT_ZONE) / total, o.accel) * o.dur;
    return true;
  }

  /** Is the vault free of every other carrier during [s, e] (absolute sim time)? */
  function vaultFree(a, s, e) {
    for (let n = 0; n < agents.length; n++) {
      const o = agents[n];
      if (o === a || !vaultWindow(o)) continue;
      if (s < winE + TURN_GAP && winS < e + TURN_GAP) return false;
    }
    return true;
  }

  /** With its note, inbox → vault: it may set off once its stay at the vault clashes with no one's. */
  function mayLeaveInbox(a) {
    const len = dist(INBOX, VAULT);
    return vaultFree(a, simT + tripTimeAt(len, len - VAULT_ZONE), simT + tripDur(len) + SORT_S + leaveS());
  }

  /**
   * When carrier o, still on the inbound side (waiting at the inbox, walking to the vault, sorting
   * there or just setting off for its course), will be VAULT_ZONE px past the vault on its way out;
   * -Infinity once it is (or for any other task). At the inbox this is a plain prediction from the
   * seeded schedule: it sets off once it has a note and its pause is over (nothing else can hold it
   * back, as the carrier asking waits at its leaf until then).
   */
  function outboundClearAt(o) {
    if (o.phase === PAUSE && o.task === PICKUP) {
      let t = Math.max(o.until, simT);
      if (!o.carrying) t = Math.max(t, Math.max(o.pickAt, qn > 0 ? simT : qNext) + 0.5);
      return t + tripDur(dist(INBOX, VAULT)) + SORT_S + leaveS();
    }
    if (o.task !== TO_VAULT && o.task !== SORT && o.task !== TO_LEAF) return -Infinity;
    return vaultWindow(o) ? winE : -Infinity;
  }

  /**
   * Leaf → hub → vault → inbox. The inbox–vault link is single track: the carrier only sets off
   * once the other one has the link and the vault behind it (gone past the vault toward its own
   * course) by the time it gets there, so the two never meet head-on on that line, and the inbox is
   * its own when it arrives. Its pass over the vault must also clash with no one's stay there.
   */
  function mayLeaveLeaf(a) {
    const hub = parent[a.node];
    const dV = dist(a.node, hub) + dist(hub, VAULT);
    const len = dV + dist(VAULT, INBOX);
    const passS = simT + tripTimeAt(len, dV - VAULT_ZONE);
    const passE = simT + tripTimeAt(len, dV + VAULT_ZONE);
    if (!vaultFree(a, passS, passE)) return false;
    const dH = dist(a.node, hub);
    const hubS = simT + tripTimeAt(len, dH - CLEAR_R);
    const hubE = simT + tripTimeAt(len, dH + CLEAR_R);
    for (let n = 0; n < agents.length; n++) {
      const o = agents[n];
      if (o === a) continue;
      if (o.role === "coordinator") {
        // it is checking this course's hub (or will be when the carrier passes it): let it finish
        if (o.hub !== courseOf[a.node]) continue;
        if (o.phase === PAUSE && o.task === CHECK && o.until + 1.0 > hubS) return false;
        if (o.phase === ARC && o.t0 + o.dur < hubE + TURN_GAP) return false;
        continue;
      }
      if (o.phase !== PAUSE && o.task === TO_INBOX) return false;
      if (outboundClearAt(o) + TURN_GAP > passS) return false;
    }
    return true;
  }

  function startArc(a) {
    const from = a.hub;
    const to = (a.hub + 1) % NC;
    const phi = geo.shape.phi;
    let p0 = phi[from];
    let p1 = phi[to];
    while (p1 <= p0) p1 += TAU;
    a.arcFrom = p0;
    a.arcTo = p1;
    const r = Math.sqrt((geo.rx * geo.rx + geo.ry * geo.ry) / 2);
    a.phase = ARC;
    a.task = ROUND;
    a.t0 = simT;
    a.dur = ((p1 - p0) * r) / (ARC_CRUISE * geo.s) + ACCEL_S;
    a.accel = Math.min(0.45, ACCEL_S / a.dur);
    a.hub = to;
    a.node = HUB0 + to;
  }

  /** The next course in the seeded order that no other carrier is filing into or still walking back
   * from (they would meet head-on on its spoke); it also skips the hub the coordinator is checking
   * or walking to (they would cross on it), unless nothing else is free. */
  function pickCourse(a) {
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < order.length; k++) {
        const c = order[(orderPos + k) % order.length];
        if ((courses[c].busy < 0 || courses[c].busy === a.id) && (pass > 0 || !coordinatorAt(c))) {
          orderPos = (orderPos + k + 1) % order.length;
          return c;
        }
      }
    }
    return a.id % NC;
  }

  function coordinatorAt(c) {
    for (let n = 0; n < agents.length; n++) {
      const o = agents[n];
      if (o.role === "coordinator" && o.hub === c && (o.phase === ARC || o.task === CHECK)) return true;
    }
    return false;
  }

  function freeSlot(c) {
    let fading = -1;
    for (let j = 0; j < SLOTS; j++) {
      const st = slotState[leafOf(c, j)];
      if (st === 0) return j;
      if (st === 2) fading = j;
    }
    return fading >= 0 ? fading : 0;
  }

  /** The carrier drops its note: a new leaf in its colour, the oldest one fades, the pip blinks. */
  function file(a) {
    const c = a.course;
    const C = courses[c];
    const li = leafOf(c, a.slot);
    slotState[li] = 1;
    bornAt[li] = simT;
    litAt[li] = simT;
    litCol[li] = a.colorIdx;
    let oldest = -1;
    for (let j = 0; j < SLOTS; j++) {
      const i = leafOf(c, j);
      if (i !== li && slotState[i] === 1 && (oldest < 0 || bornAt[i] < bornAt[oldest])) oldest = i;
    }
    if (oldest >= 0) {
      slotState[oldest] = 2;
      fadeAt[oldest] = simT;
    }
    C.pipAt = simT;
    C.noteAt = simT;
    C.noteLeaf = li;
    C.noteText = nextNoteName(C);
    C.note = noteSprite(C.noteText);
    placeNote(C, li);
    a.carrying = false; // the course stays busy until the carrier is back past the vault
    recent[2] = recent[1];
    recent[1] = recent[0];
    recent[0] = li;
  }

  /**
   * Where the filed note's name goes: the first of NOTE_SPOTS around its leaf (beside it on the
   * outward side first, below it last; above / below slide sideways to stay inside the canvas)
   * that is clear of the canvas edge, the panel, labels, nodes, links and the carrier that just
   * parked on the leaf (its arrow hangs below and to the right of it), else the least crowded one
   * (worst: under that arrow, then on a label, then right on another dot). No allocations.
   */
  function placeNote(C, li) {
    const spr = C.note;
    const lx = bx[li];
    const ly = by[li];
    const hub = parent[li];
    const out = lx >= bx[hub] ? 1 : -1;
    const rl = Math.hypot(lx - bx[hub], ly - by[hub]) || 1;
    const ux = (lx - bx[hub]) / rl; // outward from the hub through the leaf
    const uy = (ly - by[hub]) / rl;
    // the name's ink sits inside its sprite: 1 px each side, ~3 px above and below
    const iw = spr.w - 2;
    const ih = spr.h - 6;
    const ext = Math.abs(ux) * iw * 0.5 + Math.abs(uy) * ih * 0.5; // the ink's half-depth along u
    let bestP = Infinity;
    for (let k = 0; k < NOTE_SPOTS.length; k++) {
      const spot = NOTE_SPOTS[k];
      const kind = spot[0];
      const right = spot[1] * out > 0; // beside / diagonal: on the leaf's right
      let x0; // the ink box's corner, relative to the leaf
      let y0;
      if (kind === 0) {
        x0 = right ? 8 : -8 - iw;
        y0 = -ih / 2 + spot[2];
      } else if (kind === 1) {
        x0 = ux * (spot[1] + ext) - iw / 2;
        y0 = uy * (spot[1] + ext) - ih / 2;
      } else if (kind === 2) {
        x0 = right ? 5 : -5 - iw;
        y0 = spot[2] < 0 ? -9 - ih : 9;
      } else if (kind === 4) {
        // the box's nearest edge `gap` px from the leaf in that direction
        const a = spot[2] * 22.5 * DEG;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        const r = spot[1] + Math.min(Math.abs(dx) > 1e-6 ? iw / 2 / Math.abs(dx) : 1e9, Math.abs(dy) > 1e-6 ? ih / 2 / Math.abs(dy) : 1e9);
        x0 = dx * r - iw / 2;
        y0 = dy * r - ih / 2;
      } else {
        x0 = Math.max(4, Math.min(state.w - 4 - iw, lx - iw / 2)) - lx;
        y0 = spot[2] < 0 ? -12 - ih : 11;
      }
      let p = penalty(lx + x0, ly + y0, lx + x0 + iw, ly + y0 + ih);
      p += 12 * dotsUnder(li, lx + x0, ly + y0, lx + x0 + iw, ly + y0 + ih);
      if (underArrow(x0, y0, x0 + iw, y0 + ih)) p += 50;
      if (p < bestP) {
        bestP = p;
        C.noteDx = x0 - 1;
        C.noteDy = y0 - 3;
        if (p === 0) return;
      }
    }
  }

  /** A returning carrier is back past the vault: its course is free for the next filing. */
  function releaseCourse(a) {
    if (a.course >= 0 && courses[a.course].busy === a.id) courses[a.course].busy = -1;
  }

  /** How many dots (other nodes, as drawn, plus 1.5 px for their breathing) a box would cover. */
  function dotsUnder(skip, x0, y0, x1, y1) {
    let n = 0;
    for (let i = 0; i < N; i++) {
      if (i === skip) continue;
      const r = (i === VAULT ? 6 : i === INBOX ? 4 : i < LEAF0 ? HUB_R : LEAF_R + 0.4) + 1.5;
      const dx = bx[i] < x0 ? x0 - bx[i] : bx[i] > x1 ? bx[i] - x1 : 0;
      const dy = by[i] < y0 ? y0 - by[i] : by[i] > y1 ? by[i] - y1 : 0;
      if (dx * dx + dy * dy < r * r) n++;
    }
    return n;
  }

  function arrive(a) {
    if (a.phase === TRAVEL && a.carrying) traceTrip(a, a.n - 1); // the rest of the route it walked
    a.phase = PAUSE;
    if (a.task === TO_INBOX) {
      releaseCourse(a);
      a.task = PICKUP;
      a.until = simT + PICKUP_S;
      a.pickAt = simT + 0.4;
    } else if (a.task === TO_VAULT) {
      a.task = SORT;
      a.until = simT + SORT_S;
    } else if (a.task === TO_LEAF) {
      a.task = FILE;
      file(a);
      a.until = simT + FILE_S;
    } else if (a.task === ROUND) {
      a.task = CHECK;
      a.arcEnd = simT;
      courses[a.hub].pingAt = simT;
      a.until = simT + CHECK_S;
    }
  }

  function depart(a) {
    if (a.task === PICKUP) {
      if (!a.carrying) {
        a.until = simT + 0.25; // nothing to take yet: wait for the next note
        return;
      }
      if (!mayLeaveInbox(a)) {
        a.until = simT + RETRY_S; // the other carrier has the vault: wait at the inbox
        return;
      }
      startTrip(a, INBOX, VAULT, TO_VAULT);
    } else if (a.task === SORT) {
      const c = pickCourse(a);
      a.course = c;
      courses[c].busy = a.id;
      a.slot = freeSlot(c);
      startTrip(a, VAULT, leafOf(c, a.slot), TO_LEAF);
    } else if (a.task === FILE) {
      if (!mayLeaveLeaf(a)) {
        a.until = simT + RETRY_S; // the inbox or the vault is the other carrier's: stay at the leaf
        return;
      }
      // the course stays its own until it is back past the vault, so no one is sent down the
      // spoke it is walking up
      const hub = parent[a.node];
      const dV = dist(a.node, hub) + dist(hub, VAULT);
      a.releaseAt = simT + tripTimeAt(dV + dist(VAULT, INBOX), dV + VAULT_ZONE);
      startTrip(a, a.node, INBOX, TO_INBOX);
    } else if (a.task === CHECK) {
      startArc(a);
    }
  }

  function takeNote() {
    for (let k = 0; k < qn - 1; k++) qd[k] = qd[k + 1];
    qn--;
  }

  function stepSim(dt) {
    // notes arrive at the inbox every few seconds while there is room
    if (qn < Q_MAX && simT >= qNext) {
      qd[qn++] = 70;
      qNext = simT + 4.4 + rng() * 2.8;
    }
    const kq = 1 - Math.exp(-dt * 2.2);
    for (let k = 0; k < qn; k++) qd[k] += (12 + k * 6.5 - qd[k]) * kq;

    for (let i = LEAF0; i < N; i++) {
      if (slotState[i] === 2 && simT - fadeAt[i] >= FADE_S) slotState[i] = 0;
    }

    for (let n = 0; n < agents.length; n++) {
      const a = agents[n];
      if (a.phase !== PAUSE) {
        if (a.task === TO_INBOX && simT >= a.releaseAt) releaseCourse(a);
        if (simT - a.t0 >= a.dur) arrive(a);
        continue;
      }
      if (a.task === PICKUP && !a.carrying && simT >= a.pickAt && qn > 0) {
        takeNote();
        a.carrying = true;
        a.until = Math.max(a.until, simT + 0.5);
      }
      if (simT >= a.until) depart(a);
    }
  }

  /** Hands the route segments before segment `upTo` to the trace (each one once per trip). */
  function traceTrip(a, upTo) {
    for (; a.legDone < upTo && a.legDone < a.n - 1; a.legDone++) {
      const i = a.path[a.legDone];
      const j = a.path[a.legDone + 1];
      const child = parent[j] === i ? j : i; // a link is stored at its child node
      traceAt[child] = simT;
      traceCol[child] = a.colorIdx;
    }
  }

  const parkedAt = (a, node) => agents.some((o) => o !== a && o.phase === PAUSE && o.node === node);

  /**
   * Still frame: every travelling agent finishes its trip at once (parked at a node). If another
   * agent is already parked where the trip ends, it stays where the trip began instead (as if it
   * had not set off yet), so two agents never share a node in the still.
   */
  function settle() {
    for (const a of agents) {
      if (a.phase === TRAVEL && parkedAt(a, a.node) && !parkedAt(a, a.path[0])) {
        a.phase = PAUSE;
        a.node = a.path[0];
        if (a.task === TO_VAULT) {
          a.task = PICKUP; // still holding its note
          a.until = simT + PICKUP_S;
        } else if (a.task === TO_LEAF) {
          a.task = SORT;
          a.until = simT + SORT_S;
          if (a.course >= 0 && courses[a.course].busy === a.id) courses[a.course].busy = -1;
        } else {
          a.task = FILE;
          a.until = simT + FILE_S;
          if (a.course >= 0 && courses[a.course].busy < 0) courses[a.course].busy = a.id;
        }
      } else if (a.phase !== PAUSE) {
        arrive(a);
      }
      if (a.task === PICKUP && !a.carrying && qn > 0) {
        takeNote();
        a.carrying = true;
      }
    }
    for (let i = LEAF0; i < N; i++) if (slotState[i] === 2) slotState[i] = 0;
    for (let k = 0; k < qn; k++) qd[k] = 12 + k * 6.5;
  }

  /* positions ---------------------------------------------------------------------------------- */

  // The canvas origin on screen is cached; scroll, resize and layout changes mark it dirty (and it
  // is refreshed once a second regardless), so the frame loop never forces a layout read.
  const pointer = { x: 0, y: 0, active: false, left: 0, top: 0, dirty: true, readAt: -1e4 };

  function updatePositions(dt) {
    let px = 0;
    let py = 0;
    let usePointer = false;
    if (pointer.active && !still) {
      if (pointer.dirty || clock - pointer.readAt > 1) {
        const r = canvas.getBoundingClientRect();
        pointer.left = r.left;
        pointer.top = r.top;
        pointer.dirty = false;
        pointer.readAt = clock;
      }
      px = pointer.x - pointer.left;
      py = pointer.y - pointer.top;
      usePointer = px > -PUSH_R && py > -PUSH_R && px < state.w + PUSH_R && py < state.h + PUSH_R;
    }
    const k = 1 - Math.exp(-dt * 4);
    for (let i = 0; i < N; i++) {
      if (i < LEAF0) {
        X[i] = bx[i];
        Y[i] = by[i];
        continue;
      }
      let tx = 0;
      let ty = 0;
      if (usePointer) {
        const dx = bx[i] - px;
        const dy = by[i] - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < PUSH_R * PUSH_R && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const f = 1 - d / PUSH_R;
          tx = (dx / d) * f * f * PUSH;
          ty = (dy / d) * f * f * PUSH;
        }
      }
      if (still) {
        pushX[i] = 0;
        pushY[i] = 0;
      } else {
        pushX[i] += (tx - pushX[i]) * k;
        pushY[i] += (ty - pushY[i]) * k;
      }
      X[i] = bx[i] + DRIFT * Math.sin(clock * driftW1[i] + driftP1[i]) + pushX[i];
      Y[i] = by[i] + DRIFT * Math.sin(clock * driftW2[i] + driftP2[i]) + pushY[i];
    }
  }

  function placeAgent(a) {
    if (a.phase === PAUSE) {
      a.x = X[a.node];
      a.y = Y[a.node];
      return;
    }
    const f = travelProfile((simT - a.t0) / a.dur, a.accel);
    if (a.phase === ARC) {
      const p = a.arcFrom + (a.arcTo - a.arcFrom) * f;
      a.x = geo.vx + geo.rx * Math.cos(p);
      a.y = geo.vy + geo.ry * Math.sin(p);
      return;
    }
    const p = a.path;
    const n = a.n;
    let total = 0;
    for (let k = 0; k < n - 1; k++) {
      const dx = X[p[k + 1]] - X[p[k]];
      const dy = Y[p[k + 1]] - Y[p[k]];
      a.seg[k] = Math.sqrt(dx * dx + dy * dy);
      total += a.seg[k];
    }
    const d = f * total;
    let k = 0;
    let acc = 0;
    while (k < n - 2 && acc + a.seg[k] < d) acc += a.seg[k++];
    const L = a.seg[k] || 1;
    const into = d - acc;
    a.legK = k;
    a.legU = Math.min(1, Math.max(0, into / L));
    if (a.carrying) traceTrip(a, k);
    // round the corner through the node at either end of this segment
    if (k > 0 && into < cornerR(a, k)) return corner(a, k, into + cornerR(a, k));
    if (k + 1 < n - 1 && L - into < cornerR(a, k + 1)) return corner(a, k + 1, cornerR(a, k + 1) - (L - into));
    const u = Math.min(1, Math.max(0, into / L));
    a.x = X[p[k]] + (X[p[k + 1]] - X[p[k]]) * u;
    a.y = Y[p[k]] + (Y[p[k + 1]] - Y[p[k]]) * u;
  }

  /** Corner radius at waypoint w (between segments w-1 and w). */
  function cornerR(a, w) {
    return Math.min(CORNER, a.seg[w - 1] * 0.5, a.seg[w] * 0.5);
  }

  /** Quadratic blend through waypoint w; e runs 0 … 2r across the corner. */
  function corner(a, w, e) {
    const r = cornerR(a, w);
    const p = a.path;
    const wx = X[p[w]];
    const wy = Y[p[w]];
    const inL = a.seg[w - 1] || 1;
    const outL = a.seg[w] || 1;
    const x0 = wx + ((X[p[w - 1]] - wx) / inL) * r;
    const y0 = wy + ((Y[p[w - 1]] - wy) / inL) * r;
    const x2 = wx + ((X[p[w + 1]] - wx) / outL) * r;
    const y2 = wy + ((Y[p[w + 1]] - wy) / outL) * r;
    const u = r > 0 ? Math.min(1, Math.max(0, e / (2 * r))) : 1;
    const v = 1 - u;
    a.x = v * v * x0 + 2 * u * v * wx + u * u * x2;
    a.y = v * v * y0 + 2 * u * v * wy + u * u * y2;
  }

  /* rendering ---------------------------------------------------------------------------------- */

  const grown = () => growT >= GROW_S * growK;
  /** Grow progress of an element that appears from t0 for d seconds (full-grow seconds). */
  function gp(t0, d) {
    if (still || growT >= GROW_S * growK) return 1;
    const u = (growT - t0 * growK) / (d * growK);
    return u <= 0 ? 0 : u >= 1 ? 1 : 1 - (1 - u) * (1 - u) * (1 - u);
  }

  /** Leaf presence 0…1 (for its spoke and its dot) including the grow-in. */
  function leafPresence(i) {
    const st = slotState[i];
    if (st === 0) return 0;
    const c = courseOf[i];
    const j = i - LEAF0 - c * SLOTS;
    let p = gp(0.85 + 0.13 * c + 0.05 * j, 0.45);
    if (still) return st === 1 ? 1 : 0;
    const age = simT - bornAt[i];
    if (age >= 0 && age < NEW_S) p = Math.min(p, easeOut(age / NEW_S));
    if (st === 2) p = Math.min(p, 1 - easeInOut(Math.min(1, (simT - fadeAt[i]) / FADE_S)));
    return p;
  }

  function lit(i) {
    let v = Math.exp(-(simT - litAt[i]) / LIT_TAU);
    if (still) {
      const r = recent.indexOf(i);
      if (r >= 0) v = Math.max(v, r === 0 ? 0.8 : r === 1 ? 0.5 : 0.32);
    }
    return v > 1 ? 1 : v;
  }

  const leafP = new Float32Array(N);

  function draw() {
    const w = state.w;
    const h = state.h;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!state.shown) return;
    // pulses, pings, trails and note names only once the map has grown (the sim clock is paused
    // while it grows, so a rebuild would otherwise freeze them mid-air)
    const live = !still && grown();
    const vx = bx[VAULT];
    const vy = by[VAULT];
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;

    // orbit ring: a dashed construction line, drawn clockwise from the top
    const ringP = gp(0.25, 1.2);
    if (ringP > 0) {
      ctx.setLineDash(DASH_RING);
      ctx.strokeStyle = LINE_RING;
      ctx.beginPath();
      ctx.ellipse(vx, vy, geo.rx, geo.ry, 0, -Math.PI / 2, -Math.PI / 2 + TAU * ringP);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
      // the coordinator's rounds: the stretch it is walking lights up, then fades once it arrives
      if (live) {
        for (let n = 0; n < agents.length; n++) {
          const a = agents[n];
          if (a.role !== "coordinator") continue;
          const walking = a.phase === ARC;
          const fade = walking ? 1 : 1 - (simT - a.arcEnd) / 1.8;
          if (fade <= 0) continue;
          const head = walking ? a.arcFrom + (a.arcTo - a.arcFrom) * travelProfile((simT - a.t0) / a.dur, a.accel) : a.arcTo;
          ctx.globalAlpha = fade;
          ctx.strokeStyle = LINE_TRAIL;
          ctx.beginPath();
          ctx.ellipse(vx, vy, geo.rx, geo.ry, 0, a.arcFrom, head);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    // vault → courses, vault → inbox
    ctx.strokeStyle = LINE_MAIN;
    ctx.beginPath();
    for (let c = 0; c < NC; c++) lineOut(vx, vy, X[HUB0 + c], Y[HUB0 + c], gp(0.2 + 0.13 * c, 0.55));
    lineOut(vx, vy, X[INBOX], Y[INBOX], gp(1.0, 0.45));
    ctx.stroke();

    // incoming stub beyond the inbox (fades out toward the edge)
    const stubP = gp(1.45, 0.4);
    if (stubP > 0) {
      ctx.setLineDash(DASH_STUB);
      ctx.strokeStyle = stubGrad;
      ctx.beginPath();
      lineOut(X[INBOX] + geo.stubX * 8, Y[INBOX] + geo.stubY * 8, X[INBOX] + geo.stubX * 74, Y[INBOX] + geo.stubY * 74, stubP);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
    }

    // spokes course → leaf
    ctx.strokeStyle = LINE_LEAF;
    ctx.beginPath();
    for (let i = LEAF0; i < N; i++) {
      const p = (leafP[i] = leafPresence(i));
      if (p <= 0) continue;
      const hub = parent[i];
      lineOut(X[hub], Y[hub], X[i], Y[i], p);
    }
    ctx.stroke();

    // the route a carrier just walked with its note (inbox → vault → hub → leaf): a faint trace in
    // its colour that fades behind it, and the leg it is on, up to where it is
    if (live) {
      for (let i = 1; i < N; i++) {
        const age = simT - traceAt[i];
        if (age < 0 || age >= TRACE_S) continue;
        const pa = parent[i];
        ctx.globalAlpha = TRACE_ALPHA * (1 - easeInOut(age / TRACE_S));
        ctx.strokeStyle = PALETTE[traceCol[i]];
        ctx.beginPath();
        ctx.moveTo(X[pa], Y[pa]);
        ctx.lineTo(X[i], Y[i]);
        ctx.stroke();
      }
      ctx.globalAlpha = TRACE_ALPHA;
      for (let n = 0; n < agents.length; n++) {
        const a = agents[n];
        if (a.phase !== TRAVEL || !a.carrying || a.legU <= 0) continue;
        const i = a.path[a.legK];
        const j = a.path[a.legK + 1];
        ctx.strokeStyle = a.color;
        ctx.beginPath();
        lineOut(X[i], Y[i], X[j], Y[j], a.legU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // leaves: resting dots (one fill), then the colour of recent filings on top
    ctx.fillStyle = INK;
    ctx.globalAlpha = LEAF_ALPHA;
    ctx.beginPath();
    for (let i = LEAF0; i < N; i++) {
      const p = leafP[i];
      if (p < 0.6) continue; // the dot pops in once its spoke has (nearly) arrived
      const r = LEAF_R * easeOut((p - 0.6) / 0.4);
      ctx.moveTo(X[i] + r, Y[i]);
      ctx.arc(X[i], Y[i], r, 0, TAU);
    }
    ctx.fill();
    for (let i = LEAF0; i < N; i++) {
      if (leafP[i] < 0.6) continue;
      const l = lit(i);
      if (l < 0.02) continue;
      ctx.globalAlpha = l;
      ctx.fillStyle = PALETTE[litCol[i]];
      ctx.beginPath();
      ctx.arc(X[i], Y[i], LEAF_R * easeOut((leafP[i] - 0.6) / 0.4) + 0.35 * l, 0, TAU);
      ctx.fill();
      // filing pulse: one thin ring, once
      const age = simT - litAt[i];
      if (live && age >= 0 && age < 1.1) {
        const u = age / 1.1;
        ctx.globalAlpha = 0.55 * (1 - u) * (1 - u);
        ctx.strokeStyle = PALETTE[litCol[i]];
        ctx.beginPath();
        ctx.arc(X[i], Y[i], 2.5 + 8 * easeOut(u), 0, TAU);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // course hubs
    ctx.fillStyle = BG;
    ctx.strokeStyle = HUB_STROKE;
    ctx.beginPath();
    for (let c = 0; c < NC; c++) {
      const r = HUB_R * gp(0.62 + 0.13 * c, 0.3);
      if (r <= 0.05) continue;
      ctx.moveTo(X[HUB0 + c] + r, Y[HUB0 + c]);
      ctx.arc(X[HUB0 + c], Y[HUB0 + c], r, 0, TAU);
    }
    ctx.fill();
    ctx.stroke();
    if (live) {
      for (let c = 0; c < NC; c++) {
        const age = simT - courses[c].pingAt;
        if (age < 0 || age >= 1.3) continue;
        const u = age / 1.3;
        ctx.globalAlpha = 0.42 * (1 - u) * (1 - u);
        ctx.strokeStyle = PALETTE[courses[c].pingCol];
        ctx.beginPath();
        ctx.arc(X[HUB0 + c], Y[HUB0 + c], HUB_R + 1.5 + 8 * easeOut(u), 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // vault
    const vP = gp(0, 0.4);
    if (vP > 0) {
      const S = vaultSprite.w * (0.7 + 0.3 * vP);
      ctx.globalAlpha = vP;
      ctx.drawImage(vaultSprite.img, vx - S / 2, vy - S / 2, S, S);
      ctx.globalAlpha = 1;
    }

    // inbox: a small square, the waiting notes stacked along the incoming stub
    const iP = gp(1.35, 0.25);
    if (iP > 0) {
      const ix = X[INBOX];
      const iy = Y[INBOX];
      const r = 3.5 * iP;
      ctx.fillStyle = BG;
      ctx.strokeStyle = HUB_STROKE;
      ctx.fillRect(ix - r, iy - r, r * 2, r * 2);
      ctx.strokeRect(ix - r, iy - r, r * 2, r * 2);
      const qP = gp(1.6, 0.3);
      if (qP > 0) {
        ctx.fillStyle = INK;
        for (let k = 0; k < qn; k++) {
          const d = qd[k];
          ctx.globalAlpha = 0.6 * qP * Math.min(1, Math.max(0, (60 - d) / 22));
          ctx.fillRect(ix + geo.stubX * d - 1.5, iy + geo.stubY * d - 2, 3, 4);
        }
        ctx.globalAlpha = 1;
      }
    }

    // labels and status pips; every text sprite's corner sits on a device pixel (snap), so it is
    // blitted 1:1 and never resampled soft
    const dpr = state.dpr;
    const snap = (v) => Math.round(v * dpr) / dpr;
    for (let c = 0; c < NC; c++) {
      const a = gp(0.8 + 0.13 * c, 0.45);
      if (a <= 0) continue;
      const box = tagBoxes[c];
      const hx = bx[HUB0 + c];
      const hy = by[HUB0 + c];
      const tx = snap(hx + box.x0 + PIP_W - 1); // the text; the pip keeps its place in front of it
      const lx = tx - PIP_W + 1;
      const ly = hy + (box.y0 + box.y1) / 2;
      const spr = courseLabels[c];
      ctx.globalAlpha = a * COURSE_ALPHA;
      ctx.drawImage(spr.img, tx, snap(ly - spr.h / 2), spr.dw, spr.dh);
      const age = simT - courses[c].pipAt;
      let g = age >= 0 ? Math.exp(-age / PIP_TAU) : 0;
      if (still && recent[0] >= 0 && courseOf[recent[0]] === c) g = Math.max(g, 0.7);
      if (age >= 0 && age < 0.12 && !still) g *= age / 0.12;
      ctx.fillStyle = GREEN;
      ctx.globalAlpha = a * (PIP_REST + (1 - PIP_REST) * g);
      ctx.beginPath();
      ctx.arc(lx + 2.5, ly, 2, 0, TAU);
      ctx.fill();
    }
    const vlA = gp(0.3, 0.4);
    if (vlA > 0) {
      ctx.globalAlpha = vlA * LABEL_ALPHA;
      const ly = vy + (vaultTag.y0 + vaultTag.y1) / 2;
      ctx.drawImage(vaultLabel.img, snap(vx + vaultTag.x0 - 1), snap(ly - vaultLabel.h / 2), vaultLabel.dw, vaultLabel.dh);
    }
    const ilA = gp(1.45, 0.4);
    if (ilA > 0) {
      ctx.globalAlpha = ilA * LABEL_ALPHA;
      ctx.drawImage(inboxLabel.img, snap(X[INBOX] - 11 - inboxLabel.tw - 1), snap(Y[INBOX] - inboxLabel.h / 2), inboxLabel.dw, inboxLabel.dh);
    }

    // the name of the note that was just filed, briefly, beside its new leaf (the still frame
    // keeps the latest one, so the picture also says that an agent just filed a note)
    if (live) {
      for (let c = 0; c < NC; c++) {
        const C = courses[c];
        const age = simT - C.noteAt;
        if (!C.note || age < 0 || age > 3.6) continue;
        const a = Math.min(1, age / 0.35) * Math.min(1, (3.6 - age) / 0.9);
        const i = C.noteLeaf;
        const spr = C.note;
        ctx.globalAlpha = a * NOTE_ALPHA;
        ctx.drawImage(spr.img, snap(X[i] + C.noteDx), snap(Y[i] + C.noteDy), spr.dw, spr.dh);
      }
    } else if (still && recent[0] >= 0) {
      const C = courses[courseOf[recent[0]]];
      if (C.note && C.noteLeaf === recent[0]) {
        const i = C.noteLeaf;
        ctx.globalAlpha = NOTE_ALPHA;
        ctx.drawImage(C.note.img, snap(X[i] + C.noteDx), snap(Y[i] + C.noteDy), C.note.dw, C.note.dh);
      }
    }

    // agents (and the note a carrier is dragging), on device pixels so slow motion never steps
    const agA = gp(1.7, 0.5);
    if (agA > 0) {
      for (let n = 0; n < agents.length; n++) {
        const a = agents[n];
        const s = a.sprite;
        const sx = snap(a.x + 1.5 - s.ax); // the bitmap's corner on a device pixel
        const sy = snap(a.y + 1.5 - s.ay);
        if (a.carrying) {
          ctx.globalAlpha = agA * 0.9;
          ctx.fillStyle = "#e9ebef";
          ctx.fillRect(sx + s.ax + 9, sy + s.ay + 12, 4, 5);
        }
        ctx.globalAlpha = agA;
        ctx.drawImage(s.img, sx, sy, s.dw, s.dh);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Adds a line from (x0,y0) toward (x1,y1), drawn out to fraction p, to the current path. */
  function lineOut(x0, y0, x1, y1, p) {
    if (p <= 0) return;
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + (x1 - x0) * p, y0 + (y1 - y0) * p);
  }

  /* loop --------------------------------------------------------------------------------------- */

  let rafId = 0;
  let running = false;
  let lastFrame = 0;

  const shouldRun = () =>
    state.animate && state.inView && state.pageVisible && state.shown && !state.disposed && !state.broken && state.w > 0 && state.h > 0;

  function frame(dt) {
    const t0 = performance.now();
    still = false;
    clock += dt;
    if (!grown()) {
      growT += dt;
    } else {
      simT += dt;
      stepSim(dt);
    }
    updatePositions(dt);
    for (let k = 0; k < agents.length; k++) placeAgent(agents[k]);
    draw();
    const ms = performance.now() - t0;
    stats.frames++;
    stats.drawMsTotal += ms;
    if (ms > stats.drawMsMax) stats.drawMsMax = ms;
    if (debug) recordAgents();
  }

  /** Debug only: where the agents are (tests check that they never stack). */
  function recordAgents() {
    const p = stats.agents || (stats.agents = new Float32Array(agents.length * 2));
    for (let k = 0; k < agents.length; k++) {
      p[k * 2] = agents[k].x;
      p[k * 2 + 1] = agents[k].y;
    }
  }

  // Pacing: a frame is due every FRAME_MS. On a 120 / 144 Hz screen most rAF callbacks find
  // nothing due and return; the due time advances by whole frames, so the average stays at 60 fps
  // (a plain "elapsed ≥ cap" test would drop to ~45 fps there). More than a frame behind: resync.
  let nextDue = 0;
  function tick(now) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    if (now < nextDue - 1.5) return; // tolerance for rAF timestamp jitter on 60 Hz screens
    nextDue = now - nextDue > FRAME_MS ? now + FRAME_MS : nextDue + FRAME_MS;
    const elapsed = now - lastFrame;
    lastFrame = now;
    try {
      frame(Math.min(elapsed / 1000, 0.1)); // clamp: a long stall never jumps the motion
    } catch (err) {
      state.broken = true;
      running = false;
      cancelAnimationFrame(rafId);
      console.warn("[herograph] render loop stopped.", err);
    }
  }

  function syncLoop() {
    const want = shouldRun();
    if (want && !running) {
      running = true;
      lastFrame = performance.now() - FRAME_MS;
      nextDue = 0; // draw on the very next frame
      rafId = requestAnimationFrame(tick);
    } else if (!want && running) {
      running = false;
      cancelAnimationFrame(rafId);
    }
  }

  /** One complete still: fully grown, agents parked at nodes, the latest filings lit. */
  function renderStill() {
    if (state.disposed || state.broken || state.w === 0) return;
    try {
      settle();
      growT = GROW_S * growK;
      still = true;
      updatePositions(0);
      for (const a of agents) placeAgent(a);
      draw();
      if (debug) recordAgents();
    } catch (err) {
      state.broken = true;
      console.warn("[herograph] could not draw the still frame.", err);
    } finally {
      still = false;
    }
  }

  /* reveal: grow in when the build reveals the hero layer ------------------------------------ */

  function isShown() {
    if (!root.classList.contains("build-pending") || !layer) return true;
    return layer.classList.contains("is-built") || layer.classList.contains("is-building");
  }

  function onReveal() {
    pointer.dirty = true; // the build may have moved the hero
    const shown = isShown();
    if (shown === state.shown) return;
    state.shown = shown;
    if (shown) {
      growT = 0;
      // Revealed by the build (it is still running): the full grow. Page revealed at once
      // (skip, build finished, fail-safe): the short one.
      growK = root.classList.contains("build-pending") ? 1 : GROW_SHORT;
      if (!state.animate) renderStill();
    } else {
      growT = 0; // a rebuild hid the layer again: grow again on the next reveal
      draw();
    }
    syncLoop();
  }

  const mo = new MutationObserver(onReveal);
  mo.observe(root, { attributes: true, attributeFilter: ["class"] });
  if (layer) mo.observe(layer, { attributes: true, attributeFilter: ["class"] });
  cleanups.push(() => mo.disconnect());
  growK = GROW_SHORT; // shown at mount (no build): a short grow

  /* sizing ------------------------------------------------------------------------------------- */

  function resize() {
    if (state.disposed) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    // the backing store follows the screen (phones included, so labels and hairlines stay crisp);
    // only a canvas that would get very large at 3× drops to 2×
    let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (dpr > 2 && w * h * dpr * dpr > MAX_BACKING) dpr = 2;
    const dprChanged = dpr !== state.dpr;
    state.w = w;
    state.h = h;
    state.dpr = dpr;
    if (w === 0 || h === 0) {
      syncLoop();
      return;
    }
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    if (dprChanged || !vaultSprite) buildSprites();
    layout();
    if (!running && state.shown) {
      if (state.animate) draw();
      else renderStill();
    }
    syncLoop();
  }

  // The container, the panel, the window and DPR changes all report separately: one layout per
  // frame, from a single rAF batch.
  let resizeQueued = false;
  let resizeRaf = 0;
  function queueResize() {
    pointer.dirty = true;
    if (resizeQueued || state.disposed) return;
    resizeQueued = true;
    resizeRaf = requestAnimationFrame(() => {
      resizeQueued = false;
      resize();
    });
  }
  cleanups.push(() => cancelAnimationFrame(resizeRaf));
  const ro = new ResizeObserver(queueResize);
  ro.observe(container);
  if (panel) ro.observe(panel);
  cleanups.push(() => ro.disconnect());

  window.addEventListener("resize", queueResize, { passive: true });
  cleanups.push(() => window.removeEventListener("resize", queueResize));

  // DPR changes (browser zoom, moving the window to another screen): a resolution query for the
  // current ratio fires once when it stops matching; it is then re-armed for the new ratio.
  let dprQuery = null;
  const unwatchDpr = () => {
    if (!dprQuery) return;
    if (dprQuery.removeEventListener) dprQuery.removeEventListener("change", onDprChange);
    else if (dprQuery.removeListener) dprQuery.removeListener(onDprChange);
    dprQuery = null;
  };
  function watchDpr() {
    unwatchDpr();
    if (state.disposed || !window.matchMedia) return;
    try {
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      if (dprQuery.addEventListener) dprQuery.addEventListener("change", onDprChange);
      else if (dprQuery.addListener) dprQuery.addListener(onDprChange);
    } catch {
      dprQuery = null;
    }
  }
  function onDprChange() {
    watchDpr();
    queueResize();
  }
  watchDpr();
  cleanups.push(unwatchDpr);

  const onScroll = () => {
    pointer.dirty = true;
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  cleanups.push(() => window.removeEventListener("scroll", onScroll));

  // Labels are drawn into sprites: redraw them once the mono face has loaded.
  if (document.fonts && document.fonts.load) {
    document.fonts
      .load(`500 ${LABEL_PX}px "JetBrains Mono"`)
      .then(() => {
        if (state.disposed || state.w === 0) return;
        buildSprites();
        layout();
        if (!running && state.shown) state.animate ? draw() : renderStill();
      })
      .catch(() => {});
  }

  /* visibility --------------------------------------------------------------------------------- */

  const io = new IntersectionObserver(
    (entries) => {
      state.inView = entries[entries.length - 1].isIntersecting;
      pointer.dirty = true;
      syncLoop();
    },
    { rootMargin: "80px 0px" }
  );
  io.observe(container);
  cleanups.push(() => io.disconnect());

  const onVisibility = () => {
    state.pageVisible = !document.hidden;
    syncLoop();
  };
  document.addEventListener("visibilitychange", onVisibility);
  cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));

  /* pointer: nearby leaves ease a few px away (fine pointers only) ----------------------------- */

  if (finePointer) {
    const onMove = (e) => {
      if (e.pointerType === "touch") return;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.active = true;
    };
    const onOut = (e) => {
      if (!e.relatedTarget) pointer.active = false;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerout", onOut, { passive: true });
    cleanups.push(() => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerout", onOut);
    });
  }

  /* start -------------------------------------------------------------------------------------- */

  resize();
  if (!state.animate && state.shown) renderStill();
  syncLoop();

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    running = false;
    cancelAnimationFrame(rafId);
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
        if (state.shown) renderStill();
      }
      syncLoop();
    },
    dispose,
  };
}

/* ── helpers ─────────────────────────────────────────────────────────────────────────────────── */

/** Test counters are exposed only on request: localStorage ktr0a:debug = "1" or ?debug in the URL. */
function debugOn() {
  try {
    if (localStorage.getItem("ktr0a:debug") === "1") return true;
  } catch {
    /* storage blocked */
  }
  try {
    return new URLSearchParams(location.search).has("debug");
  } catch {
    return false;
  }
}

function runCleanups(list) {
  for (let k = list.length - 1; k >= 0; k--) {
    try {
      list[k]();
    } catch {
      /* keep tearing down */
    }
  }
  list.length = 0;
}

/** Accelerate, cruise, decelerate: position 0…1 for time u 0…1 with sine ramps over a fraction a at each end. */
function travelProfile(u, a) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const vmax = 1 / (1 - a);
  if (u < a) return vmax * (u / 2 - (a / (2 * Math.PI)) * Math.sin((Math.PI * u) / a));
  if (u > 1 - a) return 1 - travelProfile(1 - u, a);
  return vmax * (a / 2 + (u - a));
}

/** The inverse of travelProfile: the time u (0…1) at which position f is reached (bisection). */
function invProfile(f, a) {
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 22; k++) {
    const m = (lo + hi) / 2;
    if (travelProfile(m, a) < f) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

function easeOut(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const v = 1 - u;
  return 1 - v * v * v;
}

function easeInOut(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * (3 - 2 * u);
}

// The arrow of an agent parked on a node, relative to the node (its tip 1.5 px down and right of
// it, as drawn), so the name of a note just filed stays out from under the carrier that filed it.
const PARKED_ARROW = ARROW.map(([x, y]) => [1.5 + x * AGENT_SCALE, 1.5 + y * AGENT_SCALE]);
const PARKED_X1 = Math.max(...PARKED_ARROW.map((p) => p[0]));
const PARKED_Y1 = Math.max(...PARKED_ARROW.map((p) => p[1]));

/** Does a box (px, relative to the node) come within 1.5 px (rim and shadow) of the parked arrow? */
function underArrow(x0, y0, x1, y1) {
  const xa = Math.max(x0 - 1.5, 1.5);
  const xb = Math.min(x1 + 1.5, PARKED_X1);
  const ya = Math.max(y0 - 1.5, 1.5);
  const yb = Math.min(y1 + 1.5, PARKED_Y1);
  for (let y = ya; y <= yb; y += 1) {
    for (let x = xa; x <= xb; x += 1) if (inPolygon(PARKED_ARROW, x, y)) return true;
  }
  return false;
}

function inPolygon(P, x, y) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const xi = P[i][0];
    const yi = P[i][1];
    const xj = P[j][0];
    const yj = P[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
