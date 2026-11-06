/* ═══════════════════════════════════════════════════════════════════════════
   main.js: entry module (SPEC §8)

   Boots every piece of the page and wires them together:
     sfx · email · GitHub/YouTube data · nav · in-page anchors · Lenis smooth
     scroll (fine pointers) · toggles (animations / sound / rebuild) · build
     settings (gear popover, ./settings.js) · UI sfx · agent cursor (native CSS
     cursor + trailing "you" tag, ./cursor.js) · hero 3D · the build director.

   Each step runs inside guard(): one failing feature logs a warning and never
   blocks the others. The sound engine and the build engine (and third-party code:
   Lenis, three.js via hero3d.js) are loaded with dynamic import(), so a failed
   fetch anywhere in their module graphs degrades to "no sound" / "no build"
   instead of taking this module (email, data, nav) down with it. Content wiring
   runs first and never waits for them.

   Which build plays (first visit vs return visit):
     first visit    'ktr0a:visited' absent: the automatic build plays at 1x with the tour on.
                    The key is set to "1" once that first automatic build has started.
     return visit   the automatic build uses the visitor's settings (gear popover):
                    'ktr0a:returnSpeed' (1|2|4, default 2), 'ktr0a:returnTour' ('on'|'off',
                    default 'off'; off = the camera stays where the visitor is).
     Rebuild / Replay / R   always the default animation: 1x, tour on, from the top.
     Start screen   the first visit and Rebuild / Replay / R wait on "Click anywhere to start"
                    (the click is also the gesture browsers need before sound may play).
     HUD speed / tour       the current run only; nothing is persisted.
   Settings changes save at once and also apply live while a return-visit run is playing.

   localStorage keys: 'ktr0a:anim' ('on'|'off'), the three above, plus the ones owned by
   sfx.js / data.js. The v1 key 'ktr0a:buildSpeed' is retired and removed on load.
   ═══════════════════════════════════════════════════════════════════════════ */

import { applyEmail, loadGitHubRepos, loadYouTubeStats } from "./data.js";

const root = document.documentElement;
const ANIM_KEY = "ktr0a:anim";
const VISITED_KEY = "ktr0a:visited";
const RETURN_SPEED_KEY = "ktr0a:returnSpeed";
const RETURN_TOUR_KEY = "ktr0a:returnTour";
const LEGACY_SPEED_KEY = "ktr0a:buildSpeed"; // v1 (remembered HUD speed): retired
const SPEEDS = [1, 2, 4];
const DEFAULT_RUN = Object.freeze({ speed: 1, tour: true }); // first visit, Rebuild, Replay, R
const NAV_GAP = 8; // breathing room between the fixed nav and an anchor target
const FINE_POINTER = window.matchMedia("(hover: hover) and (pointer: fine)");
// Longest the build waits, on its black pre-boot screen, for the 3D object and the project
// visuals to finish their expensive first-time GPU setup (so the boot orbit and the tour
// never stutter on it). A slow CDN just means the wait times out and the build starts anyway.
const PREBOOT_WAIT_MS = 700;

/* ─────────────────────────────── utilities ─────────────────────────────── */

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: preference lasts for this page view only */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  },
};

const warn = (label, err) => console.warn(`[main] ${label} failed:`, err);

/** Runs fn, logging (not throwing) sync errors and async rejections. */
function guard(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") result.catch((err) => warn(label, err));
    return result;
  } catch (err) {
    warn(label, err);
    return undefined;
  }
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const isEditable = (el) => el instanceof Element && !!el.closest(EDITABLE);

/* ───────────────────────────── shared state ───────────────────────────── */

const state = {
  animOn: store.get(ANIM_KEY) !== "off",
  firstVisit: store.get(VISITED_KEY) !== "1", // read once at load, before this visit's build marks it
  runKind: null, // the director's current run: 'first' | 'return' (automatic builds) | 'default' (Rebuild/Replay/R)
  autoPending: false, // the automatic build was started but has not booted (or been skipped) yet
  settings: null, // build settings popover (./settings.js)
  director: null, // build engine instance (created only when a build runs)
  hero: null, // { setAnimate, dispose } from hero3d.js
  lenis: null, // Lenis instance while smooth scrolling is active
};

/* ───────────────────────────────── sfx ───────────────────────────────── */

