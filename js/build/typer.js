/* ═══════════════════════════════════════════════════════════════════════════
   typer.js: DOM text typing, selection and clone-then-edit helpers (SPEC §5)

   Every helper works on the layer's REAL text nodes and is layout-neutral:
   untyped characters are not removed, they are moved into a sibling
   <span class="build-rest"> that is visibility:hidden. Line breaks, heights and
   widths therefore never change while text "appears", so cached rects stay valid
   and nothing below the layer jumps.

   Restoration is exact and node-preserving: each original text node gets its
   original data back and every helper element is removed. Because the original
   nodes are kept (not re-created via innerHTML), references held by other code
   (e.g. data.js filling [data-yt] / [data-email-text]) stay valid, and if other
   code replaced a node mid-type, restoring the detached one is a harmless no-op.

   Two API levels:
   - Frame-driven handles (beginType, selectWord, cloneText, selectAll) used by the
     director, so typing follows build time (speed 1x/2x/4x, tab pause).
   - Promise wrappers from the spec (typeLayer, selectAndRetype, cloneInto, retype)
     that drive the same handles with their own rAF loop.
   ═══════════════════════════════════════════════════════════════════════════ */

const VISIBLE = /\S/;

/** Elements whose text the typer never touches. */
function isOpaque(node) {
  if (node instanceof SVGElement) return true;
  const tag = node.nodeName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE" || tag === "NOSCRIPT" || tag === "TEXTAREA") return true;
  if (node.hasAttribute("data-layer")) return true; // nested layers are typed by their own task
  const cls = node.className;
  return typeof cls === "string" && cls.startsWith("build-"); // our own helper elements
}

/**
 * Non-whitespace text nodes of `el` in document order, skipping SVG, nested
 * [data-layer] subtrees and build helper elements.
 */
