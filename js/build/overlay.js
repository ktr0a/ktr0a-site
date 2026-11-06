/* ═══════════════════════════════════════════════════════════════════════════
   overlay.js: canvas rendering of the construction graphics (SPEC §5)

   Everything the "design tool" draws on top of the page while agents build it:
   wireframes with an animated draw-in, corner handles, dimension pills,
   converging offset copies, grey media placeholders (with nested measuring
   boxes), guide lines, red QA boxes, long section rules, the faint per-section
   scaffold, the pixel ruler, the red margin guide and column guides.
   Graphics of page layers are clipped below the fixed nav (+ ruler strip);
   graphics of fixed layers (the nav itself) are not.

   Items live in BUILD time (seconds, already multiplied by the speed factor) and
   reference layer objects owned by the director:
     layer.rect  = { x, y, w, h }  document coords (viewport coords if layer.fixed)
     layer.fixed = true for layers inside position:fixed ancestors (the nav)
     layer.lines = [{ x, y, w, h }] text line boxes (same space as rect)
     layer.font  = CSS font shorthand (for QA "diff" text)
   so a re-measure (resize, fonts ready) moves every live graphic automatically.

   Glow is a wide translucent under-stroke instead of shadowBlur, which keeps a
   few hundred primitives per frame cheap. Lines are snapped to device pixels.
   ═══════════════════════════════════════════════════════════════════════════ */

export const COLORS = {
  blue: "#3d7bff",
  blueLine: "#4f88ff",
  blue2: "#6c9bff",
  blueGlow: "rgba(61,123,255,0.30)",
  red: "#ff3b3b",
  redGlow: "rgba(255,59,59,0.28)",
  placeholder: "rgba(148,163,184,0.30)",
  white: "#ffffff",
};