const NOOP_SFX = {
  init() {},
  get unlocked() {
    return false;
  },
  get enabled() {
    return false;
  },
  setEnabled() {},
  toggle() {},
  onChange() {
    return () => {};
  },
  play() {},
  bed: { start() {}, setProgress() {}, stop() {} },
};

let sfx = NOOP_SFX; // replaced by the real engine once ./sfx.js has loaded (loadEngines)

const sfxEnabled = () => {
  try {
    return !!sfx.enabled;
  } catch {
    return false;
  }
};

/** Fire-and-forget sound; a broken sound engine must never break a click handler. */
function play(name, opts) {
  try {
    sfx.play(name, opts);
  } catch {
    /* ignore */
  }
}

const panX = (e) => (e && Number.isFinite(e.clientX) ? Math.min(1, Math.max(0, e.clientX / window.innerWidth)) : 0.5);

/* ─────────────────────────── scroller adapter ───────────────────────────
   Contract with the director (SPEC §5): { scrollTo(y,{duration}), get y(), onUserScroll(cb) }.
   Lenis-backed when smooth scrolling is active, otherwise a small rAF tween on window.
   onUserScroll fires for real user input only (wheel, touch, scroll keys, scrollbar drag,
   in-page anchor clicks), never for programmatic scrolls. */

const userScrollListeners = new Set();
let lastUserScroll = 0;
let tweenFrame = 0;

function emitUserScroll(source) {
  cancelAnimationFrame(tweenFrame); // the user wins over any running programmatic tween
  tweenFrame = 0;
  const now = performance.now();
  if (now - lastUserScroll < 50) return; // wheel/touchmove fire at input rate; 20 Hz is plenty
  lastUserScroll = now;
  for (const cb of userScrollListeners) {
    try {
      cb(source);
    } catch (err) {
      warn("onUserScroll listener", err);
    }
  }
}

const maxScroll = () => Math.max(0, root.scrollHeight - window.innerHeight);
const clampScroll = (y) => Math.min(maxScroll(), Math.max(0, Number(y) || 0));

/** Durations follow Lenis (seconds); anything above 20 is taken as milliseconds. */
function toSeconds(duration) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d < 0) return 0.8;
  return d > 20 ? d / 1000 : d;
}

function jumpTo(y) {
  try {
    window.scrollTo({ top: y, behavior: "instant" }); // beats any CSS scroll-behavior: smooth
  } catch {
    window.scrollTo(0, y);
  }
}

function tweenTo(target, seconds) {
  cancelAnimationFrame(tweenFrame);
  tweenFrame = 0;
  const from = window.scrollY;
  const distance = target - from;
  if (seconds <= 0 || Math.abs(distance) < 1) {
    jumpTo(target);
    return;
  }
  const start = performance.now();
  const ms = seconds * 1000;
  const step = (now) => {
    const p = Math.min(1, (now - start) / ms);
    jumpTo(from + distance * (1 - Math.pow(1 - p, 3))); // easeOutCubic
    tweenFrame = p < 1 ? requestAnimationFrame(step) : 0;
  };
  tweenFrame = requestAnimationFrame(step);
}

const scroller = {
  scrollTo(y, { duration = 0.8 } = {}) {
    const target = clampScroll(y);
    const seconds = toSeconds(duration);
    if (state.lenis) {
      state.lenis.scrollTo(target, { duration: seconds, immediate: seconds <= 0, force: true });
    } else {
      tweenTo(target, seconds);
    }
  },
  get y() {
    return window.scrollY; // what is actually painted (Lenis writes it every frame)
  },
  onUserScroll(cb) {
    if (typeof cb !== "function") return () => {};
    userScrollListeners.add(cb);
    return () => userScrollListeners.delete(cb);
  },
};

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"]);
// The fixed settings popover (and its gear): arrows / Home / End / Tab there operate its controls
// and never scroll the page, so they must not switch the build's tour off.
const inSettings = (el) => el instanceof Element && !!el.closest(".build-settings, #build-settings-btn");

