/* ═══════════════════════════════════════════════════════════════════════════
   director.js: the "rebuilt live by agents" engine (SPEC §1, §4, §5)

   Planner    collects [data-layer] elements in document order, measures them
              (document space, or viewport space inside position:fixed ancestors)
              and derives one task per layer. Dependencies: a child waits for its
              parent box's wireframe; clone-group members wait for their source,
              whose agent then "pastes" into them (clone-then-edit).
   Scheduler  hands ready tasks to idle agents. A token bucket releases work at the
              rate that lands the whole page on the target duration, so the timeline
              is stable whatever the layer count; the swarm grows when agents run
              short (19 → 44 on desktop, 10 → 22 on mobile).
   Tour       auto-scrolls after the swarm: the median of the work in progress sits
              mid-viewport, the oldest unfinished layer never leaves the screen, and
              a work-weighted schedule pulls the camera on if a slow chain would
              stall it (≤ 900 px/s at 1x). Visible work is taken first; idle agents
              pre-build up to ~2 screens ahead. Any user scroll turns the tour off.
   Phases     idle → boot (orbit around the logo) → build (scatter, then work) → done
              (agents depart, HUD summary). skip() fast-forwards, replay() restarts.

   Choreography is written as generator "jobs" that yield waits in BUILD time
   (real dt × speed), all driven by ONE rAF loop. A cancelled job runs its
   `finally` blocks, which is where every DOM mutation is undone, so skip/replay/
   errors always leave the original markup behind.

   Public API (SPEC §5):
     createDirector({ root=document, scroller, sfx, speed, onState }) → {
       start({ speed, tour }),   // the automatic build; tour:false leaves the camera where it is
       replay({ speed=1, tour=true }),   // Rebuild / Replay / R: the default animation from the top
       skip(), setSpeed(1|2|4), setTour(bool), destroy(),   // setSpeed/setTour: this run only
       get state(), get speed(), get tour(),
       inspect()   // read-only debug snapshot (scheduler stats)
     }
   Nothing here touches localStorage except reading 'ktr0a:anim' (main.js owns the visit settings).
   ═══════════════════════════════════════════════════════════════════════════ */

import { createSwarm, PALETTE } from "./agents.js";
import { createOverlay } from "./overlay.js";
import { beginType, selectWord, cloneText, selectAll, countChars, longestWordIndex, styleSnapshot } from "./typer.js";
import { createHud } from "./hud.js";

const SPEEDS = [1, 2, 4];

const BOOT_DUR = 1.5; // orbiting the logo tile
const LATE_BOOT_DUR = 0.7; // shorter orbit when the engine starts late (slow network): content first
const LATE_START_MS = 2500; // "late" = the director starts this long after navigation start
const SCATTER_DUR = 0.3; // burst; the first wave of tasks is handed out at its start
const FIRST_WAVE = 8; // work tokens released at the burst (≈ 7–9 agents fly straight to wireframes)
const BUILD_TARGET = 13.2; // first task → last layer (planned), in build seconds; ≈ 20 s total at 1x
const TOUR_MAX_SPEED = 900; // px per build-second (desktop)
const TOUR_MAX_SPEED_MOBILE = 650; // phones: fewer agents, so a gentler camera
const TOUR_ANCHOR = 0.35; // next ready work sits this far down the viewport when little is in progress
const TOUR_CENTER = 0.62; // where the median of the work in progress sits in the viewport (lower half: the
// camera shows the line being edited with finished work above it, and never runs ahead of the build)
const TOUR_LOOKAHEAD = 1.3; // screens below the viewport top agents may take work during the tour (small: the camera
// shows the line being edited, not work that already happened below the fold)
const AHEAD_LIMIT = 2.0; // spare agents may pre-build at most this many screens below the viewport top (beyond
// that they wait on screen: the camera shows the line being edited instead of chasing work far below)
const AHEAD_LIMIT_MOBILE = 2.2; // a phone screen holds fewer layers, so the reach is a little longer
const TOUR_GAIN = 1.8; // camera speed per px of distance to its goal (1/s)
const TOUR_GOAL_TAU = 0.5; // s: the goal glides after the work (tasks starting/finishing never jerk the camera)
const TOUR_ACCEL = 1100; // px/s²: gentlest speed-up…
const TOUR_DECEL = 1600; // px/s²: …and slow-down (a camera, not a spring)
// The timeline safety net never puts the camera more than this many screens past the oldest
// unfinished layer. Phones get a tight leash: a long page and a small swarm would otherwise
// leave the camera on empty layout while the work happens far above it.
const TOUR_LEAD = 0.5;
const TOUR_LEAD_MOBILE = 0.25;
const HERO_DWELL = 0.75; // build seconds the first screen dwells (from "only clone retypes left") before the tour moves
const HOLD_LOOKAHEAD = 1.2; // screens below the top agents may pre-build while the camera dwells (kept short: when
// the tour starts, the camera should arrive at work in progress, not at sections finished while it waited)
const HERO_HOLD_MAX = 7; // …but never hold the camera longer than this after the burst
const SMEAR_ON = 700; // tour speed (px/s) where the fast-scroll smear kicks in…
const SMEAR_OFF = 520; // …and where it lets go (hysteresis, so it never flickers)
const QA_RATE = 0.12; // share of other built layers that get a random QA pass
const WATCHDOG = 7; // build seconds without progress before force-finishing

const KINDS = new Set(["text", "heading", "box", "media", "button", "rule", "chip", "icon"]);
const SCAFFOLD_KINDS = new Set(["box", "media", "heading", "text", "button"]); // outlined by a section's scaffold
const KIND_BIAS = { box: -260, media: -240, rule: -60, button: -40, heading: -30, icon: -20, text: 0, chip: 20, retype: -170 };
const SOURCE_BIAS = -150; // a clone group's source unblocks its whole group: take it early
const FIXED_BIAS = 480; // the nav is built right after the first screen's boxes, not before them
const IDLE_RESERVE = 3; // idle agents kept in view when the spare ones pre-build off-screen
const FX_MS = { fade: 420, pop: 340, glitch: 380, wipe: 320, paste: 460 };
const TEXTUAL = new Set(["text", "heading", "button"]);

const NOOP_SFX = { play() {}, bed: { start() {}, setProgress() {}, stop() {} }, enabled: false, unlocked: false, toggle() {}, onChange() {} };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const smooth = (t) => t * t * (3 - 2 * t);

const isEditable = (el) =>
  el instanceof Element && !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

export const BRAND_SVG =
  '<svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true"><path d="M11 8.5v14.2l3.6-3.4 2.5 5.6 2.6-1.2-2.5-5.5 4.9-.3z" fill="currentColor"/></svg>';

/** Fallback scroller when main.js supplies none: plain window scrolling. */
function windowScroller() {
  return {
    scrollTo(y) {
      window.scrollTo(0, y);
    },
    get y() {
      return window.scrollY;
    },
    onUserScroll(cb) {
      const fire = () => cb();
      const opts = { passive: true };
      window.addEventListener("wheel", fire, opts);
      window.addEventListener("touchmove", fire, opts);
      return () => {
        window.removeEventListener("wheel", fire, opts);
        window.removeEventListener("touchmove", fire, opts);
      };
    },
  };
}