const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const PILL_FONT = `500 9px ${MONO}`;
const RULER_H = 18;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const easeInOut = (t) => ((t = clamp01(t)) < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const rand = (a, b) => a + Math.random() * (b - a);

/** Linear blend of two #rrggbb colours, returned as rgba() with alpha a. */
function mix(c1, c2, f, a = 1) {
  const p = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  const ch = (i) => Math.round(p(c1, i) + (p(c2, i) - p(c1, i)) * f);
  return `rgba(${ch(0)},${ch(1)},${ch(2)},${a})`;
}

/** Point at fraction p (0..1) along a rect's perimeter, clockwise from top-left. */
export function perimeterPoint(r, p) {
  const P = 2 * (r.w + r.h) || 1;
  let d = clamp01(p) * P;
  if (d <= r.w) return { x: r.x + d, y: r.y };
  d -= r.w;
  if (d <= r.h) return { x: r.x + r.w, y: r.y + d };
  d -= r.h;
  if (d <= r.w) return { x: r.x + r.w - d, y: r.y + r.h };
  d -= r.w;
  return { x: r.x, y: r.y + r.h - d };
}

export function createOverlay() {
  let dpr = 1;
  let vw = 0;
  let vh = 0;
  let items = [];
  let half = 0.5; // device-pixel snap offset for 1px lines

  // Page construction aids (ruler + per-section guides)
  const ruler = { alpha: 0, target: 0, top: 0, f0: 0, f1: 0, t0: 0, t1: 0, sprite: null, has: false };
  let aids = []; // [{ x, w, cols, alpha, target }]
  let glitchUntil = -1;

  const snap = (v) => Math.round(v * dpr) / dpr + half;

  /* ───────────── layer geometry ───────────── */

  function viewRect(layer, scrollY) {
    const r = layer.rect;
    return { x: r.x, y: layer.fixed ? r.y : r.y - scrollY, w: r.w, h: r.h };
  }

  const offscreen = (r, pad = 80) => r.y > vh + pad || r.y + r.h < -pad || r.x > vw + pad || r.x + r.w < -pad;

  /* ───────────── primitives ───────────── */

  function glowStroke(ctx, path, color, glow, alpha, width = 1) {
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width + 2.5;
    ctx.strokeStyle = glow;
    path();
    ctx.stroke();
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    path();
    ctx.stroke();
  }

  /** Perimeter path drawn up to fraction p (clockwise from top-left). */
  function perimeterPath(ctx, r, p) {
    const x0 = snap(r.x);
    const y0 = snap(r.y);
    const x1 = snap(r.x + r.w);
    const y1 = snap(r.y + r.h);
    const w = x1 - x0;
    const h = y1 - y0;
    let d = clamp01(p) * 2 * (w + h);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    const seg = (len, fx, fy, tx, ty) => {
      if (d <= 0) return;
      const f = Math.min(1, d / (len || 1));
      ctx.lineTo(fx + (tx - fx) * f, fy + (ty - fy) * f);
      d -= len;
    };
    seg(w, x0, y0, x1, y0);
    seg(h, x1, y0, x1, y1);
    seg(w, x1, y1, x0, y1);
    seg(h, x0, y1, x0, y0);
  }

  function handle(ctx, x, y, color, alpha, size = 5) {
    const s = size;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = COLORS.white;
    ctx.fillRect(Math.round(x - s / 2), Math.round(y - s / 2), s, s);
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.strokeRect(Math.round(x - s / 2) + 0.5, Math.round(y - s / 2) + 0.5, s - 1, s - 1);
  }

  function cross(ctx, x, y, color, alpha, arm = 4) {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(snap(x) - arm, snap(y));
    ctx.lineTo(snap(x) + arm, snap(y));
    ctx.moveTo(snap(x), snap(y) - arm);
    ctx.lineTo(snap(x), snap(y) + arm);
    ctx.stroke();
  }

  function pill(ctx, text, cx, top, bg, alpha) {
    ctx.font = PILL_FONT;
    const w = Math.ceil(ctx.measureText(text).width) + 8;
    const x = Math.round(cx - w / 2);
    const y = Math.round(top);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = bg;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, 13, 2);
    else ctx.rect(x, y, w, 13);
    ctx.fill();
    ctx.fillStyle = COLORS.white;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(text, x + 4, y + 7);
  }

  function imageIcon(ctx, cx, cy, alpha) {
    const w = 18;
    const h = 14;
    const x = Math.round(cx - w / 2) + 0.5;
    const y = Math.round(cy - h / 2) + 0.5;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "rgba(235,240,248,0.75)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 2);
    else ctx.rect(x, y, w, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 2, y + h - 2);
    ctx.lineTo(x + 7, y + 6);
    ctx.lineTo(x + 10, y + 9);
    ctx.lineTo(x + 12, y + 7.5);
    ctx.lineTo(x + w - 2, y + h - 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + w - 5, y + 4.5, 1.6, 0, Math.PI * 2);
    ctx.stroke();
  }

  const dims = (w, h) => `${Math.round(w)} × ${Math.round(h)}`;

  /* ───────────── item factories ───────────── */

  function add(item) {
    item.released = -1;
    item.release = (t, fade) => {
      if (item.released < 0) {
        item.released = t;
        if (fade != null) item.fade = fade;
      }
    };
    items.push(item);
    return item;
  }

  /**
   * Wireframe around a layer.
   * opts: t (build time now), draw (s, perimeter draw-in), handles, pill, copies (0-4),
   *       guides, placeholder, nested (0-4 inner boxes while the placeholder shows),
   *       crosshair, color ('blue'|'red'), fade (s)
   * Handle: release(t[, fade]), hidePlaceholder(t), drawDur, progress(t)
   */
  function wire(layer, opts = {}) {
    const r = layer.rect;
    const copies = [];
    for (let i = 1; i <= (opts.copies | 0); i++) {
      const sx = Math.random() < 0.75 ? 1 : -1;
      copies.push({
        dx: sx * rand(6, 16) * i,
        dy: rand(5, 14) * i,
        dw: rand(-0.04, 0.09) * r.w + rand(4, 14) * i,
        dh: rand(-0.05, 0.1) * r.h + rand(3, 10) * i,
      });
    }
    // nested measuring boxes inside a media placeholder (fractions of the layer rect)
    const nested = [];
    for (let i = 0; i < (opts.nested | 0); i++) {
      const fw = rand(0.26, 0.6);
      const fh = rand(0.14, 0.4);
      nested.push({ fx: rand(0.05, 0.95 - fw), fy: rand(0.06, 0.94 - fh), fw, fh, delay: 0.05 + i * 0.09 });
    }
    const item = add({
      type: "wire",
      layer,
      t0: opts.t ?? 0,
      draw: opts.draw ?? 0.32,
      conv: opts.conv ?? 0.45,
      handles: opts.handles ?? true,
      pill: opts.pill ?? true,
      copies,
      nested,
      guides: !!opts.guides,
      placeholder: !!opts.placeholder,
      placeholderOff: -1,
      crosshair: opts.crosshair ?? true,
      color: opts.color || "blue",
      fade: opts.fade ?? 0.35,
    });
    item.progress = (t) => clamp01((t - item.t0) / item.draw);
    item.hidePlaceholder = (t) => {
      if (item.placeholderOff < 0) item.placeholderOff = t;
    };
    return item;
  }

  /** Red QA flag: doubled offset boxes, optional red "diff" copy of the text. approve(t) turns it blue. */
  function qa(layer, opts = {}) {
    const off = rand(3, 6);
    const item = add({
      type: "qa",
      layer,
      t0: opts.t ?? 0,
      off: { x: off * (Math.random() < 0.5 ? 1 : -1), y: off },
      diff: opts.diff ? prepareDiff(layer) : null,
      approved: -1,
      fade: 0.3,
    });
    item.approve = (t) => {
      if (item.approved < 0) item.approved = t;
    };
    return item;
  }

  /** Truncates a layer's first line of text so the red diff copy fits its box. */
  function prepareDiff(layer) {
    const text = (layer.text || "").replace(/\s+/g, " ").trim();
    if (!text || !layer.font) return null;
    const line = layer.lines?.[0] || layer.rect;
    const probe = document.createElement("canvas").getContext("2d");
    probe.font = layer.font;
    let s = text;
    while (s.length > 1 && probe.measureText(s).width > line.w) s = s.slice(0, Math.max(1, Math.floor(s.length * 0.9)));
    return { text: s, dx: line.x - layer.rect.x, dy: line.y - layer.rect.y, h: line.h };
  }

  /**
   * Glowing horizontal line drawn left→right (section rules, <hr> layers).
   * opts: y, x0, x1 (doc coords unless fixed), t, dur, hold (auto-release after s), fixed
   */
  function hline(opts) {
    return add({
      type: "hline",
      y: opts.y,
      x0: opts.x0,
      x1: opts.x1,
      fixed: !!opts.fixed,
      t0: opts.t ?? 0,
      draw: opts.dur ?? 0.5,
      hold: opts.hold ?? null,
      caps: opts.caps ?? true,
      fade: opts.fade ?? 0.6,
    });
  }

  /**
   * Section scaffold: a faint 1px outline of every given layer, drawn in top to bottom and
   * kept until released (the director releases it when the section is finished). Dimension
   * pills on the big boxes. Cheap: plain strokes, no glow, offscreen rects skipped.
   * opts: t, stagger (s between consecutive rects), alpha
   */
  function scaffold(layers, opts = {}) {
    const list = layers.slice().sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    const y0 = list.length ? list[0].rect.y : 0;
    // draw-in sweeps down the section (≈ 2600 px/s) with a little per-rect jitter
    const delays = list.map((L, i) => Math.min(1.2, (L.rect.y - y0) / 2600) + (i % 5) * (opts.stagger ?? 0.015));
    return add({ type: "scaffold", layers: list, delays, t0: opts.t ?? 0, alpha: opts.alpha ?? 0.32, fade: opts.fade ?? 0.6 });
  }

  /** Quick blue fill flash on a layer (paste, chip pop). Releases itself. */
  function flash(layer, opts = {}) {
    return add({ type: "flash", layer, t0: opts.t ?? 0, life: opts.life ?? 0.35, color: opts.color || COLORS.blue });
  }

  /* ───────────── aids ───────────── */

  function buildRulerSprite() {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(vw * dpr));
    c.height = Math.round(RULER_H * dpr);
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    // near-opaque backing: page text scrolling underneath must not show through the ticks
    g.fillStyle = "rgba(13,14,17,0.97)";
    g.fillRect(0, 0, vw, RULER_H);
    g.fillStyle = "rgba(255,255,255,0.12)";
    g.fillRect(0, RULER_H - 1, vw, 1);
    g.fillStyle = "rgba(255,255,255,0.28)";
    for (let x = 0; x <= vw; x += 10) {
      const h = x % 100 === 0 ? 8 : x % 50 === 0 ? 5 : 3;
      g.fillRect(x, RULER_H - 1 - h, 1, h);
    }
    g.font = `500 8px ${MONO}`;
    g.textBaseline = "top";
    g.fillStyle = "rgba(255,255,255,0.42)";
    for (let x = 100; x < vw; x += 100) g.fillText(String(x), x + 3, 2);
    ruler.sprite = c;
  }

  function drawRuler(ctx, dt) {
    ruler.alpha += (ruler.target - ruler.alpha) * Math.min(1, dt * 6);
    if (ruler.alpha < 0.01) return;
    if (!ruler.sprite) buildRulerSprite();
    const y = Math.round(ruler.top);
    ctx.globalAlpha = ruler.alpha;
    ctx.drawImage(ruler.sprite, 0, y, vw, RULER_H);
    if (ruler.has) {
      const k = Math.min(1, dt * 10);
      ruler.f0 += (ruler.t0 - ruler.f0) * k;
      ruler.f1 += (ruler.t1 - ruler.f1) * k;
      const x0 = Math.round(ruler.f0);
      const x1 = Math.round(ruler.f1);
      ctx.fillStyle = "rgba(61,123,255,0.22)";
      ctx.fillRect(x0, y, x1 - x0, RULER_H - 1);
      ctx.fillStyle = COLORS.blue;
      ctx.fillRect(x0, y + RULER_H - 4, x1 - x0, 3);
      ctx.fillRect(x0, y, 1, RULER_H);
      ctx.fillRect(x1, y, 1, RULER_H);
      if (x1 - x0 > 40) {
        ctx.font = `600 8px ${MONO}`;
        ctx.textBaseline = "top";
        ctx.fillStyle = COLORS.white;
        ctx.fillText(String(x1 - x0), x0 + 4, y + 3);
      }
    }
  }

  function drawAids(ctx, dt) {
    const top = ruler.top + RULER_H;
    for (const a of aids) {
      a.alpha += (a.target - a.alpha) * Math.min(1, dt * 5);
      if (a.alpha < 0.01) continue;
      // layout columns: dotted blue
      if (a.cols > 0) {
        ctx.globalAlpha = a.alpha * 0.32;
        ctx.strokeStyle = COLORS.blue2;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        const colW = a.w / a.cols;
        for (let i = 1; i < a.cols; i++) {
          const x = snap(a.x + colW * i);
          ctx.moveTo(x, top);
          ctx.lineTo(x, vh);
        }
        const xr = snap(a.x + a.w);
        ctx.moveTo(xr, top);
        ctx.lineTo(xr, vh);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // margin guide: red, solid, slight glow
      const xm = snap(a.x);
      glowStroke(
        ctx,
        () => {
          ctx.beginPath();
          ctx.moveTo(xm, top);
          ctx.lineTo(xm, vh);
        },
        COLORS.red,
        COLORS.redGlow,
        a.alpha * 0.9
      );
    }
    aids = aids.filter((a) => a.target > 0 || a.alpha >= 0.01);
  }

  /* ───────────── drawing items ───────────── */

  function fadeOf(item, t) {
    if (item.released < 0) return 1;
    return 1 - clamp01((t - item.released) / (item.fade || 0.0001));
  }

  function drawWire(ctx, it, t, scrollY, alpha) {
    const r = viewRect(it.layer, scrollY);
    if (offscreen(r, 140)) return;
    const red = it.color === "red";
    const line = red ? COLORS.red : COLORS.blueLine;
    const glow = red ? COLORS.redGlow : COLORS.blueGlow;
    const p = easeInOut((t - it.t0) / it.draw);
    const after = t - it.t0 - it.draw; // time since the outline closed

    // converging offset copies (measure / settle effect)
    if (it.copies.length) {
      const f = 1 - easeOut((t - it.t0 - it.draw * 0.55) / it.conv);
      if (f > 0.01) {
        for (const c of it.copies) {
          const cr = { x: r.x + c.dx * f, y: r.y + c.dy * f, w: r.w + c.dw * f, h: r.h + c.dh * f };
          const a = alpha * 0.6 * Math.min(1, f * 1.6) * Math.min(1, p * 2);
          glowStroke(ctx, () => perimeterPath(ctx, cr, 1), line, glow, a);
          handle(ctx, cr.x, cr.y + cr.h, line, a, 4);
          handle(ctx, cr.x + cr.w, cr.y, line, a, 4);
          cross(ctx, cr.x + cr.w, cr.y + cr.h, COLORS.blue2, a, 4);
          if (it.pill) pill(ctx, dims(it.layer.rect.w + c.dw * f, it.layer.rect.h + c.dh * f), cr.x + cr.w / 2, cr.y + cr.h + 5, line, a * 0.9);
        }
      }
    }

    // grey placeholder fill + image icon
    if (it.placeholder && p > 0.25) {
      const off = it.placeholderOff < 0 ? 1 : 1 - clamp01((t - it.placeholderOff) / 0.22);
      const a = alpha * off * clamp01((p - 0.25) / 0.5);
      if (a > 0.01) {
        ctx.globalAlpha = a;
        ctx.fillStyle = COLORS.placeholder;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        imageIcon(ctx, r.x + r.w / 2, r.y + r.h / 2, a);
        // nested measuring boxes, drawn in one after another once the outline has closed
        for (const n of it.nested) {
          const k = easeInOut((after - n.delay) / 0.2);
          if (k <= 0) continue;
          const nr = { x: r.x + r.w * n.fx, y: r.y + r.h * n.fy, w: r.w * n.fw, h: r.h * n.fh };
          const na = a * 0.85;
          glowStroke(ctx, () => perimeterPath(ctx, nr, k), line, glow, na);
          if (k >= 1) {
            handle(ctx, nr.x, nr.y, line, na, 4);
            handle(ctx, nr.x + nr.w, nr.y + nr.h, line, na, 4);
            pill(ctx, dims(it.layer.rect.w * n.fw, it.layer.rect.h * n.fh), nr.x + Math.min(nr.w / 2, 60), nr.y + nr.h + 4, line, na * 0.95);
          }
        }
      }
    }

    // guides: from the top-left corner to the left edge and up to the ruler
    if (it.guides && p > 0.2) {
      const g = alpha * 0.4 * (1 - clamp01((after - 0.5) / 0.6));
      if (g > 0.01) {
        ctx.globalAlpha = g;
        ctx.strokeStyle = COLORS.blue2;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        const x = snap(r.x);
        const yTop = snap(r.y);
        const yBot = snap(r.y + r.h);
        const reach = easeOut((t - it.t0) / (it.draw * 1.4));
        ctx.moveTo(x, yTop);
        ctx.lineTo(x - x * reach, yTop);
        ctx.moveTo(x, yBot);
        ctx.lineTo(x - x * reach, yBot);
        const up = ruler.top + RULER_H;
        ctx.moveTo(x, yTop);
        ctx.lineTo(x, yTop - (yTop - up) * reach);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // the outline itself
    glowStroke(ctx, () => perimeterPath(ctx, r, p), line, glow, alpha);

    if (p >= 1) {
      const pop = easeOut(after / 0.12);
      if (it.handles) {
        const s = 3 + 2 * pop;
        handle(ctx, r.x, r.y, line, alpha, s);
        handle(ctx, r.x + r.w, r.y, line, alpha, s);
        handle(ctx, r.x, r.y + r.h, line, alpha, s);
        handle(ctx, r.x + r.w, r.y + r.h, line, alpha, s);
      }
      if (it.crosshair) cross(ctx, r.x + r.w + 6, r.y + r.h + 6, COLORS.blue2, alpha * pop * 0.9, 4);
      if (it.pill && after > 0.06) pill(ctx, dims(it.layer.rect.w, it.layer.rect.h), r.x + Math.min(r.w / 2, 120), r.y + r.h + 5, line, alpha * easeOut((after - 0.06) / 0.12));
    }
  }

  function drawQa(ctx, it, t, scrollY, alpha) {
    const r = viewRect(it.layer, scrollY);
    if (offscreen(r)) return;
    const f = it.approved < 0 ? 0 : clamp01((t - it.approved) / 0.18); // 0 red → 1 blue
    const color = mix(COLORS.red, COLORS.blue, f);
    const glow = f < 0.5 ? COLORS.redGlow : COLORS.blueGlow;
    const appear = easeOut((t - it.t0) / 0.14);
    const pad = 3;
    const outer = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
    const ghost = { x: outer.x + it.off.x * (1 - f), y: outer.y + it.off.y * (1 - f), w: outer.w, h: outer.h };
    glowStroke(ctx, () => perimeterPath(ctx, ghost, 1), color, glow, alpha * appear * 0.55 * (1 - f));
    glowStroke(ctx, () => perimeterPath(ctx, outer, appear), color, glow, alpha);
    if (it.diff && f < 1) {
      ctx.globalAlpha = alpha * appear * 0.7 * (1 - f);
      ctx.font = it.layer.font;
      ctx.fillStyle = COLORS.red;
      ctx.textBaseline = "middle";
      ctx.fillText(it.diff.text, r.x + it.diff.dx + it.off.x, r.y + it.diff.dy + it.diff.h / 2 + it.off.y + 1);
    }
    pill(ctx, f > 0.5 ? "✓ ok" : "qa", outer.x + 12, outer.y - 16, f > 0.5 ? COLORS.blue : COLORS.red, alpha * appear);
  }

  function drawHline(ctx, it, t, scrollY, alpha) {
    const y = snap(it.fixed ? it.y : it.y - scrollY);
    if (y < -20 || y > vh + 20) return;
    const p = easeOut((t - it.t0) / it.draw);
    const x0 = it.x0;
    const x1 = it.x0 + (it.x1 - it.x0) * p;
    glowStroke(
      ctx,
      () => {
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      },
      COLORS.blueLine,
      COLORS.blueGlow,
      alpha,
      1
    );
    if (p < 1) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "rgba(170,200,255,0.9)";
      ctx.fillRect(x1 - 6, y - 1, 6, 2);
    }
    if (it.caps) {
      handle(ctx, x0, y, COLORS.blueLine, alpha, 5);
      if (p >= 1) handle(ctx, it.x1, y, COLORS.blueLine, alpha, 5);
    }
  }

  function drawScaffold(ctx, it, t, scrollY, alpha) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.blue2;
    const big = [];
    for (let i = 0; i < it.layers.length; i++) {
      const L = it.layers[i];
      const r = viewRect(L, scrollY);
      if (r.w < 2 || r.h < 2 || offscreen(r, 10)) continue;
      const k = (t - it.t0 - it.delays[i]) / 0.28;
      if (k <= 0) continue;
      ctx.globalAlpha = alpha * it.alpha * Math.min(1, k * 1.5);
      if (k < 1) {
        perimeterPath(ctx, r, easeOut(k));
        ctx.stroke();
      } else {
        ctx.strokeRect(snap(r.x), snap(r.y), Math.round(r.w), Math.round(r.h));
        if ((L.kind === "box" || L.kind === "media") && L.rect.w * L.rect.h > 40000) big.push(r, L);
      }
    }
    for (let i = 0; i < big.length; i += 2) {
      const r = big[i];
      pill(ctx, dims(big[i + 1].rect.w, big[i + 1].rect.h), r.x + 34, r.y + r.h - 17, COLORS.blue, alpha * 0.55);
    }
  }

  function drawFlash(ctx, it, t, scrollY) {
    const r = viewRect(it.layer, scrollY);
    const k = (t - it.t0) / it.life;
    if (k >= 1) {
      it.release(t, 0.0001); // gone on the next frame
      return;
    }
    if (offscreen(r)) return;
    const a = 1 - easeOut(k);
    ctx.globalAlpha = a * 0.22;
    ctx.fillStyle = it.color;
    ctx.fillRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
    ctx.globalAlpha = a;
    ctx.strokeStyle = it.color;
    ctx.lineWidth = 1;
    ctx.strokeRect(snap(r.x - 2), snap(r.y - 2), Math.round(r.w + 4), Math.round(r.h + 4));
  }

  function drawGlitch(ctx, t) {
    if (t > glitchUntil) return;
    const bands = 9;
    for (let i = 0; i < bands; i++) {
      const y = Math.random() * vh;
      const h = 2 + Math.random() * 26;
      const x = (Math.random() - 0.5) * 60;
      ctx.globalAlpha = 0.16 + Math.random() * 0.18;
      ctx.fillStyle = i % 3 === 0 ? "#ff3b3b" : i % 3 === 1 ? "#3d7bff" : "#ffffff";
      ctx.fillRect(x, y, vw, h * (i % 3 === 2 ? 0.15 : 1));
    }
  }

  function drawItem(ctx, it, t, scrollY, alpha) {
    if (it.type === "wire") drawWire(ctx, it, t, scrollY, alpha);
    else if (it.type === "scaffold") drawScaffold(ctx, it, t, scrollY, alpha);
    else if (it.type === "qa") drawQa(ctx, it, t, scrollY, alpha);
    else if (it.type === "hline") drawHline(ctx, it, t, scrollY, alpha);
    else if (it.type === "flash") drawFlash(ctx, it, t, scrollY);
  }

  /* ───────────── public ───────────── */

  let lastT = 0;

  return {
    wire,
    qa,
    hline,
    flash,
    scaffold,

    resize(width, height, ratio) {
      vw = width;
      vh = height;
      dpr = ratio;
      half = Math.round(dpr) % 2 === 1 ? 0.5 / dpr : 0;
      ruler.sprite = null;
    },

    /** Ruler strip: visible flag (null = unchanged) and its top (viewport y, usually the nav's bottom edge). */
    setRuler(visible, top) {
      if (visible != null) ruler.target = visible ? 1 : 0;
      if (top != null) ruler.top = top;
    },
    /** Blue highlight on the ruler for the x-extent currently being worked on. */
    setRulerFocus(x0, x1) {
      if (!ruler.has) {
        ruler.f0 = x0;
        ruler.f1 = x1;
        ruler.has = true;
      }
      ruler.t0 = x0;
      ruler.t1 = x1;
    },
    get rulerBottom() {
      return ruler.top + RULER_H;
    },

    /** Margin + column guides for a section's container ({ x, w, cols } in viewport x), or null. */
    setAids(spec) {
      for (const a of aids) if (!spec || a.key !== spec.key) a.target = 0;
      if (!spec) return;
      const cur = aids.find((a) => a.key === spec.key);
      if (cur) Object.assign(cur, spec, { target: 1 });
      else aids.push({ ...spec, alpha: 0, target: 1 });
    },

    /** RGB slice glitch over the whole viewport until build time t + dur. */
    glitch(t, dur = 0.15) {
      glitchUntil = t + dur;
    },

    /** Starts fading every live item (end of build / skip). */
    releaseAll(t, fade = 0.35) {
      for (const it of items) it.release(t, fade);
      ruler.target = 0;
      for (const a of aids) a.target = 0;
    },

    clear() {
      items = [];
      aids = [];
      ruler.alpha = ruler.target = 0;
      ruler.has = false;
      glitchUntil = -1;
    },

    /** True while anything is (or is still fading) on screen. */
    get busy() {
      return items.length > 0 || ruler.alpha > 0.01 || ruler.target > 0 || aids.length > 0;
    },

    draw(ctx, t, scrollY) {
      const dt = Math.max(0, Math.min(0.1, t - lastT));
      lastT = t;
      drawAids(ctx, dt);
      const keep = [];
      const page = []; // [item, alpha] pairs for page (non-fixed) layers
      // Pass 1: graphics on fixed layers (the nav) draw anywhere.
      for (const it of items) {
        if (it.type === "hline" && it.hold != null && it.released < 0 && t - it.t0 > it.draw + it.hold) it.release(t);
        const alpha = fadeOf(it, t);
        if (alpha <= 0) continue;
        keep.push(it);
        if (it.layer ? it.layer.fixed : it.fixed) drawItem(ctx, it, t, scrollY, alpha);
        else page.push(it, alpha);
      }
      items = keep;
      // Pass 2: page graphics are clipped to the content area, so a layer that scrolled under
      // the fixed nav (and the ruler strip below it) never draws its boxes on top of them.
      if (page.length) {
        const top = Math.round(ruler.top + (ruler.target > 0 || ruler.alpha > 0.5 ? RULER_H : 0));
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, top, vw, Math.max(0, vh - top));
        ctx.clip();
        for (let i = 0; i < page.length; i += 2) drawItem(ctx, page[i], t, scrollY, page[i + 1]);
        ctx.restore();
      }
      drawRuler(ctx, dt);
      drawGlitch(ctx, t);
      ctx.globalAlpha = 1;
    },
  };
}