function initUserScrollDetection() {
  const opts = { passive: true, capture: true };
  window.addEventListener("wheel", (e) => !e.ctrlKey && emitUserScroll("wheel"), opts); // ctrl+wheel = zoom
  window.addEventListener("touchmove", () => emitUserScroll("touch"), opts);
  window.addEventListener(
    "keydown",
    (e) => {
      if (!SCROLL_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey || isEditable(e.target) || inSettings(e.target)) return;
      // Space on a focused button/link activates it instead of scrolling.
      if ((e.key === " " || e.key === "Spacebar") && e.target instanceof Element && e.target.closest("button, a, summary")) return;
      emitUserScroll("key");
    },
    opts
  );
  // Tab moves focus and the browser scrolls the focused control into view: that is the visitor
  // navigating, so the build's Tour must stop (it would scroll the focused control away again).
  window.addEventListener(
    "keydown",
    (e) => e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey && !inSettings(e.target) && emitUserScroll("focus"),
    opts
  );
  // Grabbing the scrollbar: a mouse press to the right of the layout viewport.
  window.addEventListener(
    "pointerdown",
    (e) => e.pointerType === "mouse" && e.clientX >= root.clientWidth && emitUserScroll("scrollbar"),
    opts
  );
}

/* ───────────────────────────── Lenis (smooth scroll) ───────────────────────────── */

let lenisModule = null;
let lenisFrame = 0;

function lenisLoop(time) {
  if (!state.lenis) {
    lenisFrame = 0;
    return;
  }
  state.lenis.raf(time);
  lenisFrame = requestAnimationFrame(lenisLoop);
}

/** Desktop / fine pointer only; touch keeps native momentum scrolling. */
async function enableLenis() {
  if (!FINE_POINTER.matches || state.lenis) return;
  lenisModule ??= import("lenis");
  const Lenis = (await lenisModule).default;
  if (!state.animOn || state.lenis) return; // toggled off (or enabled twice) while loading
  state.lenis = new Lenis({
    duration: 1.1,
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothWheel: true,
  });
  if (!lenisFrame) lenisFrame = requestAnimationFrame(lenisLoop);
}

function disableLenis() {
  const lenis = state.lenis;
  state.lenis = null; // the rAF loop stops on its next tick
  if (lenis) guard("lenis destroy", () => lenis.destroy());
}

/* ──────────────────────────── in-page anchors ──────────────────────────── */

function scrollToElement(target) {
  // the nav is one row on desktop, two (links row) on phones: measure it
  const navH = document.getElementById("nav")?.getBoundingClientRect().height || 64;
  const y = target.getBoundingClientRect().top + window.scrollY - navH - NAV_GAP;
  if (state.lenis) {
    state.lenis.scrollTo(clampScroll(y), { force: true });
  } else if (state.animOn) {
    window.scrollTo({ top: clampScroll(y), behavior: "smooth" });
  } else {
    jumpTo(clampScroll(y));
  }
}

function initAnchors() {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target instanceof Element ? e.target.closest('a[href^="#"]') : null;
    if (!link || link.classList.contains("skip-link")) return; // the skip link keeps native focus behaviour
    const hash = link.getAttribute("href");
    if (!hash || hash.length < 2) return;
    let target = null;
    try {
      target = document.getElementById(decodeURIComponent(hash.slice(1)));
    } catch {
      return;
    }
    if (!target) return;

    e.preventDefault();
    emitUserScroll("anchor"); // navigating is user intent: the build's Tour must stop following
    scrollToElement(target);

    // Keyboard activation (detail === 0): move focus so the next Tab continues from the section.
    if (e.detail === 0) {
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }
  });
}

/* ──────────────────────────────── nav ──────────────────────────────── */

function initNav() {
  const nav = document.getElementById("nav");
  const links = [...document.querySelectorAll("[data-nav]")];
  const sections = links.map((l) => document.getElementById(l.dataset.nav)).filter(Boolean);
  const inBand = new Set();
  let active = null;
  let atBottom = false;

  const setActive = (id) => {
    if (id === active) return;
    active = id;
    for (const link of links) {
      const on = link.dataset.nav === id;
      link.classList.toggle("is-active", on);
      if (on) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  };

  // Active = the last section (document order) crossing a thin band ~35% down the viewport.
  // At the very bottom the last section wins, since a short final section never reaches the band.
  const update = () => {
    if (atBottom && sections.length) return setActive(sections[sections.length - 1].id);
    let current = null;
    for (const s of sections) if (inBand.has(s)) current = s.id;
    setActive(current);
  };

  if ("IntersectionObserver" in window && sections.length) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inBand.add(entry.target);
          else inBand.delete(entry.target);
        }
        update();
      },
      { rootMargin: "-35% 0px -60% 0px", threshold: 0 }
    );
    sections.forEach((s) => io.observe(s));
  }

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = window.scrollY;
      nav?.classList.toggle("is-scrolled", y > 8);
      const bottom = y > 8 && y + window.innerHeight >= root.scrollHeight - 2;
      if (bottom !== atBottom) {
        atBottom = bottom;
        update();
      }
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  onScroll();
}