export function textNodesOf(el) {
  const out = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return VISIBLE.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      return isOpaque(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
  return out;
}

/** Number of visible (non-whitespace) characters a layer will type. */
export function countChars(el) {
  let n = 0;
  for (const node of textNodesOf(el)) for (const ch of node.data) if (VISIBLE.test(ch)) n++;
  return n;
}

function makeSpan(className, text) {
  const s = document.createElement("span");
  s.className = className;
  s.setAttribute("aria-hidden", "true");
  if (text != null) s.textContent = text;
  return s;
}

/** The blinking insertion caret. Zero width, so it never shifts text. */
export function createCaret() {
  return makeSpan("build-caret");
}

/* ───────────────────────────── typing ───────────────────────────── */

/**
 * Prepares `el` for typing: all of its text becomes invisible (but keeps its
 * layout). Returns a handle:
 *   total        number of visible characters
 *   set(n)       show the first n visible characters (whitespace is free)
 *   progress(p)  same with p in 0..1
 *   restore()    exact original DOM (idempotent)
 */
export function beginType(el, { caret = true } = {}) {
  const parts = textNodesOf(el).map((node) => {
    const full = node.data;
    // stops[i] = string index just after the (i+1)-th visible character
    const stops = [];
    for (let i = 0; i < full.length; i++) if (VISIBLE.test(full[i])) stops.push(i + 1);
    const rest = makeSpan("build-rest", full);
    node.data = "";
    node.parentNode.insertBefore(rest, node.nextSibling);
    return { node, full, stops, rest, shown: -1 };
  });
  const total = parts.reduce((s, p) => s + p.stops.length, 0);
  const caretEl = caret ? createCaret() : null;
  let caretAt = null;
  let shownTotal = -1;
  let restored = false;

  function placeCaret(part) {
    if (!caretEl || !part || caretAt === part || !part.node.parentNode) return;
    part.node.parentNode.insertBefore(caretEl, part.rest);
    caretAt = part;
  }

  function set(n) {
    if (restored) return;
    n = Math.max(0, Math.min(total, Math.floor(n)));
    if (n === shownTotal) return;
    shownTotal = n;
    let offset = 0;
    let active = null; // the node currently receiving characters (caret goes after it)
    for (const part of parts) {
      const vis = Math.max(0, Math.min(part.stops.length, n - offset));
      // A finished node shows everything incl. trailing whitespace; a partial one ends at its last typed glyph.
      const cut = vis >= part.stops.length ? part.full.length : vis > 0 ? part.stops[vis - 1] : 0;
      if (cut !== part.shown) {
        part.shown = cut;
        part.node.data = part.full.slice(0, cut);
        const rest = part.full.slice(cut);
        if (part.rest.firstChild) part.rest.firstChild.data = rest;
        else part.rest.textContent = rest;
      }
      if (!active && vis < part.stops.length) active = part;
      offset += part.stops.length;
    }
    placeCaret(active || parts[parts.length - 1]);
  }

  function restore() {
    if (restored) return;
    restored = true;
    for (const part of parts) {
      part.node.data = part.full;
      part.rest.remove();
    }
    caretEl?.remove();
  }

  set(0);
  return {
    total,
    set,
    progress: (p) => set(Math.round(Math.max(0, Math.min(1, p)) * total)),
    restore,
    get done() {
      return shownTotal >= total;
    },
  };
}

/* ───────────────────────────── selection ───────────────────────────── */

/**
 * Wraps the `wordIndex`-th word (counted across the layer's text nodes; negative
 * counts from the end) in <span class="build-sel">. Returns null when the layer has
 * no such word, else a handle:
 *   word, el               the selected word and its highlight span
 *   beginRetype(opts)      clears the highlight and returns a typing handle for the word
 *   restore()              exact original DOM
 */
export function selectWord(el, wordIndex = 0) {
  const words = [];
  for (const node of textNodesOf(el)) {
    const re = /\S+/g;
    let m;
    while ((m = re.exec(node.data))) words.push({ node, start: m.index, end: m.index + m[0].length });
  }
  if (!words.length) return null;
  const idx = wordIndex < 0 ? words.length + wordIndex : wordIndex;
  const w = words[Math.max(0, Math.min(words.length - 1, idx))];
  const { node } = w;
  const full = node.data;
  const word = full.slice(w.start, w.end);
  const sel = makeSpan("build-sel", word);
  sel.removeAttribute("aria-hidden"); // it is real content while it exists
  const after = document.createTextNode(full.slice(w.end));
  node.data = full.slice(0, w.start);
  node.parentNode.insertBefore(after, node.nextSibling);
  node.parentNode.insertBefore(sel, after);
  let typing = null;
  let restored = false;
  return {
    word,
    el: sel,
    beginRetype(opts) {
      sel.classList.add("is-retyping");
      typing = beginType(sel, opts);
      return typing;
    },
    restore() {
      if (restored) return;
      restored = true;
      typing?.restore();
      node.data = full;
      sel.remove();
      after.remove();
    },
  };
}

/** Index of the longest word in a layer (a natural "edit me" candidate), or -1. */
export function longestWordIndex(el, { fromEnd = false } = {}) {
  let best = -1;
  let bestLen = 0;
  let i = 0;
  for (const node of textNodesOf(el)) {
    for (const m of node.data.matchAll(/\S+/g)) {
      const len = m[0].replace(/[^\p{L}\p{N}]/gu, "").length;
      if (len > bestLen || (fromEnd && len === bestLen && len > 0)) {
        best = i;
        bestLen = len;
      }
      i++;
    }
  }
  return bestLen >= 3 ? best : -1;
}

/* ──────────────────────────── clone-then-edit ──────────────────────────── */

/** Snapshot of an element's style attribute, restorable byte-for-byte. */
export function styleSnapshot(el) {
  const had = el.hasAttribute("style");
  const value = el.getAttribute("style");
  return () => {
    // Chrome serialises CSSOM writes into the attribute lazily; without this read a later
    // sync would bring back an empty style="" after removeAttribute().
    el.getAttribute("style");
    if (had) el.setAttribute("style", value);
    else el.removeAttribute("style");
  };
}

/**
 * Shows `src`'s text inside `target` ("paste"), keeping target's geometry frozen
 * at `box` ({ w, h, inline }) so the swap never reflows the page. Text nodes are
 * mapped by index; extra source text goes into the last target node.
 * Returns { restore() } (exact original text + style attribute).
 */
export function cloneText(src, target, box) {
  const srcText = textNodesOf(src).map((n) => n.data);
  const nodes = textNodesOf(target);
  const originals = nodes.map((n) => n.data);
  const restoreStyle = styleSnapshot(target);
  if (box && box.w > 0 && box.h > 0) {
    const s = target.style;
    if (box.inline) s.display = "inline-block";
    s.boxSizing = "border-box";
    s.width = `${box.w}px`;
    s.height = `${box.h}px`;
    s.overflow = "clip";
    s.whiteSpace = box.inline ? "nowrap" : s.whiteSpace;
  }
  nodes.forEach((n, i) => {
    let text = i < srcText.length ? srcText[i] : "";
    if (i === nodes.length - 1 && srcText.length > nodes.length) text += srcText.slice(nodes.length).join("");
    n.data = text;
  });
  let restored = false;
  return {
    restore() {
      if (restored) return;
      restored = true;
      nodes.forEach((n, i) => (n.data = originals[i]));
      restoreStyle();
    },
  };
}

/** Blue "select all" highlight on a whole layer. Returns an undo function. */
export function selectAll(el) {
  const had = el.classList.contains("build-selall");
  el.classList.add("build-selall");
  return () => {
    if (!had) el.classList.remove("build-selall");
  };
}

/* ───────────────────── promise wrappers (spec signatures) ───────────────────── */

function rafLoop(step) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (now) => {
      if (step((now - t0) / 1000)) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Types `el` char by char at `cps` characters per second. `onChar(count, total)` is
 * called whenever more characters appear. Resolves after the exact original DOM is back.
 */
export async function typeLayer(el, { cps = 60, onChar, caret = true } = {}) {
  const h = beginType(el, { caret });
  let last = 0;
  try {
    await rafLoop((t) => {
      const n = Math.min(h.total, Math.floor(t * cps));
      h.set(n);
      if (n !== last) {
        last = n;
        onChar?.(n, h.total);
      }
      return n >= h.total;
    });
  } finally {
    h.restore();
  }
}

/** Highlights a word, then retypes it (as `replacement`, default the word itself). */
export async function selectAndRetype(el, wordIndex = 0, replacement, { cps = 40, hold = 0.28 } = {}) {
  const sel = selectWord(el, wordIndex);
  if (!sel) return;
  try {
    await rafLoop((t) => t >= hold);
    if (replacement != null && replacement !== sel.word) sel.el.textContent = replacement;
    const h = sel.beginRetype();
    await rafLoop((t) => {
      h.set(t * cps);
      return h.done;
    });
  } finally {
    sel.restore();
  }
}

/**
 * Pastes `src`'s text into every target (with a blue flash). Returns handles whose
 * restore() puts each target back; call retype(target, handle) to finish one.
 */
export function cloneInto(src, targets) {
  return targets.map((t) => {
    const r = t.getBoundingClientRect();
    const inline = getComputedStyle(t).display === "inline";
    const h = cloneText(src, t, { w: r.width, h: r.height, inline });
    t.classList.add("build-paste");
    setTimeout(() => t.classList.remove("build-paste"), 420);
    return { target: t, restore: h.restore };
  });
}

/** Selects all of `target` (blue), restores the clone, then types the real value. */
export async function retype(target, cloneHandle, { cps = 50, hold = 0.25 } = {}) {
  const unselect = selectAll(target);
  try {
    await rafLoop((t) => t >= hold);
  } finally {
    unselect();
    cloneHandle?.restore();
  }
  await typeLayer(target, { cps });
}
