/* ═══════════════════════════════════════════════════════════════════════════
   cursor.js: native agent cursor + trailing "you" tag (fine pointers only)

   The arrow is a NATIVE cursor: a CSS cursor image (inline SVG data URI, the
   build agents' arrow shape), so the OS draws and moves it at input rate with
   zero lag. The page never positions it.
   The only element JS moves is the small "you" tag, which trails the pointer
   with a slight, frame-rate-independent delay (exponential smoothing,
   TAU seconds) and costs nothing at rest: its rAF loop runs only until the tag
   has caught up.

   Fail-safe: every custom cursor value ends with a keyword fallback (default /
   pointer), the custom values only apply under html.has-native-cursor (added
   here, removed on any error), and there is no `cursor: none` anywhere, so
   the page can never end up without a visible cursor.

   CSS hooks: --cur-default / --cur-link (set under html.has-native-cursor).
   Author rules that want a "clickable" cursor use `cursor: var(--cur-link, pointer)`.
   ═══════════════════════════════════════════════════════════════════════════ */

const TAU = 0.045; // s: the tag's trailing delay (time constant). ~45 ms: noticeable, never sluggish
const SETTLE = 0.05; // px: below this the tag snaps onto the target and the loop stops
const MAX_DT = 0.1; // s: clamp after a dropped frame / tab switch (no jumps)
const TAG_X = 11; // px from the arrow tip to the tag (same placement as before)
const TAG_Y = 18;

const INTERACTIVE = "a[href], button:not(:disabled), [role='button'], summary, label[for], select";

// The build agents' arrow (agents.js ARROW, +1 px so the tip sits at 1,1), 16×24 CSS px box:
// small enough that Chrome/Safari's viewport-containment rule only swaps in the system arrow
// within a few px of the right/bottom edge. Shadow lives inside the SVG (CSS filters don't
// apply to cursor images). Explicit width/height = natural size, so every engine rasterizes it
// at the device pixel ratio (sharp at 1x, 1.25x, 1.5x, 2x).
const ARROW_PATH = "M1 1V16.5L4.9 12.9 7.6 18.6 10.1 17.5 7.5 11.9H12.6Z";
const arrowSvg = (fill, stroke) =>
  "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='24' viewBox='0 0 16 24'>" +
  "<defs><filter id='s' x='-40%' y='-30%' width='180%' height='160%' color-interpolation-filters='sRGB'>" +
  "<feDropShadow dx='0' dy='1' stdDeviation='0.9' flood-color='#000' flood-opacity='0.55'/></filter></defs>" +
  `<path d='${ARROW_PATH}' fill='${fill}' stroke='${stroke}' stroke-width='1' stroke-linejoin='round' filter='url(#s)'/>` +
  "</svg>";
const cursorUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

const CUR_DEFAULT = `${cursorUrl(arrowSvg("#ffffff", "#08080a"))} 1 1, default`;
const CUR_LINK = `${cursorUrl(arrowSvg("#3d7bff", "#ffffff"))} 1 1, pointer`;