/* ─────────────────────── deferred text updates ───────────────────────
   The typer restores each layer's ORIGINAL innerHTML when it finishes (SPEC §5), so
   text written into a layer mid-build would be reverted or garbled. Data arriving
   while a build runs is queued and applied once the director reports 'done'. */

const pendingText = new Map(); // Element → text

function directorState() {
  try {
    return state.director ? state.director.state : "idle";
  } catch {
    return "idle";
  }
}

// Layer kinds whose text the typer rewrites; text inside other kinds (chips, boxes) is never touched.
const TYPED_LAYER = '[data-layer="text"], [data-layer="heading"], [data-layer="button"]';

function setLayerText(el, text) {
  const s = directorState();
  if (s === "idle" || s === "done" || !el.closest(TYPED_LAYER)) {
    pendingText.delete(el);
    el.textContent = text;
  } else {
    pendingText.set(el, text);
  }
}

function flushPendingText() {
  for (const [el, text] of pendingText) el.textContent = text;
  pendingText.clear();
}

/* ─────────────────────────── build director ─────────────────────────── */

let createDirector = null; // from ./build/director.js (loadEngines)

/** The visitor's return-visit settings (gear popover): speed 1|2|4 (default 2), tour (default off). */
function readReturnSettings() {
  const n = Number(store.get(RETURN_SPEED_KEY));
  return { speed: SPEEDS.includes(n) ? n : 2, tour: store.get(RETURN_TOUR_KEY) === "on" };
}

/** The automatic build on page load: the full animation on a first visit, the visitor's settings after. */
function automaticRun() {
  if (state.firstVisit) return { ...DEFAULT_RUN, kind: "first" };
  const { speed, tour } = readReturnSettings();
  return { speed, tour, kind: "return" };
}

function clearBuildPending() {
  root.classList.remove("build-pending");
  clearTimeout(window.__buildFailSafe);
}

function onDirectorState(s) {
  try {
    // The automatic build boots after its start screen (first visit) or at once (return visit).
    // Any later boot is a replay (HUD Replay, R, Rebuild): the default run.
    if (s === "boot" || s === "done") {
      if (state.autoPending) {
        state.autoPending = false;
        // started or skipped from the start screen: from now on this visitor is a returning one
        if (state.runKind !== "default") store.set(VISITED_KEY, "1");
      } else if (s === "boot") state.runKind = "default";
    }
    if (s === "done") flushPendingText();
    // A replay started from the HUD implies animations are wanted again, for this visit only:
    // the saved preference changes through the nav toggle / Rebuild button alone.
    if ((s === "boot" || s === "build") && !state.animOn) setAnimations(true, { persist: false });
  } catch (err) {
    warn("onState handler", err);
  }
}

/**
 * Creates a director and starts it. Any failure reveals the page instead of leaving it hidden.
 * kind 'first' | 'return': the automatic build on load (marks the visit); 'default': Rebuild.
 */
function startDirector({ speed = DEFAULT_RUN.speed, tour = DEFAULT_RUN.tour, kind = "default", gate = kind !== "return" } = {}) {
  try {
    if (typeof createDirector !== "function") throw new Error("build engine unavailable");
    state.director = createDirector({ root: document, scroller, sfx, speed, onState: onDirectorState });
    state.runKind = kind;
    state.autoPending = true;
    // gate: the start screen ("Click anywhere to start") before the full animation
    const run = state.director.start({ speed, tour, gate });
    if (run && typeof run.catch === "function") {
      run.catch((err) => {
        warn("build", err);
        clearBuildPending();
      });
    }
  } catch (err) {
    warn("build director", err);
    guard("director destroy", () => state.director?.destroy?.());
    state.director = null;
    clearBuildPending();
    flushPendingText();
  }
}

function initialBuild() {
  if (state.animOn && root.classList.contains("build-pending")) startDirector(automaticRun());
  else clearBuildPending();
  // Not adopted by a director (animations switched off during the wait, or start failed).
  document.querySelector(".build-logo[data-preboot]")?.remove();
}