export function createDirector({ root = document, scroller, sfx, speed, onState } = {}) {
  const scope = root && typeof root.querySelectorAll === "function" ? root : document;
  const html = document.documentElement;
  scroller = scroller || windowScroller();
  sfx = sfx || NOOP_SFX;

  /* ───────────────────────────── state ───────────────────────────── */

  let phase = "idle";
  let destroyed = false;
  let skipped = false;
  let speedMul = SPEEDS.includes(Number(speed)) ? Number(speed) : 1;
  let tour = true;

  let T = 0; // build clock (seconds × speed)
  let lastFrame = 0;
  let raf = 0;
  let startedAt = 0; // performance.now() at start (for "in 19.2s")
  let buildStart = 0;
  let deadline = 0;
  let tokens = 0;
  let K = 1; // task duration multiplier (adapted at run time)
  let lastProgressT = 0;
  let lastBuilt = 0;
  let peakAgents = 0;
  let finishing = -1;

  let layers = [];
  let tasks = [];
  let sections = [];
  let groups = new Map();
  const layerOf = new WeakMap();
  const hadClass = new WeakMap();
  let built = 0;

  let vw = 0;
  let vh = 0;
  let dpr = 1;
  let docH = 0;
  let navBottom = 0;
  let isMobile = false;
  let cfg = null;

  let tourVel = 0;
  let tourTarget = 0;
  let tourGoal = -1; // smoothed tourTarget (-1: not started)
  let tourY = -1; // the camera's own (sub-pixel) position; scrollY is whole pixels
  let heroReleaseT = -1; // build time when the opening dwell ends and the tour may move (-1: first screen not finished yet)
  let heroPastedT = -1; // build time when every first-screen layer was at least pasted (clone-edits only retyping)
  let behind = false; // the work lags the planned timeline by more than the tour may lead it
  let holding = false; // the camera is held on the first screen (opening dwell)
  let smearOn = false;
  let bootDur = BOOT_DUR;
  let lastSectionDoneT = -Infinity;
  let currentSection = null;
  let aidsShown = false;
  let spawnClock = 0;
  let starvedFor = 0;
  let hudClock = 0;
  let bedClock = 0;
  let qaSpawnClock = 0;

  const jobs = new Set();
  const fxTimers = []; // { el, cls, at }
  let mini = null; // mini-build state for late GitHub cards
  let resolveRun = null;
  let runPromise = Promise.resolve();

  let canvas = null;
  let ctx = null;
  let logo = null;
  let gate = null; // the start screen while it waits for the click: { el, begin }
  let hud = null;
  const swarm = createSwarm({ scale: 1 });
  const overlay = createOverlay();
  const unsubs = [];

  /* ───────────────────────────── utilities ───────────────────────────── */

  function play(name, xPx, extra) {
    try {
      const x = xPx == null || !vw ? 0.5 : clamp(xPx / vw, 0, 1);
      sfx.play(name, { x, ...extra });
    } catch {
      /* a broken sound engine never breaks the build */
    }
  }
  const playAt = (name, agent, extra) => play(name, agent ? agent.x : null, extra);

  function emit(state) {
    try {
      onState?.(state);
    } catch (err) {
      console.warn("[build] onState handler failed:", err);
    }
  }

  function addFx(el, cls, ms) {
    el.classList.add(cls);
    fxTimers.push({ el, cls, at: performance.now() + ms });
  }

  /** <html> got its class attribute from the gate script; drop it again once empty. */
  function tidyHtmlClass() {
    if (html.classList.length === 0) html.removeAttribute("class");
  }

  /** Drops an empty class attribute we created, so the markup matches the original. */
  function cleanClass(el) {
    if (el.classList.length === 0 && hadClass.get(el) === false) el.removeAttribute("class");
  }

  function flushFx(all = false) {
    const now = performance.now();
    for (let i = fxTimers.length - 1; i >= 0; i--) {
      const f = fxTimers[i];
      if (all || now >= f.at) {
        f.el.classList.remove(f.cls);
        cleanClass(f.el);
        fxTimers.splice(i, 1);
      }
    }
  }

  /* ───────────────────────────── planning ───────────────────────────── */

  function makeLayer(el) {
    const kind = KINDS.has(el.dataset.layer) ? el.dataset.layer : "text";
    if (!hadClass.has(el)) hadClass.set(el, el.hasAttribute("class"));
    const L = {
      el,
      kind,
      groupName: el.dataset.clone || null,
      group: null,
      qa: el.hasAttribute("data-qa"),
      instant: el.dataset.type === "instant",
      parent: null,
      section: null,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      lines: [],
      fixed: false,
      inline: false,
      font: "",
      text: "",
      chars: 0,
      state: "pending", // pending | active | pasted | built
      dropped: false, // removed from the page mid-build (e.g. the repo-loading line): no longer counted
      wired: false,
      task: null,
      cloneHandle: null,
      cloneWire: null,
    };
    layerOf.set(el, L);
    return L;
  }

  function linkLayer(L) {
    const p = L.el.parentElement?.closest("[data-layer]");
    L.parent = p ? layerOf.get(p) || null : null;
    const s = L.el.closest("[data-section]");
    L.section = s ? sections.find((S) => S.el === s) || null : null;
    if (L.section) L.section.total++;
    if (L.groupName) {
      const key = L.groupName;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { name: key, source: L, targets: [], pasting: false }));
      else g.targets.push(L);
      L.group = g;
    }
  }

  function planSections() {
    sections = [...document.querySelectorAll("[data-section]")].map((el, i) => ({
      el,
      name: el.dataset.section,
      index: i,
      cols: Math.max(0, parseInt(el.dataset.cols, 10) || 0),
      rect: { x: 0, y: 0, w: 0, h: 0 },
      fixed: false,
      cx: 0,
      cw: 0,
      total: 0,
      done: 0,
      started: false,
      finished: false,
      scaffold: null, // overlay scaffold item while the section builds
    }));
  }

  function plan() {
    planSections();
    layers = [...scope.querySelectorAll("[data-layer]")].map(makeLayer);
    groups = new Map();
    layers.forEach(linkLayer);
    measure();
    tasks = [];
    for (const L of layers) {
      if (!rendered(L)) {
        markUnrendered(L); // e.g. a hidden chip or a card inside a closed dropdown: nothing to build
        continue;
      }
      makeTask(L);
    }
    recount();
  }

  const rendered = (L) => L.el.isConnected && (L.rect.w >= 1 || L.rect.h >= 1);
  function markUnrendered(L) {
    L.state = "built";
    L.wired = true;
    L.el.classList.add("is-built");
  }

  /**
   * Re-derives the built counters (HUD, per-section progress) from the live layer list.
   * Called whenever `layers` is rebuilt, so a layer that left the page (the "Fetching
   * repositories…" line replaced by cards) leaves the total AND the built count.
   */
  function recount() {
    built = 0;
    for (const S of sections) {
      S.total = 0;
      S.done = 0;
    }
    for (const L of layers) {
      const S = L.section;
      if (S) S.total++;
      if (L.state === "built") {
        built++;
        if (S) S.done++;
      }
    }
    for (const S of sections) {
      const finished = S.total > 0 && S.done >= S.total;
      if (finished && !S.finished) S.scaffold?.release(T, 0.6);
      S.finished = finished;
    }
  }

  /** Re-collects the layers in document order; ones no longer in the DOM are dropped, never "built". */
  function recollect() {
    const before = layers;
    layers = [...scope.querySelectorAll("[data-layer]")].map((el) => layerOf.get(el)).filter(Boolean);
    const live = new Set(layers);
    for (const L of before) if (!live.has(L)) L.dropped = true;
    // an active job on a dropped layer ends on its own (its task is marked done in taskJob's finally)
    tasks = tasks.filter((t) => !t.layer.dropped || t.status === "active");
  }

  function makeTask(L) {
    const chars = L.chars;
    const typeDur = clamp(0.12 + chars / 105, 0.2, 1.45);
    const est = {
      box: 0.8,
      media: 1.55,
      button: 0.75 + clamp(chars / 30, 0.2, 0.5),
      heading: 0.2 + clamp(chars / 40, 0.35, 0.95) + 0.35,
      text: L.instant ? 0.35 : 0.12 + typeDur,
      rule: 0.6,
      chip: 0.24,
      icon: 0.3,
    }[L.kind];
    const task = { layer: L, type: "build", status: "pending", base: est, travel: 0.3 };
    if (L.group && L.group.source === L) task.base += 0.12 * L.group.targets.length;
    L.task = task;
    tasks.push(task);
    return task;
  }

  const taskEst = (task) => task.base * K + task.travel;

  /* ───────────────────────────── measuring ───────────────────────────── */

  function fixedCheck(el, cache) {
    const chain = [];
    let result = false;
    for (let n = el; n && n !== document.body && n !== html; n = n.parentElement) {
      if (cache.has(n)) {
        result = cache.get(n);
        break;
      }
      chain.push(n);
      const pos = getComputedStyle(n).position;
      if (pos === "fixed") {
        result = true;
        break;
      }
    }
    for (const n of chain) cache.set(n, result);
    return result;
  }

  /** Text line boxes of a layer (from its text nodes only), merged per line. */
  function lineRects(L, sy) {
    const range = document.createRange();
    const lines = [];
    const walker = document.createTreeWalker(L.el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!/\S/.test(n.data)) continue;
      const host = n.parentElement;
      if (host && host !== L.el && host.closest("[data-layer]") !== L.el) continue; // nested layer
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        const y = L.fixed ? r.top : r.top + sy;
        const cy = y + r.height / 2;
        const line = lines.find((l) => Math.abs(l.y + l.h / 2 - cy) < Math.max(l.h, r.height) * 0.5);
        if (line) {
          const x0 = Math.min(line.x, r.left);
          const x1 = Math.max(line.x + line.w, r.right);
          const y0 = Math.min(line.y, y);
          const y1 = Math.max(line.y + line.h, y + r.height);
          Object.assign(line, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
        } else lines.push({ x: r.left, y, w: r.width, h: r.height });
      }
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x);
    return lines;
  }

  /** Viewport size + canvas only (the start screen has nothing else to measure yet). */
  function measureViewport() {
    vw = html.clientWidth || window.innerWidth;
    vh = window.innerHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    resizeCanvas();
  }

  function measure() {
    const sy = window.scrollY;
    vw = html.clientWidth || window.innerWidth;
    vh = window.innerHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    docH = Math.max(html.scrollHeight, document.body.scrollHeight);
    const cache = new Map();

    for (const S of sections) {
      if (!S.el.isConnected) continue;
      const r = S.el.getBoundingClientRect();
      S.fixed = fixedCheck(S.el, cache);
      S.rect = { x: r.left, y: S.fixed ? r.top : r.top + sy, w: r.width, h: r.height };
      const c = S.el.querySelector(".container");
      if (c) {
        const cr = c.getBoundingClientRect();
        const cs = getComputedStyle(c);
        const pl = parseFloat(cs.paddingLeft) || 0;
        const pr = parseFloat(cs.paddingRight) || 0;
        S.cx = cr.left + pl;
        S.cw = Math.max(0, cr.width - pl - pr);
      } else {
        S.cx = r.left;
        S.cw = r.width;
      }
    }
    const nav = sections.find((S) => S.fixed);
    navBottom = nav ? Math.max(0, nav.rect.y + nav.rect.h) : 0;

    // Clone targets showing pasted text are frozen to the box of the layout they were pasted
    // in. Measure them as themselves, then paste again into the new box (resize mid-build).
    const pasted = layers.filter((L) => L.state === "pasted" && L.cloneHandle && L.group);
    for (const L of pasted) L.cloneHandle.restore();

    for (const L of layers) {
      if (!L.el.isConnected) continue;
      const r = L.el.getBoundingClientRect();
      L.fixed = fixedCheck(L.el, cache);
      L.rect = { x: r.left, y: L.fixed ? r.top : r.top + sy, w: r.width, h: r.height };
      if (TEXTUAL.has(L.kind) || L.kind === "chip") {
        const cs = getComputedStyle(L.el);
        L.inline = cs.display === "inline";
        L.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        L.lines = lineRects(L, sy);
        L.text = L.el.textContent || "";
        if (L.state === "pending") L.chars = countChars(L.el);
      }
    }
    for (const L of pasted) L.cloneHandle = cloneText(L.group.source.el, L.el, { w: L.rect.w, h: L.rect.h, inline: L.inline });
    if (phase === "build" && tasks.length) buildWorkPlan();
    resizeCanvas();
    // the margin / column guides follow the container to its new x
    // (only while building: after the build the guides are gone for good, whatever re-measures)
    if (phase === "build" && aidsShown && currentSection) overlay.setAids({ key: currentSection.name, x: currentSection.cx, w: currentSection.cw, cols: currentSection.cols });
  }

  function resizeCanvas() {
    if (!canvas) return;
    const cw = Math.max(1, Math.round(vw * dpr));
    const ch = Math.max(1, Math.round(vh * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw; // reallocates the backing store: only when the size really changed
      canvas.height = ch;
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${vh}px`;
    }
    overlay.resize(vw, vh, dpr);
    swarm.resize(vw, vh, dpr);
    overlay.setRuler(null, navBottom);
  }

  /* ───────────────────────────── jobs ───────────────────────────── */

  /**
   * Runs a generator as a cooperative job. Yield a number to wait that many build
   * seconds, a function to wait until it returns true, or nothing for one frame.
   */
  function run(gen, info = {}) {
    const job = { gen, until: -1, cond: null, ...info };
    jobs.add(job);
    stepJob(job);
    return job;
  }

  function stepJob(job) {
    for (let guard = 0; guard < 64; guard++) {
      if (job.cond && !job.cond()) return;
      if (job.until > T) return;
      job.cond = null;
      job.until = -1;
      const r = job.gen.next();
      if (r.done) {
        jobs.delete(job);
        return;
      }
      if (typeof r.value === "number") job.until = T + r.value;
      else if (typeof r.value === "function") job.cond = r.value;
      else return;
    }
  }

  function cancelJobs() {
    for (const job of [...jobs]) {
      try {
        job.gen.return();
      } catch (err) {
        console.warn("[build] job cleanup failed:", err);
      }
    }
    jobs.clear();
  }

  /* ───────────────────────── choreography helpers ───────────────────────── */

  /** Flies an agent to a point (document coords, or viewport coords when fixed). */
  function* fly(agent, x, y, fixed = false, timeout = 1.4) {
    agent.mode = "seek";
    agent.goal = { x, y, fixed };
    agent.arrived = false;
    const t0 = T;
    yield () => agent.arrived || T - t0 > timeout;
    agent.mode = "hold";
  }

  /** Viewport-or-document point on a layer's text at typing progress p (cheap: cached line boxes). */
  function caretPoint(L, p) {
    const lines = L.lines.length ? L.lines : [L.rect];
    let total = 0;
    for (const l of lines) total += l.w;
    let d = clamp(p, 0, 1) * total;
    for (const l of lines) {
      if (d <= l.w) return { x: l.x + d + 5, y: l.y + l.h * 0.55, fixed: L.fixed };
      d -= l.w;
    }
    const l = lines[lines.length - 1];
    return { x: l.x + l.w + 5, y: l.y + l.h * 0.55, fixed: L.fixed };
  }

  /** Reveals a layer's own box (keeps counting separate: see markBuilt). */
  function show(L, fx) {
    L.el.classList.add("is-built");
    if (fx && FX_MS[fx]) addFx(L.el, `build-fx-${fx}`, FX_MS[fx]);
  }

  function markBuilt(L) {
    if (L.state === "built") return;
    L.state = "built";
    L.wired = true;
    L.el.classList.add("is-built");
    L.el.classList.remove("is-building");
    if (L.dropped) return; // left the page: not part of the count any more
    built++;
    const S = L.section;
    if (S) {
      S.done++;
      if (!S.finished && S.done >= S.total) {
        S.finished = true;
        S.scaffold?.release(T, 0.6);
        // the very last layer gets the finale ('complete') instead of a section arpeggio on top of it
        if (phase === "build" && built < layers.length) {
          play("sectionDone", S.cx + S.cw / 2);
          lastSectionDoneT = T;
        }
      }
    }
    // QA: annotated layers always, a random share of the rest (not tiny or card-sized ones)
    const qaable = L.kind !== "chip" && L.kind !== "icon" && L.kind !== "rule" && L.rect.w * L.rect.h < 160000;
    if (phase === "build" && !skipped && (L.qa || (qaable && Math.random() < QA_RATE))) {
      tasks.push({ layer: L, type: "qa", status: "pending", base: 0.85, travel: 0.3 });
    }
  }

  function rulerFocus(L) {
    overlay.setRulerFocus(L.rect.x, L.rect.x + L.rect.w);
  }

  function* typeOut(agent, L, handle, dur, heavy = false, echo = null) {
    const t0 = T;
    let last = 0;
    let lastSound = 0;
    let gap = 0;
    for (;;) {
      const p = clamp((T - t0) / dur, 0, 1);
      // a little rhythm: bursts and micro-pauses instead of a metronome
      const q = clamp(p + Math.sin(p * 23 + agent.seed) * 0.015, 0, 1);
      const n = Math.round((p >= 1 ? 1 : q) * handle.total);
      handle.set(n);
      if (n > last) {
        last = n;
        const now = performance.now();
        // An irregular gap per keystroke sound: one typist sounds like loose typing, a crowd
        // like a denser texture (sfx.js thins it further), never a frame-locked 20 Hz rattle.
        if (now - lastSound > gap) {
          lastSound = now;
          gap = heavy ? rand(70, 125) : rand(55, 135);
          playAt(heavy ? "typeHeavy" : "type", agent);
        }
      }
      agent.goal = caretPoint(L, n / (handle.total || 1));
      echo?.(p);
      if (p >= 1) return;
      yield;
    }
  }

  /** Ghost stack on a heading: translucent offset copies collapsing into the real text. */
  function echoer(L) {
    const el = L.el;
    return (p) => {
      const e = Math.max(0, 1 - p * 1.15);
      if (e <= 0) {
        el.style.textShadow = "";
        return;
      }
      const d = 7 + 9 * e;
      el.style.textShadow =
        `${(-0.5 * e * d).toFixed(1)}px ${(e * d).toFixed(1)}px 0 rgba(243,244,246,${(0.26 * e).toFixed(3)}),` +
        `${(-1 * e * d).toFixed(1)}px ${(2 * e * d).toFixed(1)}px 0 rgba(243,244,246,${(0.14 * e).toFixed(3)}),` +
        `${(-1.5 * e * d).toFixed(1)}px ${(3 * e * d).toFixed(1)}px 0 rgba(108,155,255,${(0.12 * e).toFixed(3)})`;
    };
  }

  /* ───────────────────────────── task jobs ───────────────────────────── */

  function* boxJob(agent, L) {
    const r = L.rect;
    agent.glyph = "arrow";
    yield* fly(agent, r.x, r.y, L.fixed);
    agent.glyph = "cross";
    const area = r.w * r.h;
    const media = L.kind === "media";
    const copies = media || area > 90000 ? (Math.random() < 0.75 ? randInt(2, 4) : 0) : area > 20000 && Math.random() < 0.3 ? 1 : 0;
    const w = overlay.wire(L, {
      t: T,
      draw: 0.34 * K,
      conv: 0.42 * K,
      copies,
      guides: area > 60000 && Math.random() < 0.65,
      placeholder: media,
      // big media placeholders get measured inside too: nested boxes, each with a pill
      nested: media && area > 60000 ? randInt(2, 4) : 0,
    });
    rulerFocus(L);
    playAt("wireDraw", agent);
    // drag gesture: the crosshair travels from the top-left to the bottom-right corner
    const t0 = T;
    while (T - t0 < w.draw) {
      const k = smooth(clamp((T - t0) / w.draw, 0, 1));
      const rr = L.rect; // live: a re-measure may replace it mid-gesture
      agent.goal = { x: rr.x + rr.w * k, y: rr.y + rr.h * k, fixed: L.fixed };
      yield;
    }
    if (!media) {
      // Outline closed: the box exists. Its agent moves on at once (it is right there to take
      // the box's first child); handles, pill and converging copies settle on their own.
      show(L, "fade");
      markBuilt(L);
      run(settleWire(w, copies, agent.x));
      return;
    }
    // media: the agent stays for the placeholder, then the glitch reveal
    playAt("handle", agent);
    yield 0.1 * K;
    playAt("measure", agent);
    if (copies) yield 0.36 * K;
    playAt("placeholder", agent);
    agent.glyph = "arrow";
    agent.goal = { x: L.rect.x + L.rect.w * 0.5 + 14, y: L.rect.y + L.rect.h * 0.5 + 12, fixed: L.fixed };
    yield 0.5 * K;
    show(L, "glitch");
    w.hidePlaceholder(T);
    playAt("glitch", agent);
    playAt("reveal", agent);
    yield 0.18 * K;
    L.wired = true;
    markBuilt(L);
    yield 0.14 * K;
    w.release(T);
  }

  /** A box wireframe settling after its agent left: tick sounds, then the fade-out. */
  function* settleWire(w, copies, x) {
    play("handle", x);
    yield 0.1 * K;
    play("measure", x);
    yield (copies ? 0.5 : 0.14) * K;
    w.release(T);
  }

  function* buttonJob(agent, L) {
    const r = L.rect;
    yield* fly(agent, r.x, r.y, L.fixed);
    agent.glyph = "cross";
    const w = overlay.wire(L, { t: T, draw: 0.22 * K, copies: 0, crosshair: false });
    rulerFocus(L);
    playAt("wireDraw", agent);
    const t0 = T;
    while (T - t0 < w.draw) {
      const k = smooth(clamp((T - t0) / w.draw, 0, 1));
      const rr = L.rect;
      agent.goal = { x: rr.x + rr.w * k, y: rr.y + rr.h * k, fixed: L.fixed };
      yield;
    }
    let h = null;
    try {
      h = beginType(L.el, { caret: true });
      show(L, "wipe");
      L.wired = true;
      playAt("reveal", agent);
      yield 0.2 * K;
      agent.glyph = "ibeam";
      yield* typeOut(agent, L, h, clamp(h.total / 30, 0.18, 0.5) * K);
      h.restore();
      h = null;
    } finally {
      h?.restore();
    }
    markBuilt(L);
    yield 0.1 * K;
    w.release(T);
  }

  function* textJob(agent, L) {
    const first = L.lines[0] || L.rect;
    const heading = L.kind === "heading";
    const source = L.group && L.group.source === L && L.group.targets.length > 0;
    if (source) L.group.pasting = true; // keep siblings for the paste run
    try {
      yield* fly(agent, first.x, first.y + first.h / 2, L.fixed);
      agent.glyph = "ibeam";
      const w = overlay.wire(L, {
        t: T,
        draw: 0.14 * K,
        handles: heading || L.rect.h > 40,
        pill: heading || (L.rect.w > 140 && Math.random() < 0.5),
        crosshair: false,
      });
      rulerFocus(L);
      yield 0.1 * K;

      const chars = countChars(L.el);
      if (L.instant || chars === 0) {
        show(L, "fade");
        markBuilt(L);
        yield 0.25 * K;
        w.release(T);
        return;
      }

      let h = null;
      let sel = null;
      const restoreStyle = heading ? styleSnapshot(L.el) : null;
      try {
        L.el.classList.add("is-building");
        h = beginType(L.el);
        const dur = heading ? clamp(chars / 40, 0.35, 0.95) * K : clamp(0.12 + chars / 105, 0.2, 1.45) * K;
        yield* typeOut(agent, L, h, dur, heading, heading ? echoer(L) : null);
        h.restore();
        h = null;
        restoreStyle?.();

        // selection + retype of one word: most headings, a few long paragraphs
        const pick = heading ? Math.random() < 0.65 : !L.group && chars > 40 && Math.random() < 0.2;
        const idx = pick ? longestWordIndex(L.el, { fromEnd: heading }) : -1;
        if (idx >= 0) {
          sel = selectWord(L.el, idx);
          if (sel) {
            playAt("select", agent);
            const pt = caretPoint(L, heading ? 0.85 : rand(0.3, 0.8));
            agent.goal = pt;
            yield 0.26 * K;
            const th = sel.beginRetype({ caret: true });
            yield* typeOut(agent, L, th, clamp(th.total / 22, 0.12, 0.4) * K, heading);
            sel.restore();
            sel = null;
          }
        }
      } finally {
        h?.restore();
        sel?.restore();
        restoreStyle?.();
        L.el.classList.remove("is-building");
        cleanClass(L.el);
      }
      markBuilt(L);
      yield 0.12 * K;
      w.release(T);
      if (source) yield* pasteRun(agent, L.group);
    } finally {
      if (source) L.group.pasting = false;
    }
  }

  /** Clone-then-edit: the source's agent pastes its text into every sibling slot. */
  function* pasteRun(agent, group) {
    agent.glyph = "arrow";
    for (const L of group.targets) {
      if (L.state !== "pending" || !L.el.isConnected || !parentReady(L)) continue;
      const first = L.lines[0] || L.rect;
      yield* fly(agent, first.x + 4, first.y + first.h / 2, L.fixed, 0.15);
      L.el.classList.add("is-building");
      L.cloneHandle = cloneText(group.source.el, L.el, { w: L.rect.w, h: L.rect.h, inline: L.inline });
      L.cloneWire = overlay.wire(L, { t: T, draw: 0.1 * K, handles: true, pill: true, crosshair: false });
      addFx(L.el, "build-fx-paste", FX_MS.paste);
      L.state = "pasted";
      L.task.type = "retype";
      L.task.base = 0.3 + clamp(0.1 + L.chars / 120, 0.15, 1.0);
      playAt("paste", agent);
      yield 0.05 * K;
    }
  }

  function* retypeJob(agent, L) {
    const first = L.lines[0] || L.rect;
    yield* fly(agent, first.x, first.y + first.h / 2, L.fixed);
    agent.glyph = "ibeam";
    let unselect = null;
    let h = null;
    try {
      unselect = selectAll(L.el);
      playAt("select", agent);
      yield 0.2 * K;
      unselect();
      unselect = null;
      L.cloneHandle?.restore();
      L.cloneHandle = null;
      h = beginType(L.el);
      yield* typeOut(agent, L, h, clamp(0.08 + h.total / 110, 0.15, 1.0) * K);
      h.restore();
      h = null;
    } finally {
      unselect?.();
      h?.restore();
      L.cloneHandle?.restore();
      L.cloneHandle = null;
      L.el.classList.remove("is-building");
      cleanClass(L.el);
    }
    markBuilt(L);
    yield 0.1 * K;
    L.cloneWire?.release(T);
    L.cloneWire = null;
  }

  function* ruleJob(agent, L) {
    const r = L.rect;
    const y = r.y + r.h / 2;
    yield* fly(agent, r.x, y, L.fixed);
    agent.glyph = "cross";
    const line = overlay.hline({ y, x0: r.x, x1: r.x + r.w, fixed: L.fixed, t: T, dur: 0.42 * K, fade: 0.5 });
    rulerFocus(L);
    playAt("wireDraw", agent);
    const t0 = T;
    while (T - t0 < 0.42 * K) {
      const k = 1 - Math.pow(1 - clamp((T - t0) / (0.42 * K), 0, 1), 3);
      agent.goal = { x: L.rect.x + L.rect.w * k, y: L.rect.y + L.rect.h / 2, fixed: L.fixed };
      yield;
    }
    show(L, "fade");
    markBuilt(L);
    yield 0.18 * K;
    line.release(T);
  }

  function* chipJob(agent, L) {
    const r = L.rect;
    yield* fly(agent, r.x + r.w * 0.3, r.y + r.h * 0.7, L.fixed, 1.1);
    const w = overlay.wire(L, { t: T, draw: 0.08 * K, handles: false, pill: false, crosshair: false, fade: 0.25 });
    show(L, "pop");
    playAt("handle", agent);
    yield 0.14 * K;
    markBuilt(L);
    w.release(T);
  }

  function* iconJob(agent, L) {
    const r = L.rect;
    yield* fly(agent, r.x + r.w, r.y + r.h, L.fixed);
    const w = overlay.wire(L, { t: T, draw: 0.1 * K, pill: true, crosshair: false });
    show(L, "glitch");
    playAt("glitch", agent, { gain: 0.6 });
    yield 0.22 * K;
    markBuilt(L);
    w.release(T);
  }

  function* qaJob(agent, task) {
    const L = task.layer;
    const r = L.rect;
    yield* fly(agent, r.x + r.w + 4, r.y + 4, L.fixed);
    // the red "diff" copy of the text reads well on small type only
    const small = (L.lines[0]?.h || L.rect.h) < 30;
    const q = overlay.qa(L, { t: T, diff: TEXTUAL.has(L.kind) && small && Math.random() < 0.7 });
    playAt("qaFlag", agent);
    agent.goal = { x: r.x + r.w * 0.6, y: r.y + r.h + 6, fixed: L.fixed };
    yield 0.5 * K;
    q.approve(T);
    playAt("qaPass", agent);
    yield 0.28 * K;
    q.release(T);
  }

  /** Wraps a task's job: bookkeeping, the agent's return to idle, and safety. */
  function* taskJob(agent, task) {
    const L = task.layer;
    try {
      if (task.type === "qa") yield* qaJob(agent, task);
      else if (task.type === "retype") yield* retypeJob(agent, L);
      else if (L.kind === "box" || L.kind === "media") yield* boxJob(agent, L);
      else if (L.kind === "button") yield* buttonJob(agent, L);
      else if (L.kind === "rule") yield* ruleJob(agent, L);
      else if (L.kind === "chip") yield* chipJob(agent, L);
      else if (L.kind === "icon") yield* iconJob(agent, L);
      else yield* textJob(agent, L);
    } finally {
      task.status = "done";
      if (task.type !== "qa" && L.state !== "built" && !skipped && phase !== "idle") {
        // job ended early (element removed, …): never leave a layer hidden
        markBuilt(L);
      }
      if (agent.task === task) agent.task = null;
      agent.glyph = "arrow";
      if (agent.mode !== "depart") {
        agent.mode = "wander";
        agent.goal = null;
      }
    }
  }

  /* ───────────────────────────── scheduler ───────────────────────────── */

  const parentReady = (L) => !L.parent || L.parent.wired || L.parent.state === "built";

  function ready(task) {
    if (task.type !== "build") return true;
    const L = task.layer;
    if (!parentReady(L)) return false;
    const g = L.group;
    if (g && g.source !== L && (g.source.state !== "built" || g.pasting)) return false;
    return true;
  }

  /** How far below the viewport top agents may take work (screens). */
  const lookahead = () => (holding ? HOLD_LOOKAHEAD : TOUR_LOOKAHEAD);

  function inWindow(L, sy) {
    if (L.fixed) return true;
    if (!tour) return true;
    // The viewport plus a lookahead below the fold (wireframes get prepared just before they
    // scroll in; while the camera dwells on the first screen the swarm pre-builds further, so
    // the first scroll reveals finished work). At the bottom of the page everything is in reach.
    return L.rect.y < sy + vh * lookahead() || sy >= docH - vh - 4;
  }

  /** Lower = sooner. Visible work first, then work left behind above, then the lookahead. */
  function priority(task, sy) {
    const L = task.layer;
    let bias = KIND_BIAS[task.type === "retype" ? "retype" : L.kind] || 0;
    if (L.group && L.group.source === L && task.type === "build") bias += SOURCE_BIAS;
    if (L.fixed) return L.rect.y + bias + FIXED_BIAS;
    const top = L.rect.y - sy;
    const bottom = top + L.rect.h;
    if (bottom > 0 && top < vh) return top + bias; // intersects the viewport
    if (bottom <= 0) return 5000 - bottom + bias; // above (tour moved on)
    return 10000 + top + bias; // below the fold
  }

  /**
   * Planned frontier: the document y where the build SHOULD be by now if work were done
   * top to bottom at an even pace (work-weighted). The tour never falls behind it, which
   * keeps the timeline on target even when a slow chain holds up the top of the screen.
   */
  let planYs = [];
  let planCum = [];
  function buildWorkPlan() {
    const items = tasks
      .filter((t) => t.type !== "qa" && !t.layer.fixed)
      .map((t) => ({ y: t.layer.rect.y, w: taskEst(t) }))
      .sort((a, b) => a.y - b.y);
    let acc = 0;
    planYs = items.map((i) => i.y);
    planCum = items.map((i) => (acc += i.w));
  }
  function plannedFrontier() {
    if (!planCum.length) return 0;
    // A safety net, not the driver: starts late (after the opening dwell on the first screen)
    // and assumes a slightly longer build than the token schedule.
    const from = Math.max(buildStart + 1.5, heroReleaseT);
    const f = clamp((T - from) / Math.max(4, deadline + 1 - from), 0, 1);
    const goal = f * planCum[planCum.length - 1];
    let i = 0;
    while (i < planCum.length - 1 && planCum[i] < goal) i++;
    return planYs[i];
  }

  function idleAgents(qa) {
    return swarm.agents.filter((a) => !a.task && a.qa === qa && (a.mode === "wander" || a.mode === "free"));
  }

  function assign(agent, task) {
    task.status = "active";
    agent.task = task;
    if (task.type !== "qa") task.layer.state = task.layer.state === "pasted" ? "pasted" : "active";
    if (task.type === "build" && phase === "build") scaffoldSection(task.layer.section);
    run(taskJob(agent, task), { task, agent });
  }

  /**
   * The first task in a section lays out its scaffold: a faint outline of every layer, kept
   * until the section is finished, so mid-build frames read as a fully measured layout.
   */
  function scaffoldSection(S) {
    if (!S || S.scaffold || S.fixed || S.finished) return;
    const list = layers.filter((L) => L.section === S && !L.fixed && SCAFFOLD_KINDS.has(L.kind) && L.state !== "built");
    if (list.length) S.scaffold = overlay.scaffold(list, { t: T });
  }

  function nearest(agentsList, L, sy) {
    const cx = L.rect.x + L.rect.w / 2;
    const cy = (L.fixed ? L.rect.y + sy : L.rect.y) + L.rect.h / 2;
    let best = null;
    let bd = Infinity;
    for (const a of agentsList) {
      const d = (a.x - cx) ** 2 + (a.y - cy) ** 2;
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best;
  }

  function schedule(dt, sy) {
    const buildPhase = phase === "build" && T >= buildStart;
    if (!buildPhase && !mini) return;

    // token bucket: release work at the rate that meets the deadline
    let workLeft = 0;
    for (const t of tasks) if (t.status === "pending" && t.type !== "qa") workLeft += taskEst(t);
    if (buildPhase && deadline - T > 0.5) {
      const rate = workLeft / Math.max(1.6, deadline - T);
      tokens = Math.min(tokens + rate * dt, Math.max(2.5, rate * 1.2));
    } else tokens = Math.max(tokens, 3); // overtime or mini-build: no pacing, just finish

    const candidates = [];
    const ahead = []; // ready, but beyond the window (second tier)
    for (const t of tasks) {
      if (t.status !== "pending" || t.type === "qa") continue;
      if (mini && !buildPhase && !mini.layers.has(t.layer)) continue;
      if (!t.layer.el.isConnected) {
        t.status = "done";
        if (t.layer.state !== "built") markBuilt(t.layer);
        continue;
      }
      if (!ready(t)) continue;
      if (!buildPhase || inWindow(t.layer, sy)) candidates.push(t);
      else if (t.layer.rect.y < sy + vh * (isMobile ? AHEAD_LIMIT_MOBILE : AHEAD_LIMIT)) ahead.push(t); // spares stay near the camera
    }

    let idle = idleAgents(false);
    // More idle agents than work in the window while the schedule allows more (the rest is
    // waiting on chains): the spare agents pre-build further down, nearest first; the tour
    // follows them. A few stay on screen as a reserve, so work that becomes ready in view (a
    // clone-edit retype, a child of a box that just closed) never waits for a long flight.
    const spare = idle.length - candidates.length - IDLE_RESERVE;
    if (spare > 0 && ahead.length && tokens > 0.5) {
      ahead.sort((a, b) => priority(a, sy) - priority(b, sy));
      candidates.push(...ahead.slice(0, spare));
    }
    let starved = false;
    if (candidates.length && tokens > 0) {
      candidates.sort((a, b) => priority(a, sy) - priority(b, sy));
      for (const t of candidates) {
        if (tokens <= 0) break;
        if (!idle.length) {
          starved = true;
          break;
        }
        const a = nearest(idle, t.layer, sy);
        idle = idle.filter((x) => x !== a);
        assign(a, t);
        tokens -= taskEst(t);
      }
    }

    // QA queue → red agents, only for layers in (or near) view
    const qaPending = tasks.filter((t) => t.type === "qa" && t.status === "pending");
    if (qaPending.length) {
      let reds = idleAgents(true);
      for (const t of qaPending) {
        const L = t.layer;
        const top = L.fixed ? L.rect.y : L.rect.y - sy;
        // page layers already (partly) under the fixed nav would be flagged behind it
        const underNav = !L.fixed && top < navBottom + 24;
        if (underNav || top + L.rect.h < -vh * 0.2 || finishing >= 0) {
          t.status = "done"; // scrolled past: not worth a trip
          continue;
        }
        if (top > vh * 0.92) continue;
        if (!reds.length) break;
        const a = nearest(reds, L, sy);
        reds = reds.filter((x) => x !== a);
        assign(a, t);
      }
    }

    if (buildPhase) manageSwarm(dt, sy, starved, qaPending.length);
  }

  /** Grows the swarm with progress and when work outpaces the agents; adapts task speed. */
  function manageSwarm(dt, sy, starved, qaPending) {
    starvedFor = starved ? starvedFor + dt : 0;
    spawnClock -= dt;
    qaSpawnClock -= dt;
    const workers = swarm.agents.filter((a) => !a.qa && a.mode !== "depart").length;
    const maxWorkers = cfg.max - cfg.qa; // red QA agents count toward the total
    // "more work discovered": the swarm grows over the timeline, faster when agents run short
    const f = clamp((T - buildStart) / BUILD_TARGET, 0, 1);
    const want = Math.round(cfg.start + (maxWorkers - cfg.start) * Math.pow(f, 1.6));
    if (spawnClock <= 0 && workers < maxWorkers && (workers < want || starvedFor > 0.25 || behind)) {
      spawnClock = starvedFor > 0.25 ? 0.12 : 0.25;
      const n = starvedFor > 0.25 ? 2 : 1;
      for (let i = 0; i < n && workers + i < maxWorkers; i++) {
        const a = swarm.spawnAtEdge(sy);
        playAt("spawn", a, { pitch: [0, 2, 4, 7, 9, 12][swarm.spawned % 6] });
      }
    }
    // Out of agents (or behind the timeline while the camera waits for the work): work faster.
    if (starvedFor > 0.25 && workers >= maxWorkers) K = Math.max(0.5, K * (1 - dt * 0.12));
    if (behind) K = Math.max(0.55, K * (1 - dt * 0.08));

    const reds = swarm.agents.filter((a) => a.qa && a.mode !== "depart").length;
    if (qaPending && qaSpawnClock <= 0 && reds < cfg.qa) {
      qaSpawnClock = 0.8;
      const a = swarm.spawnAtEdge(sy, { qa: true, edge: Math.random() < 0.5 ? "right" : "top" });
      playAt("spawn", a, { pitch: -5 });
    }
    peakAgents = Math.max(peakAgents, swarm.count);
  }

  /* ───────────────────────────── tour ───────────────────────────── */

  /**
   * The opening beat: the camera stays on the first screen until every layer of the opening
   * section that is visible there (hero copy, 3D object, stats clone-edit) is built, then
   * dwells HERO_DWELL so the finished hero is actually seen before anything scrolls.
   */
  function heroHold() {
    if (heroReleaseT >= 0) return T < heroReleaseT;
    if (T - buildStart > HERO_HOLD_MAX) {
      heroReleaseT = T; // safety: never wait forever on a stuck layer
      return false;
    }
    const first = sections.find((S) => !S.fixed);
    let unbuilt = false;
    let unpasted = false;
    for (const L of layers) {
      if (L.section !== first || L.fixed || L.dropped || L.state === "built" || L.rect.y >= vh) continue;
      unbuilt = true;
      if (L.state !== "pasted") unpasted = true;
    }
    // The dwell starts once only clone-edit retypes are left (they play out in view, e.g. the
    // stats row 160k+ → 13.7M+ / 06 / 2026), and ends no sooner than just after the last one.
    if (!unpasted && heroPastedT < 0) heroPastedT = T;
    if (!unbuilt) heroReleaseT = Math.max(T + 0.35, heroPastedT + HERO_DWELL);
    return true;
  }

  function setSmear(on) {
    if (on === smearOn) return;
    smearOn = on;
    html.classList.toggle("build-smear", on);
  }

  /** Advances the tour scroll; returns the scroll position to render with. */
  function updateTour(dt, sy) {
    behind = false;
    holding = tour && phase === "build" && T >= buildStart && heroHold();
    if (!tour || phase !== "build" || T < buildStart || holding) {
      tourVel = 0;
      tourGoal = -1;
      tourY = -1;
      setSmear(false);
      return sy;
    }
    // The camera keeps its own sub-pixel position (slow stretches would otherwise stall on
    // whole pixels and then lurch); it re-syncs only if something else moved the page.
    if (tourY < 0 || Math.abs(tourY - sy) > 2) tourY = sy;
    if (tourGoal < tourY) tourGoal = tourY;
    // Follow the swarm: the camera tracks the median of the work in progress, so the
    // viewport is always full of activity. Agents take visible work first and then the
    // lookahead below the fold, which pulls the median (and the camera) down the page.
    // The tour only moves forward. The oldest unfinished layer always stays on screen (no
    // section is abandoned half built). The planned frontier is a safety net for the
    // timeline, but even it may only lead the oldest unfinished layer by TOUR_LEAD screens:
    // on a long phone page with a small swarm the camera waits for the work instead of
    // showing empty layout (the scheduler speeds the work up instead, see manageSwarm).
    const active = [];
    let firstReady = Infinity;
    let oldest = Infinity;
    for (const t of tasks) {
      if (t.type === "qa" || t.layer.fixed || t.status === "done") continue;
      const L = t.layer;
      if (L.rect.y < oldest) oldest = L.rect.y;
      if (t.status === "active") active.push(L.rect.y + Math.min(L.rect.h, vh * 0.5) / 2);
      else if (ready(t) && L.rect.y < firstReady) firstReady = L.rect.y;
    }
    if (oldest === Infinity) {
      tourVel = Math.max(0, tourVel - TOUR_DECEL * dt);
    } else {
      let target = tourTarget;
      if (active.length >= 3) {
        active.sort((a, b) => a - b);
        target = active[Math.floor(active.length * 0.5)] - vh * TOUR_CENTER;
      } else if (firstReady < Infinity) target = firstReady - vh * TOUR_ANCHOR;
      target = Math.min(target, oldest - vh * 0.1);
      const net = plannedFrontier() - vh * 0.85;
      const lead = vh * (isMobile ? TOUR_LEAD_MOBILE : TOUR_LEAD);
      behind = net > oldest + lead; // the build is falling behind its timeline
      target = Math.max(target, Math.min(net, oldest + lead));
      target = clamp(Math.max(target, tourTarget), 0, Math.max(0, docH - vh));
      tourTarget = target;
      // Smooth camera: the goal glides after the (jumpy) target, speed follows the distance to
      // the goal, and acceleration and braking are capped. Never negative: the tour never
      // scrolls back up.
      tourGoal += (tourTarget - tourGoal) * (1 - Math.exp(-dt / TOUR_GOAL_TAU));
      const maxV = isMobile ? TOUR_MAX_SPEED_MOBILE : TOUR_MAX_SPEED;
      const want = clamp((tourGoal - tourY) * TOUR_GAIN, 0, maxV);
      const dv = want - tourVel;
      tourVel = Math.max(0, tourVel + (dv > 0 ? Math.min(dv, TOUR_ACCEL * dt) : Math.max(dv, -TOUR_DECEL * dt)));
    }
    setSmear(smearOn ? tourVel > SMEAR_OFF : tourVel > SMEAR_ON);
    if (tourVel > 0.5) {
      const next = clamp(tourY + tourVel * dt, tourY, Math.max(0, docH - vh));
      if (next !== tourY) {
        tourY = next;
        scroller.scrollTo(next, { duration: 0 });
        return next;
      }
    }
    return sy;
  }

  function updateSections(sy) {
    if (phase !== "build" || T < buildStart) return;
    // current section = where the earliest unfinished non-fixed work is
    let best = null;
    let by = Infinity;
    for (const t of tasks) {
      if (t.type === "qa" || t.status === "done" || t.layer.fixed || !t.layer.section) continue;
      if (t.layer.rect.y < by) {
        by = t.layer.rect.y;
        best = t.layer.section;
      }
    }
    // The opening beats (scatter, first wireframes) stay uncluttered: aids come in a bit later.
    const aidsDue = T - buildStart > 2.2;
    if (!best || (best === currentSection && aidsShown === aidsDue)) return;
    currentSection = best;
    if (!best.started) {
      best.started = true;
      if (best.rect.y > 8) overlay.hline({ y: best.rect.y, x0: 0, x1: vw, t: T, dur: 0.6, hold: 0.7, caps: false });
    }
    if (!aidsDue) return;
    aidsShown = true;
    overlay.setAids({ key: best.name, x: best.cx, w: best.cw, cols: best.cols });
    overlay.setRuler(true, navBottom);
    // panned to the container's centre; ducked when it lands right on a section arpeggio
    play("ruler", best.cx + best.cw / 2, T - lastSectionDoneT < 0.35 ? { gain: 0.45 } : undefined);
  }

  /* ───────────────────────────── phases ───────────────────────────── */

  function* bootScript() {
    const cx = vw / 2;
    const cy = vh / 2;
    const sy = scroller.y;
    // two clusters: left/right of the tile, or above/below it on portrait screens (agents.js)
    const portrait = vh > vw * 1.15;
    // the start screen's waiting ring (if any) is already here: spawn only the rest
    for (let i = swarm.count; i < cfg.start; i++) {
      const side = i % 2 ? 1 : -1;
      const p = portrait
        ? { x: cx + rand(-0.3, 0.3) * vw, y: cy + side * rand(90, 220) }
        : { x: cx + side * rand(120, 300), y: cy + rand(-120, 120) };
      swarm.spawn({ x: p.x, y: sy + p.y, mode: "orbit" });
    }
    swarm.startBoot(cx, cy);
    play("boot");
    yield 0.25;
    play("logoPing");
    yield bootDur - 0.25;

    // Scatter: the first wave of work is handed out AT the burst, so the agents that got a
    // task fly straight to their first wireframes (no dead beat of empty black screen) while
    // the rest burst outward and settle into idle formations.
    phase = "build";
    emit("build");
    hud?.setState("build");
    logo?.classList.add("is-out");
    buildStart = T;
    deadline = T + BUILD_TARGET;
    lastProgressT = T;
    buildWorkPlan();
    tokens = FIRST_WAVE;
    schedule(0, scroller.y);
    swarm.scatter(scroller.y);
    play("scatter");
    yield SCATTER_DUR + 0.5;
    logo?.remove();
    logo = null;
  }

  /** Boot logo tile in the exact centre (main.js may already show it on the pre-boot screen: adopt it). */
  function adoptLogo() {
    if (logo && logo.isConnected) return;
    const pre = document.querySelector(".build-logo[data-preboot]");
    if (pre) {
      pre.removeAttribute("data-preboot");
      logo = pre;
    } else {
      logo = document.createElement("div");
      logo.className = "build-logo";
      logo.setAttribute("aria-hidden", "true");
      logo.innerHTML = BRAND_SVG;
      document.body.appendChild(logo);
    }
  }

  /* ───────────────────────────── start gate ─────────────────────────────
     The full animation (first visit, Rebuild, Replay, R) waits on a start screen: the boot
     logo breathes in the centre and "Click anywhere to start" fades in below it. That click
     is also the gesture browsers require before they allow sound, so the boot plays with its
     sounds from the very first beat. Esc (or turning animations off) skips the build. */

  function openGate(begin) {
    closeGate();
    phase = "gate";
    html.classList.add("build-pending", "build-gating");
    document.querySelector("main")?.setAttribute("aria-busy", "true");
    adoptLogo();
    logo.classList.add("is-gate");
    hud?.hide();
    // a see-through ring of cursors circles the tile, waiting for the press (agents.js)
    measureViewport();
    swarm.startRing(vw / 2, vh / 2, isMobile ? { n: 6, r: 52 } : { n: 8, r: 58 });
    lastFrame = 0;
    ensureLoop();
    const touch = window.matchMedia("(hover: none)").matches;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "build-gate";
    el.setAttribute("aria-label", "Start: watch this page get built, with sound");
    el.innerHTML =
      `<span class="build-gate__text">${touch ? "Tap" : "Click"} anywhere to start</span>` +
      (touch ? "" : '<span class="build-gate__hint">Esc to skip</span>');
    document.body.appendChild(el);
    const g = { el, begin };
    el.addEventListener("click", () => {
      if (gate !== g || destroyed) return;
      try {
        closeGate();
        const tile = logo;
        tile?.classList.add("is-pressed");
        setTimeout(() => tile?.classList.remove("is-pressed"), 480);
        play("click");
        begin();
      } catch (err) {
        fail(err);
      }
    });
    gate = g;
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* optional */
    }
    emit("gate");
  }

  function closeGate() {
    if (!gate) return;
    gate.el.remove();
    gate = null;
    html.classList.remove("build-gating");
    logo?.classList.remove("is-gate");
  }

  /** Skips from the start screen straight to the finished page (Esc, animations off). */
  function dismissGate() {
    closeGate();
    logo?.remove();
    logo = null;
    swarm.clear();
    clearCanvas();
    finalizeDom();
    phase = "done";
    emit("done");
    resolveRun?.();
    resolveRun = null;
  }

  function startRun() {
    phase = "boot";
    skipped = false;
    finishing = -1;
    T = 0;
    swarm.resetClock(); // the start screen ran on the old clock
    K = isMobile ? 0.72 : 0.82; // the work stays near the camera (AHEAD_LIMIT), so it runs a little quicker instead
    peakAgents = 0;
    currentSection = null;
    aidsShown = false;
    tourVel = 0;
    tourTarget = 0;
    tourGoal = -1;
    tourY = -1;
    heroReleaseT = -1;
    heroPastedT = -1;
    behind = false;
    holding = false;
    smearOn = false;
    lastSectionDoneT = -Infinity;
    starvedFor = 0;
    spawnClock = 0.6;
    qaSpawnClock = 1.5;
    startedAt = performance.now();
    lastFrame = 0;
    if (!resolveRun) runPromise = new Promise((r) => (resolveRun = r)); // start() with a gate made it already

    html.classList.add("build-pending");
    document.querySelector("main")?.setAttribute("aria-busy", "true");
    plan();
    peakAgents = cfg.start;

    adoptLogo();

    hud.setState("boot");
    hud.setTour(tour);
    hud.setSpeed(speedMul);
    hud.setCounts({ agents: cfg.start, built, total: layers.length });
    syncSound();
    try {
      // a replay starts dark again: the previous run left the bed's filter fully open (progress 1)
      sfx.bed?.setProgress?.(0);
      sfx.bed?.start();
    } catch {
      /* optional */
    }

    run(bootScript(), { script: true });
    emit("boot");
    ensureLoop();
  }

  /** Every layer built → summary HUD, departure, original markup restored. */
  function complete() {
    if (phase === "done") return;
    phase = "done";
    finishing = -1;
    const seconds = (performance.now() - startedAt) / 1000;
    const builtByAgents = built; // before the fast-forward below (the HUD says how far a skipped build got)
    cancelJobs();
    restoreAll();
    for (const L of layers) if (L.state !== "built") markBuilt(L);
    swarm.departAll();
    overlay.releaseAll(T, 0.5);
    aidsShown = false; // the margin / column guides fade with everything else and never return
    currentSection = null;
    setSmear(false);
    hud.setDone({ agents: Math.max(peakAgents, swarm.count), seconds, skipped, built: builtByAgents, total: layers.length });
    if (!skipped) play("complete");
    play("depart", vw * 0.85);
    try {
      sfx.bed?.setProgress(1);
      sfx.bed?.stop();
    } catch {
      /* optional */
    }
    finalizeDom();
    emit("done");
    resolveRun?.();
    resolveRun = null;
    ensureLoop();
  }

  /**
   * Puts back anything a cancelled job might have left (clone texts, classes). Typer
   * handles restore themselves in `finally`; the helper-element sweep is a last-resort
   * net that folds stray text back in rather than dropping it.
   */
  function restoreAll() {
    for (const L of layers) {
      L.cloneHandle?.restore();
      L.cloneHandle = null;
      L.el.classList.remove("is-building", "build-selall");
    }
    for (const n of document.querySelectorAll(".build-caret")) n.remove();
    for (const n of document.querySelectorAll(".build-rest, .build-sel")) {
      const parent = n.parentNode;
      n.replaceWith(document.createTextNode(n.textContent));
      parent?.normalize();
    }
  }

  /** Removes every build marker so the DOM equals the original markup. */
  function finalizeDom() {
    flushFx(true);
    html.classList.remove("build-pending", "build-smear", "build-mini"); // build-flash ends on its own timer
    tidyHtmlClass();
    document.querySelector("main")?.removeAttribute("aria-busy");
    for (const L of layers) {
      L.el.classList.remove("is-built", "is-building", "build-new", "build-selall");
      cleanClass(L.el);
    }
  }

  /** Stops everything immediately and reveals the page (errors, destroy). */
  function hardStop() {
    cancelJobs();
    restoreAll();
    finalizeDom();
    closeGate();
    logo?.remove();
    logo = null;
    swarm.clear();
    overlay.clear();
    mini = null;
    try {
      sfx.bed?.stop();
    } catch {
      /* optional */
    }
  }

  function fail(err) {
    console.error("[build] engine error; revealing the page:", err);
    try {
      hardStop();
    } catch (e) {
      html.classList.remove("build-pending");
      console.error("[build] cleanup failed too:", e);
    }
    hud?.hide();
    stopLoop();
    if (phase !== "done") {
      phase = "done";
      emit("done");
    }
    resolveRun?.();
    resolveRun = null;
  }

  /* ───────────────────────────── mini-build ───────────────────────────── */

  function onLayersAdded(e) {
    if (destroyed) return;
    try {
      const rootEl = e?.detail?.root instanceof Element ? e.detail.root : document;
      const found = [...rootEl.querySelectorAll("[data-layer]")];
      if (rootEl instanceof Element && rootEl.hasAttribute("data-layer")) found.unshift(rootEl);
      const fresh = found.filter((el) => !layerOf.has(el));
      if (!fresh.length) {
        if (phase !== "idle") measure();
        return;
      }
      if (phase === "boot" || phase === "build") {
        const added = fresh.map(makeLayer);
        recollect(); // document order (for parent/group links); replaced layers are dropped
        added.forEach(linkLayer);
        measure();
        for (const L of added) {
          if (rendered(L)) makeTask(L);
          else markUnrendered(L);
        }
        recount();
        return;
      }
      if (phase === "done" && !skipped && !mini && readAnim()) startMini(fresh);
    } catch (err) {
      console.warn("[build] layers-added handling failed:", err);
    }
  }

  function readAnim() {
    try {
      return localStorage.getItem("ktr0a:anim") !== "off";
    } catch {
      return true;
    }
  }

  function startMini(els) {
    const added = els.map(makeLayer);
    recollect();
    added.forEach(linkLayer);
    recount();
    measure();
    const sy = scroller.y;
    for (const L of added) if (!rendered(L)) markUnrendered(L);
    const visible = added.some((L) => L.state !== "built" && L.rect.y < sy + vh * 1.2 && L.rect.y + L.rect.h > sy - vh * 0.2);
    if (!visible) {
      for (const L of added) L.state = "built"; // off-screen: just appear
      return;
    }
    html.classList.add("build-mini");
    for (const L of added) {
      L.el.classList.add("build-new");
      makeTask(L);
    }
    mini = { layers: new Set(added), agents: [] };
    const n = clamp(Math.round(added.length / 6), 2, 4);
    for (let i = 0; i < n; i++) {
      const a = swarm.spawnAtEdge(sy, { edge: i % 2 ? "right" : "bottom" });
      mini.agents.push(a);
      playAt("spawn", a, { pitch: [0, 4, 7, 12][i] });
    }
    ensureLoop();
  }

  /** Fast-forwards a running mini-build (skip / animations turned off). */
  function finishMini() {
    if (!mini) return;
    cancelJobs(); // after 'done' the only jobs left belong to the mini-build
    restoreAll();
    for (const L of mini.layers) if (L.state !== "built") markBuilt(L);
    updateMini();
  }

  function updateMini() {
    if (!mini) return;
    const left = [...mini.layers].some((L) => L.state !== "built");
    if (left) return;
    for (const a of mini.agents) {
      a.mode = "depart";
      a.goal = { x: vw + 90 + rand(0, 120), y: -90 - rand(0, 160), fixed: true };
      a.delay = rand(0, 0.15);
    }
    for (const L of mini.layers) {
      L.el.classList.remove("is-built", "build-new");
      cleanClass(L.el);
    }
    html.classList.remove("build-mini");
    tidyHtmlClass();
    overlay.releaseAll(T, 0.4);
    mini = null;
  }

  /* ───────────────────────────── frame loop ───────────────────────────── */

  function ensureLoop() {
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function frame(now) {
    raf = 0;
    try {
      const realDt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 1 / 60;
      lastFrame = now;
      const dt = realDt * speedMul;
      T += dt;

      // Read and write the scroll position BEFORE this frame's DOM mutations (typing):
      // either one afterwards would force a synchronous layout. From here on, sy is ours.
      let sy = updateTour(dt, scroller.y);
      for (const job of [...jobs]) stepJob(job);
      schedule(dt, sy);
      updateSections(sy);
      swarm.update(dt, T, sy);
      updateMini();
      flushFx();

      // done? (QA passes may finish, briefly)
      if (phase === "build" && T > buildStart) {
        const pendingBuild = tasks.some((t) => t.type !== "qa" && t.status !== "done");
        if (!pendingBuild) {
          if (finishing < 0) finishing = T;
          const qaBusy = [...jobs].some((j) => j.task?.type === "qa");
          if (!qaBusy || T - finishing > 0.9) complete();
        }
        if (built !== lastBuilt) {
          lastBuilt = built;
          lastProgressT = T;
        } else if (T - lastProgressT > WATCHDOG && phase === "build") {
          console.warn("[build] no progress for a while; finishing the build");
          skipped = true;
          complete();
        }
      }

      // HUD + sound bed, throttled
      hudClock -= realDt;
      if (hudClock <= 0 && hud) {
        hudClock = 0.1;
        if (phase === "build") hud.setCounts({ agents: swarm.count, built: Math.min(built, layers.length), total: layers.length });
        syncSound();
      }
      bedClock -= realDt;
      if (bedClock <= 0 && phase === "build") {
        bedClock = 0.25;
        try {
          sfx.bed?.setProgress(layers.length ? built / layers.length : 0);
        } catch {
          /* optional */
        }
      }

      render(sy);

      const busy = phase === "boot" || phase === "build" || mini || jobs.size || swarm.busy || overlay.busy || fxTimers.length;
      if (busy) ensureLoop();
      else clearCanvas();
    } catch (err) {
      fail(err);
    }
  }

  function render(sy) {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlay.draw(ctx, T, sy);
    swarm.draw(ctx, T, sy);
  }

  function clearCanvas() {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  /* ───────────────────────────── controls ───────────────────────────── */

  function syncSound() {
    if (!hud) return;
    let enabled = false;
    let unlocked = false;
    let blocked;
    try {
      enabled = !!sfx.enabled;
      unlocked = !!sfx.unlocked;
      if ("blocked" in sfx) blocked = !!sfx.blocked; // the hint shows only while audio is refused
    } catch {
      /* stub */
    }
    hud.setSound({ enabled, unlocked, blocked });
  }

  /**
   * HUD sound button and M key. sfx.toggle() owns the rules (incl. the unlock grace rule: the
   * first click that unlocks audio keeps sound on) and plays the matching feedback, so the
   * HUD, the M key and the nav button all behave the same.
   */
  function toggleSound() {
    try {
      sfx.toggle?.({ feedback: true });
    } catch {
      /* stub */
    }
    syncSound();
  }

  /** Playback speed of the current run only (nothing is persisted). */
  function setSpeed(n) {
    n = Number(n);
    if (!SPEEDS.includes(n)) return;
    speedMul = n;
    hud?.setSpeed(n);
  }

  function setTour(on) {
    tour = !!on;
    hud?.setTour(tour);
    if (!tour) {
      tourVel = 0;
      setSmear(false);
    }
  }

  function onHud(action) {
    switch (action) {
      case "tour":
        setTour(!tour);
        play(tour ? "toggleOn" : "toggleOff");
        break;
      case "speed":
        setSpeed(SPEEDS[(SPEEDS.indexOf(speedMul) + 1) % SPEEDS.length]);
        play("speed", null, { pitch: Math.log2(speedMul) * 4 });
        break;
      case "sound":
        toggleSound();
        break;
      case "skip":
        skip();
        break;
      case "golive":
        // "Go live": leave the construction view and start reading the finished page from the top
        play("click");
        hud.hide();
        if (scroller.y > 4) scroller.scrollTo(0, { duration: 1.1 });
        break;
      case "close":
        play("click");
        hud.hide();
        break;
      case "replay":
        play("click");
        replay(); // always the default animation (1x, tour on), whatever the visit settings say
        break;
    }
  }

  function onKey(e) {
    if (e.defaultPrevented || e.repeat || e.altKey || e.ctrlKey || e.metaKey || isEditable(e.target)) return;
    const k = e.key;
    if (k === "Escape") {
      // Esc fast-forwards whatever is building, including a late-cards mini-build
      if (phase === "gate" || phase === "boot" || phase === "build" || (phase === "done" && mini)) skip();
      else if (phase === "done" && hud && !hud.hidden) hud.hide();
    } else if (k === "r" || k === "R") {
      // a bare letter key never overrides the visitor's "animations off" choice
      if ((phase === "done" || phase === "idle") && readAnim()) replay(); // default animation
    } else if (k === "m" || k === "M") {
      toggleSound();
    } else if ((k === "t" || k === "T") && (phase === "boot" || phase === "build")) {
      onHud("tour");
    }
  }

  function onUserScroll() {
    if (tour && (phase === "boot" || phase === "build")) setTour(false);
  }

  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (destroyed || phase === "idle") return;
      if (phase === "gate") {
        measureViewport();
        swarm.moveRing(vw / 2, vh / 2);
        return;
      }
      try {
        measure();
        ensureLoop();
      } catch (err) {
        fail(err);
      }
    }, 120);
  }

  function onVisibility() {
    lastFrame = 0; // no giant dt after the tab comes back
  }

  function setup() {
    isMobile = window.matchMedia("(max-width: 640px)").matches;
    cfg = isMobile ? { start: 10, max: 22, qa: 2 } : { start: 19, max: 44, qa: 3 };
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.id = "build-canvas";
      canvas.setAttribute("aria-hidden", "true");
      document.body.appendChild(canvas);
      ctx = canvas.getContext("2d");
    }
    if (!hud) hud = createHud({ palette: PALETTE, onAction: onHud });
    if (!unsubs.length) {
      window.addEventListener("keydown", onKey);
      window.addEventListener("resize", onResize, { passive: true });
      document.addEventListener("visibilitychange", onVisibility);
      document.addEventListener("build:layers-added", onLayersAdded);
      unsubs.push(() => window.removeEventListener("keydown", onKey));
      unsubs.push(() => window.removeEventListener("resize", onResize));
      unsubs.push(() => document.removeEventListener("visibilitychange", onVisibility));
      unsubs.push(() => document.removeEventListener("build:layers-added", onLayersAdded));
      try {
        const off = scroller.onUserScroll?.(onUserScroll);
        if (typeof off === "function") unsubs.push(off);
      } catch {
        /* optional */
      }
      try {
        const off = sfx.onChange?.(syncSound);
        if (typeof off === "function") unsubs.push(off);
      } catch {
        /* optional */
      }
      document.fonts?.ready?.then(() => {
        if (!destroyed && phase !== "idle") onResize();
      });
      // Late layout shifts (images, web fonts, inserted cards) change the page height:
      // re-measure so cached rects follow. Debounced via onResize.
      if (typeof ResizeObserver === "function") {
        let first = true;
        const ro = new ResizeObserver(() => {
          if (first) return void (first = false); // initial observation
          if (!destroyed && phase !== "idle") onResize();
        });
        ro.observe(document.body);
        unsubs.push(() => ro.disconnect());
      }
    }
  }

  /* ───────────────────────────── public API ───────────────────────────── */

  /**
   * The automatic build on page load. speed: 1|2|4 (default: the createDirector option).
   * tour:false (a return visit's setting) builds wherever the visitor is: no jump to the top.
   * A deep link (#section) always starts without the tour.
   */
  function start({ speed: runSpeed, tour: wantTour = true, gate: withGate = false } = {}) {
    if (destroyed || phase !== "idle") return runPromise;
    clearTimeout(window.__buildFailSafe);
    try {
      setup();
      if (SPEEDS.includes(Number(runSpeed))) speedMul = Number(runSpeed);
      // slow network: the visitor has stared at a black page long enough, so get to the content
      bootDur = performance.now() > LATE_START_MS ? LATE_BOOT_DUR : BOOT_DUR;
      tour = wantTour !== false && (!location.hash || location.hash === "#" || location.hash === "#hero");
      if (tour) scroller.scrollTo(0, { duration: 0 });
      if (withGate) {
        runPromise = new Promise((r) => (resolveRun = r));
        openGate(() => {
          if (tour) scroller.scrollTo(0, { duration: 0 }); // in case the page moved while it waited
          bootDur = BOOT_DUR; // the visitor chose to start: always the full boot
          startRun();
        });
      } else startRun();
    } catch (err) {
      fail(err);
    }
    return runPromise;
  }

  function skip() {
    if (destroyed) return;
    if (phase === "gate") {
      try {
        dismissGate();
      } catch (err) {
        fail(err);
      }
      return;
    }
    if (phase === "done" && mini) {
      try {
        finishMini();
      } catch (err) {
        fail(err);
      }
      return;
    }
    if (phase !== "boot" && phase !== "build") return;
    try {
      skipped = true;
      play("skip");
      overlay.glitch(T, 0.15 * speedMul);
      html.classList.add("build-flash");
      setTimeout(() => {
        html.classList.remove("build-flash");
        tidyHtmlClass();
      }, 160);
      logo?.classList.add("is-out");
      if (phase === "boot") {
        phase = "build";
        emit("build");
      }
      complete();
      // remove THIS run's tile after its fade; a replay within 300 ms has its own
      const tile = logo;
      setTimeout(() => {
        tile?.remove();
        if (logo === tile) logo = null;
      }, 300);
    } catch (err) {
      fail(err);
    }
  }

  /** Restarts the whole build from boot. Defaults to the full animation: 1x, tour on, from the top. */
  function replay({ speed: runSpeed = 1, tour: wantTour = true, gate: withGate = true } = {}) {
    if (destroyed) return;
    try {
      clearTimeout(window.__buildFailSafe);
      setup();
      cancelJobs();
      restoreAll();
      flushFx(true);
      swarm.clear();
      overlay.clear();
      closeGate();
      logo?.remove();
      logo = null;
      mini = null;
      for (const L of layers) {
        L.el.classList.remove("is-built", "is-building", "build-new");
        cleanClass(L.el);
      }
      html.classList.remove("build-mini", "build-smear");
      html.classList.add("build-pending");
      bootDur = BOOT_DUR;
      speedMul = SPEEDS.includes(Number(runSpeed)) ? Number(runSpeed) : 1;
      tour = wantTour !== false;
      if (tour) scroller.scrollTo(0, { duration: 0 });
      if (withGate) {
        openGate(() => {
          if (tour) scroller.scrollTo(0, { duration: 0 });
          hud.show();
          startRun();
        });
      } else {
        hud.show();
        startRun();
      }
    } catch (err) {
      fail(err);
    }
  }

  function destroy() {
    if (destroyed) return;
    try {
      hardStop();
    } catch (err) {
      console.warn("[build] destroy cleanup failed:", err);
      html.classList.remove("build-pending");
    }
    destroyed = true;
    stopLoop();
    clearTimeout(resizeTimer);
    for (const off of unsubs.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    hud?.destroy();
    hud = null;
    canvas?.remove();
    canvas = null;
    ctx = null;
    phase = "idle";
    resolveRun?.();
    resolveRun = null;
  }

  return {
    start,
    skip,
    replay,
    setSpeed,
    setTour,
    destroy,
    get state() {
      return phase;
    },
    get speed() {
      return speedMul;
    },
    get tour() {
      return tour;
    },
    /** Read-only snapshot for debugging / integration tests. */
    inspect() {
      const by = {};
      for (const t of tasks) {
        const k = `${t.type}:${t.status}`;
        by[k] = (by[k] || 0) + 1;
      }
      const sy = scroller.y;
      const readyPending = tasks.filter((t) => t.status === "pending" && t.type !== "qa" && ready(t)).length;
      const inView = tasks.filter((t) => t.status === "pending" && t.type !== "qa" && ready(t) && inWindow(t.layer, sy)).length;
      return {
        phase,
        T: +T.toFixed(2),
        K: +K.toFixed(2),
        tokens: +tokens.toFixed(2),
        built,
        total: layers.length,
        agents: swarm.count,
        idle: idleAgents(false).length,
        jobs: jobs.size,
        tasks: by,
        readyPending,
        inView,
        scrollY: Math.round(sy),
        tour,
        heroRelease: +heroReleaseT.toFixed(2),
        behind,
        frontier: tasks
          .filter((t) => t.status === "pending" && t.type !== "qa" && !t.layer.fixed)
          .sort((a, b) => a.layer.rect.y - b.layer.rect.y)
          .slice(0, 4)
          .map((t) => `${t.type}/${t.layer.kind}@${Math.round(t.layer.rect.y)}${ready(t) ? "" : " blocked:" + (parentReady(t.layer) ? "group " + t.layer.group?.name : "parent " + t.layer.parent?.state)}`),
      };
    },
  };
}

export default createDirector;