const CSS = `
/* Native cursor. Inherited from html; :where() keeps specificity at zero, which still beats
   the UA's link/button rules. Text fields keep the system I-beam. */
html { cursor: var(--cur-default, auto); }
:where(a[href], button:not(:disabled), [role="button"], summary, label[for], select,
  input:is([type="button"], [type="submit"], [type="reset"], [type="checkbox"], [type="radio"],
    [type="range"], [type="color"], [type="file"])) {
  cursor: var(--cur-link, pointer);
}
:where(textarea, [contenteditable]:not([contenteditable="false"]),
  input:not([type="button"], [type="submit"], [type="reset"], [type="checkbox"], [type="radio"],
    [type="range"], [type="color"], [type="file"], [type="image"], [type="hidden"])) {
  cursor: text;
}
/* Custom images only for fine pointers, and never in forced-colors (high contrast) mode,
   where the system cursor follows the user's palette and size. */
@media (hover: hover) and (pointer: fine) and (forced-colors: none) {
  html.has-native-cursor {
    --cur-default: ${CUR_DEFAULT};
    --cur-link: ${CUR_LINK};
  }
}
/* The trailing "you" tag: positioned by transform only, never takes pointer events. */
.agent-tag {
  position: fixed; left: 0; top: 0; z-index: 2147483647;
  pointer-events: none; user-select: none;
  opacity: 0; transition: opacity .16s ease;
  will-change: transform; contain: layout style;
}
.agent-tag.is-visible { opacity: 1; }
html:not(.has-native-cursor) .agent-tag { display: none; }
.agent-tag__pill {
  display: block; padding: 2px 6px 3px; border-radius: 999px;
  font: 500 10px/1.1 var(--font-mono, "JetBrains Mono", ui-monospace, monospace); letter-spacing: .02em;
  color: var(--text, #f4f5f7); background: rgba(14, 15, 18, .92);
  border: 1px solid var(--line-2, rgba(255, 255, 255, .15)); white-space: nowrap;
  transform-origin: 0 0;
  transition: transform .14s cubic-bezier(.2, .8, .2, 1), background-color .14s ease, border-color .14s ease;
}
.agent-tag.is-link .agent-tag__pill { background: var(--blue, #3d7bff); border-color: transparent; }
.agent-tag.is-down .agent-tag__pill { transform: scale(.88); }
@media (forced-colors: active) { .agent-tag { display: none; } }
@media print { .agent-tag { display: none; } }
`;