/**
 * Nav "Rebuild" button (and R while no director exists): the default animation (1x, tour on,
 * from the top) whatever the return-visit settings say, turning animations on first.
 * The director (re)applies html.build-pending itself in start()/replay() and reveals the page on failure.
 */
function rebuild() {
  if (!state.animOn) setAnimations(true);
  if (!state.director) startDirector({ ...DEFAULT_RUN, kind: "default" });
  else guard("replay", () => state.director.replay({ ...DEFAULT_RUN, gate: true }));
}

/* ─────────────────────────── build settings ───────────────────────────
   Gear popover (./settings.js). Changes are saved at once; while the current run is itself a
   return-visit build they also apply live (only the setting that changed). With animations off
   it still works: the settings simply apply to the next automatic build. */

function onSettingsChange({ speed, tour, changed }) {
  store.set(RETURN_SPEED_KEY, String(speed));
  store.set(RETURN_TOUR_KEY, tour ? "on" : "off");
  const s = directorState();
  if (state.runKind !== "return" || (s !== "boot" && s !== "build")) return;
  if (changed === "speed") guard("live speed", () => state.director.setSpeed(speed));
  else if (changed === "tour") guard("live tour", () => state.director.setTour(tour));
}

function initSettings(mod) {
  const mount = mod?.mountBuildSettings ?? mod?.default;
  if (typeof mount !== "function" || state.settings) return;
  state.settings = mount({ initial: readReturnSettings(), onChange: onSettingsChange, play });
  // Normally mounted before the director plans. If the module arrived after that, hand the gear to
  // the running build (queued, or a mini-build once done) like any late content.
  const gear = state.settings?.button;
  if (gear && directorState() !== "idle") {
    document.dispatchEvent(new CustomEvent("build:layers-added", { detail: { root: gear } }));
  }
}

/* ─────────────────────────────── toggles ─────────────────────────────── */

// The toggles keep static names ("Animations", "Sound"); aria-pressed alone carries the state,
// so screen readers never announce double negatives like "Sound off, not pressed".
function syncAnimToggle() {
  document.getElementById("anim-toggle")?.setAttribute("aria-pressed", String(state.animOn));
}

function syncSoundToggle() {
  document.getElementById("sound-toggle")?.setAttribute("aria-pressed", String(sfxEnabled()));
}

/**
 * Live animation switch. Off: fast-forward any running build (or late-cards mini-build),
 * freeze the 3D object, drop Lenis smoothing. On: resume them (no
 * automatic rebuild). persist:false changes this visit only (a replay from the HUD).
 */
function setAnimations(on, { persist = true } = {}) {
  state.animOn = on;
  if (persist) store.set(ANIM_KEY, on ? "on" : "off");
  root.classList.toggle("anim-off", !on); // styling hook for CSS transitions
  syncAnimToggle();
  guard("hero3d setAnimate", () => state.hero?.setAnimate(on));
  if (on) {
    guard("lenis", enableLenis);
    return;
  }
  disableLenis();
  // skip() fast-forwards a build or a late-cards mini-build, and is a no-op otherwise
  if (state.director) guard("director skip", () => state.director.skip());
  clearBuildPending(); // with animations off nothing may stay hidden (e.g. repo cards arriving later)
}

/** sfx.toggle() owns the rules (a first click that just unlocked audio keeps sound on) and the feedback chirp. */
function toggleSound() {
  guard("sfx toggle", () => sfx.toggle({ feedback: true }));
  syncSoundToggle();
}

function initToggles() {
  syncAnimToggle();
  syncSoundToggle();
  guard("sfx onChange", () => sfx.onChange(() => syncSoundToggle())); // HUD / keyboard mutes

  document.getElementById("anim-toggle")?.addEventListener("click", () => {
    setAnimations(!state.animOn);
    play(state.animOn ? "toggleOn" : "toggleOff");
  });
  document.getElementById("sound-toggle")?.addEventListener("click", toggleSound);
  document.getElementById("rebuild-btn")?.addEventListener("click", rebuild);

  // M / R shortcuts (advertised in the buttons' titles). While a director exists its HUD owns
  // these keys; this fallback covers the no-build case. A bare R never undoes the visitor's
  // "animations off" choice: with animations off, the nav Rebuild button is the way back.
  document.addEventListener("keydown", (e) => {
    if (state.director || e.repeat || e.altKey || e.ctrlKey || e.metaKey || isEditable(e.target)) return;
    const key = e.key.toLowerCase();
    if (key === "m") toggleSound();
    else if (key === "r" && state.animOn) rebuild();
  });
}

/* ──────────────────────────── UI sound effects ──────────────────────────── */

// Controls that play their own sounds: the nav toggles here, the HUD inside the director,
// the settings popover in settings.js.
const SELF_SOUNDING = "#sound-toggle, #anim-toggle, .build-hud, .build-settings, [data-sfx='off']";

function initUiSfx() {
  let lastHover = 0;
  // Hover ticks need real movement: when the layout shifts under a resting cursor (the HUD
  // changing state, a label changing width) the browser fires pointerover without any move.
  let moved = false;
  document.addEventListener("pointermove", () => (moved = true), { passive: true });
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse" || !moved) return;
    moved = false;
    const el = e.target instanceof Element ? e.target.closest("a, button") : null;
    if (!el || (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) return; // moved within el
    const now = performance.now();
    if (now - lastHover < 60) return;
    lastHover = now;
    let unlocked = false;
    try {
      unlocked = !!sfx.unlocked;
    } catch {
      /* treat as locked */
    }
    if (unlocked) play("hover", { x: panX(e) });
  });

  document.addEventListener("click", (e) => {
    const el = e.target instanceof Element ? e.target.closest("a, button") : null;
    if (!el || el.closest(SELF_SOUNDING)) return;
    play("click", { x: panX(e) });
  });
}

/* ─────────────────────────────── hero 3D ─────────────────────────────── */

async function mountHero() {
  const container = document.getElementById("hero3d");
  if (!container) return;
  try {
    const { mountHero3D } = await import("./hero3d.js");
    const hero = await mountHero3D(container, { animate: state.animOn });
    if (!hero) return;
    state.hero = hero;
    hero.setAnimate?.(state.animOn); // the toggle may have flipped while three.js was loading
  } catch (err) {
    warn("hero 3D", err); // the CSS fallback blob stays visible
  }
}

/**
 * The first paint of a project SVG is expensive (≈ 100–200 ms each). Drawing each one once
 * into a throwaway canvas as soon as it has loaded pays that cost up front (on the black
 * pre-boot screen) instead of as a freeze when the build reveals the image mid-tour.
 */
function warmVisuals() {
  const imgs = [...document.querySelectorAll(".project-visual img")];
  return Promise.all(
    imgs.map(
      (img) =>
        new Promise((resolve) => {
          const draw = () => {
            try {
              const r = img.getBoundingClientRect();
              const k = Math.min(2, window.devicePixelRatio || 1);
              const c = document.createElement("canvas");
              c.width = Math.max(1, Math.round((r.width || img.naturalWidth) * k));
              c.height = Math.max(1, Math.round((r.height || img.naturalHeight) * k));
              c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
            } catch {
              /* a warm-up only: never fails anything */
            }
            resolve();
          };
          if (img.complete) draw();
          else {
            img.addEventListener("load", draw, { once: true });
            img.addEventListener("error", resolve, { once: true });
          }
        })
    )
  );
}

/* ─────────────────────────────── injected CSS ─────────────────────────────── */

const RUNTIME_CSS = `
/* Lenis (recommended base styles) */
html.lenis, html.lenis body { height: auto; }
.lenis.lenis-smooth { scroll-behavior: auto !important; }
.lenis.lenis-smooth [data-lenis-prevent] { overscroll-behavior: contain; }
.lenis.lenis-stopped { overflow: hidden; }
/* Sections focused programmatically after keyboard anchor navigation */
section[tabindex="-1"]:focus, main[tabindex="-1"]:focus, footer[tabindex="-1"]:focus { outline: none; }`;

function injectStyles() {
  const style = document.createElement("style");
  style.id = "main-runtime-css";
  style.textContent = RUNTIME_CSS;
  document.head.appendChild(style);
}

/* ─────────────────────────────── boot ─────────────────────────────── */

/** Dynamic import that never rejects: a failed fetch (404, offline, CDN) logs and resolves to null. */
async function loadModule(path, label) {
  try {
    return await import(path);
  } catch (err) {
    warn(`${label} module`, err);
    return null;
  }
}