function injectCss() {
  if (document.getElementById("cursor-css")) return;
  const style = document.createElement("style");
  style.id = "cursor-css";
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * @param {object} opts
 * @param {HTMLElement} [opts.root]          document.documentElement
 * @param {MediaQueryList} [opts.finePointer] "(hover: hover) and (pointer: fine)"
 * @param {(el: EventTarget|null) => boolean} [opts.isEditable] true over text fields
 * @param {() => boolean} [opts.animOn]      the site's animation switch (off: the tag snaps, no trailing)
 * @param {(err: unknown) => void} [opts.onError]
 * @returns {{ destroy(): void }}
 */
export function initCursor({
  root = document.documentElement,
  finePointer = window.matchMedia("(hover: hover) and (pointer: fine)"),
  isEditable = (el) => el instanceof Element && !!el.closest("input, textarea, select, [contenteditable]"),
  animOn = () => true,
  onError = (err) => console.warn("[cursor] failed:", err),
} = {}) {
  const listeners = [];
  let tag = null;
  let failed = false;
  let frame = 0;
  let last = 0; // rAF timestamp of the previous step (0 = loop just (re)started)
  let tx = 0; // pointer (target)
  let ty = 0;
  let px = 0; // tag position (follows target)
  let py = 0;
  let shown = false;
  let overEditable = false;
  let viewportW = root.clientWidth; // cached: no layout reads on pointermove

  const on = (target, type, fn, opts) => {
    if (typeof target.addEventListener === "function") target.addEventListener(type, fn, opts);
    else if (type === "change" && typeof target.addListener === "function") target.addListener(fn); // old Safari MQL
    listeners.push(() => {
      if (typeof target.removeEventListener === "function") target.removeEventListener(type, fn, opts);
      else if (type === "change" && typeof target.removeListener === "function") target.removeListener(fn);
    });
  };

  /** Tear everything down and give the page the plain system cursor back. */
  const teardown = () => {
    failed = true;
    root.classList.remove("has-native-cursor");
    cancelAnimationFrame(frame);
    frame = 0;
    listeners.splice(0).forEach((off) => off());
    tag?.remove();
    tag = null;
  };
  const fail = (err) => {
    if (failed) return;
    teardown();
    if (err) onError(err);
  };
  const safe = (fn) => (e) => {
    if (failed) return;
    try {
      fn(e);
    } catch (err) {
      fail(err);
    }
  };

  const write = () => {
    tag.style.transform = `translate3d(${px + TAG_X}px, ${py + TAG_Y}px, 0)`;
  };

  const hide = () => {
    if (!shown) return;
    shown = false;
    tag.classList.remove("is-visible", "is-down");
    cancelAnimationFrame(frame);
    frame = 0;
  };

  const step = (now) => {
    frame = 0;
    if (failed || !shown) return;
    try {
      const dt = last ? Math.min(MAX_DT, (now - last) / 1000) : 1 / 60;
      last = now;
      if (animOn()) {
        const a = 1 - Math.exp(-dt / TAU); // frame-rate independent
        px += (tx - px) * a;
        py += (ty - py) * a;
      } else {
        px = tx;
        py = ty;
      }
      const settled = Math.abs(tx - px) < SETTLE && Math.abs(ty - py) < SETTLE;
      if (settled) {
        px = tx;
        py = ty;
      }
      write();
      if (settled) last = 0; // idle: no loop until the next move
      else frame = requestAnimationFrame(step);
    } catch (err) {
      fail(err);
    }
  };
  const kick = () => {
    if (!frame) frame = requestAnimationFrame(step);
  };

  const enable = () => root.classList.add("has-native-cursor");
  const disable = () => {
    root.classList.remove("has-native-cursor");
    hide();
  };

  try {
    injectCss();

    tag = document.createElement("div");
    tag.className = "agent-tag";
    tag.setAttribute("aria-hidden", "true");
    tag.innerHTML = '<span class="agent-tag__pill">you</span>';
    document.body.appendChild(tag);

    if (finePointer.matches) enable();

    on(
      window,
      "pointermove",
      safe((e) => {
        if (!finePointer.matches) return;
        if (e.pointerType !== "mouse") return hide(); // pen / touch on hybrids: system behaviour
        tx = e.clientX;
        ty = e.clientY;
        // Over text fields the system I-beam shows alone; over the page scrollbar the OS
        // always draws its own arrow, so the tag steps aside there too.
        const want = !overEditable && tx < viewportW;
        if (!want) return hide();
        if (!shown) {
          // (Re)appearing: snap to the pointer, never glide in from where it vanished.
          shown = true;
          px = tx;
          py = ty;
          last = 0;
          write();
          tag.classList.add("is-visible");
          return;
        }
        kick();
      }),
      { passive: true }
    );
    // Hover state changes only when the element under the pointer changes (also after a
    // scroll under a resting pointer), so no closest() call on every move.
    on(
      window,
      "pointerover",
      safe((e) => {
        if (e.pointerType && e.pointerType !== "mouse") return;
        const t = e.target instanceof Element ? e.target : null;
        overEditable = isEditable(t);
        tag.classList.toggle("is-link", !!(t && t.closest(INTERACTIVE)));
        if (overEditable) hide();
      }),
      { passive: true }
    );
    on(window, "pointerdown", safe((e) => e.pointerType === "mouse" && tag.classList.add("is-down")), { passive: true });
    on(window, "pointerup", safe(() => tag.classList.remove("is-down")), { passive: true });
    on(window, "pointercancel", safe(() => tag.classList.remove("is-down")), { passive: true });
    // Leaving the window, switching away, or a native drag (the OS draws the drag cursor).
    on(window, "mouseout", safe((e) => !e.relatedTarget && hide()), { passive: true });
    on(window, "blur", safe(hide));
    on(window, "dragstart", safe(hide));
    on(document, "visibilitychange", safe(() => document.hidden && hide()));
    on(window, "resize", safe(() => (viewportW = root.clientWidth)), { passive: true });
    // Pointer capabilities can change at runtime (tablet mode, docking): follow them both ways.
    on(finePointer, "change", safe(() => (finePointer.matches ? enable() : disable())));
  } catch (err) {
    fail(err);
  }

  return {
    destroy() {
      if (!failed) teardown();
    },
  };
}

export default initCursor;