/** The sound engine and the build engine (both same-origin, modulepreloaded by index.html). */
async function loadEngines() {
  const [sfxMod, buildMod] = await Promise.all([loadModule("./sfx.js", "sound"), loadModule("./build/director.js", "build")]);
  const engine = sfxMod?.sfx ?? sfxMod?.default;
  if (engine && typeof engine.play === "function") sfx = engine;
  else console.warn("[main] sound engine unavailable; sound disabled");
  const make = buildMod?.createDirector ?? buildMod?.default;
  createDirector = typeof make === "function" ? make : null;
  brandSvg = typeof buildMod?.BRAND_SVG === "string" ? buildMod.BRAND_SVG : "";
}

let brandSvg = "";

/**
 * The boot logo tile, shown during the pre-boot wait so the first second isn't a blank
 * black screen. The director adopts it (same element, no second entrance animation);
 * initialBuild() removes it if no build starts.
 */
function showPrebootLogo() {
  if (!brandSvg || document.querySelector(".build-logo")) return;
  const tile = document.createElement("div");
  tile.className = "build-logo";
  tile.dataset.preboot = "";
  tile.setAttribute("aria-hidden", "true");
  tile.innerHTML = brandSvg;
  document.body.appendChild(tile);
}

function boot() {
  guard("styles", injectStyles);
  store.remove(LEGACY_SPEED_KEY); // v1 remembered the HUD speed; the HUD now changes one run only

  // The settings gear joins the nav before the director plans (so the build builds it with the
  // other nav chips). Loaded on its own, never blocking the engines; a failure means no gear.
  const settingsReady = loadModule("./settings.js", "settings").then((mod) => guard("settings", () => initSettings(mod)));

  // Content first, so the director's initial plan already sees final text where possible.
  // None of this depends on the engines below, so it works even if they fail to load.
  guard("email", () => applyEmail());
  // Renders the cards and dispatches `build:layers-added`; the director decides (incl. the
  // animations-off check) whether that means queueing, a mini-build, or nothing.
  guard("GitHub repos", () => loadGitHubRepos());
  guard("YouTube stats", () => loadYouTubeStats({ setText: setLayerText }));

  const heroReady = guard("hero 3D", mountHero);
  const building = state.animOn && root.classList.contains("build-pending");
  const visualsReady = building ? guard("visuals warm-up", warmVisuals) : null;

  guard("scroll detection", initUserScrollDetection);
  guard("lenis", () => state.animOn && enableLenis());
  guard("anchors", initAnchors);
  guard("nav", initNav);
  // Native agent cursor + trailing "you" tag. Its own module: a failed load just leaves the
  // system cursor (nothing else depends on it).
  loadModule("./cursor.js", "cursor").then((mod) =>
    guard("agent cursor", () =>
      mod?.initCursor?.({
        root,
        finePointer: FINE_POINTER,
        isEditable,
        animOn: () => state.animOn,
        onError: (err) => warn("agent cursor", err),
      })
    )
  );
  root.classList.toggle("anim-off", !state.animOn);

  // Debug / integration handle (read-only).
  window.__ktr0a = Object.freeze({
    get director() {
      return state.director;
    },
    get lenis() {
      return state.lenis;
    },
    get animations() {
      return state.animOn;
    },
    /** 'first' | 'return' | 'default' | null: which kind of run the director is playing. */
    get run() {
      return state.runKind;
    },
    get settings() {
      return state.settings;
    },
    scroller,
    rebuild,
    setAnimations,
  });

  // Then sound + build. If the build engine is unavailable, startDirector() reveals the page
  // at once (instead of the 6 s fail-safe in index.html).
  loadEngines()
    .catch((err) => warn("engines", err))
    .then(() => {
      guard("sfx init", () => sfx.init());
      guard("toggles", initToggles);
      guard("ui sfx", initUiSfx);
      if (!building) return;
      if (createDirector) guard("preboot logo", showPrebootLogo);
      // The first visit shows its start screen right away (the 3D object warms up while the
      // visitor reads it); only the gear must be in the nav before the build plans.
      if (automaticRun().kind === "first") return settingsReady;
      const settled = Promise.allSettled([heroReady, visualsReady, settingsReady]);
      return Promise.race([settled, new Promise((r) => setTimeout(r, PREBOOT_WAIT_MS))]);
    })
    .finally(() => guard("build", initialBuild));
}

boot();
