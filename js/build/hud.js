/* ═══════════════════════════════════════════════════════════════════════════
   hud.js: the build HUD pill (SPEC §5), plain DOM

   Fixed bottom-centre glass pill with three states (data-state on the root):
     boot   "Scanning page…" + scanning line + [Tour] [1x] [sound] [×]
     build  ●●●●● 19 agents | 37 / 214 layers + progress + [Tour] [1x] [sound] [×]
     done   "Rebuilt by 44 agents in 19.2s" + full line + [Go live] [Replay] [×]
   CSS (css/build.css) decides which parts are visible per state and compacts the
   pill on narrow screens. Buttons are real <button>s with aria-labels; a separate
   visually-hidden role=status node announces progress politely (throttled).

   The HUD only renders and reports clicks; the director owns all behaviour.
   ═══════════════════════════════════════════════════════════════════════════ */

const ICON_SOUND_ON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>';
const ICON_SOUND_OFF =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>';

/**
 * True when style.css provides the shared glass material (the `--glass-fill` token on :root).
 * Until it does, `no-glass` tells css/build.css to paint a plain fallback surface instead.
 */
export function hasGlass() {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue("--glass-fill").trim() !== "";
  } catch {
    return true;
  }
}

/**
 * @param {object} o
 * @param {string[]} o.palette  agent colours for the avatar dots
 * @param {(action: string) => void} o.onAction  'tour' | 'speed' | 'sound' | 'skip' | 'golive' | 'replay' | 'close'
 */
export function createHud({ palette = [], onAction = () => {} } = {}) {
  const el = document.createElement("div");
  // The material (fill, edge, blur, shadow) comes from style.css' shared .glass utility.
  el.className = hasGlass() ? "build-hud glass" : "build-hud glass no-glass";
  el.dataset.state = "boot";
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", "Live page build");
  const dots = palette
    .slice(0, 5)
    .map((c) => `<i style="background:${c}"></i>`)
    .join("");
  el.innerHTML = `
    <div class="bh-info">
      <span class="bh-scan">Scanning page<span class="bh-ell">…</span></span>
      <span class="bh-live">
        <span class="bh-dots" aria-hidden="true">${dots}</span>
        <span class="bh-agents"><b data-ref="agents">0</b><span class="bh-word"> agents</span></span>
        <span class="bh-sep" aria-hidden="true"></span>
        <span class="bh-layers"><b data-ref="built">0</b><span class="bh-of"> / </span><span data-ref="total">0</span><span class="bh-word"> layers</span></span>
      </span>
      <span class="bh-done" data-ref="done"></span>
    </div>
    <span class="bh-track" aria-hidden="true"><i data-ref="fill"></i></span>
    <div class="bh-actions">
      <button type="button" class="bh-btn bh-tour" data-act="tour" aria-pressed="true" aria-label="Tour: follow the build (T)">Tour</button>
      <button type="button" class="bh-btn bh-speed" data-act="speed" aria-label="Build speed 1x">1x</button>
      <button type="button" class="bh-btn bh-icon bh-sound" data-act="sound" aria-pressed="true" aria-label="Sound (M)">${ICON_SOUND_ON}<span class="bh-hint" aria-hidden="true">sound</span></button>
      <button type="button" class="bh-btn bh-primary bh-golive" data-act="golive">Go live</button>
      <button type="button" class="bh-btn bh-replay" data-act="replay" aria-label="Replay the build (R)">Replay</button>
      <button type="button" class="bh-btn bh-icon bh-close" data-act="close" aria-label="Skip the build (Esc)">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>
    <span class="build-sr" role="status" aria-live="polite" data-ref="status"></span>`;

  const ref = {};
  for (const n of el.querySelectorAll("[data-ref]")) ref[n.dataset.ref] = n;
  const btn = (act) => el.querySelector(`[data-act="${act}"]`);
  const closeBtn = btn("close");
  const soundBtn = btn("sound");

  el.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-act]") : null;
    if (!b) return;
    let act = b.dataset.act;
    if (act === "close" && el.dataset.state !== "done") act = "skip";
    onAction(act);
  });

  document.body.appendChild(el);

  const last = { agents: -1, built: -1, total: -1, fill: -1 };
  let lastAnnounce = 0;

  function setText(node, value, key) {
    if (last[key] === value) return;
    last[key] = value;
    node.textContent = String(value);
  }

  function announce(text, force = false) {
    const now = performance.now();
    if (!force && now - lastAnnounce < 3000) return;
    lastAnnounce = now;
    ref.status.textContent = text;
  }

  return {
    el,

    setState(state) {
      el.dataset.state = state;
      closeBtn.setAttribute("aria-label", state === "done" ? "Close" : "Skip the build (Esc)");
      this.show();
      if (state === "boot") announce("Building the page", true);
    },

    setCounts({ agents, built, total }) {
      setText(ref.agents, agents, "agents");
      setText(ref.built, built, "built");
      setText(ref.total, total, "total");
      const p = total ? built / total : 0;
      const q = Math.round(p * 200) / 200;
      if (q !== last.fill) {
        last.fill = q;
        ref.fill.style.transform = `scaleX(${q})`;
      }
      if (el.dataset.state === "build") announce(`Building: ${built} of ${total} layers`);
    },

    /**
     * Summary. A finished build reads "Rebuilt by 44 agents in 19.2s"; a skipped one says how
     * far the agents got ("Skipped at 36 / 226 · 5.8s"). .bh-word parts drop on narrow screens.
     */
    setDone({ agents, seconds, skipped = false, built = 0, total = 0 }) {
      const s = `${seconds.toFixed(1)}s`;
      ref.done.innerHTML = skipped
        ? `Skipped<span class="bh-word"> at</span> <b>${built} / ${total}</b><span class="bh-word"> layers</span> · <b>${s}</b>`
        : `<span class="bh-word">Rebuilt by </span><b>${agents}</b> agents<span class="bh-word"> in</span><span class="bh-mid" aria-hidden="true"> ·</span> <b>${s}</b>`;
      ref.fill.style.transform = "scaleX(1)";
      last.fill = 1;
      this.setState("done");
      announce(skipped ? `Build skipped at ${built} of ${total} layers` : `Rebuilt by ${agents} agents in ${seconds.toFixed(1)} seconds`, true);
    },

    setTour(on) {
      btn("tour").setAttribute("aria-pressed", String(!!on));
    },

    setSpeed(n) {
      const b = btn("speed");
      b.textContent = `${n}x`;
      b.setAttribute("aria-label", `Build speed ${n}x`);
    },

    /** blocked: the browser is known to refuse audio until a gesture (sfx.blocked); falls back to !unlocked. */
    setSound({ enabled, unlocked, blocked }) {
      const on = !!enabled;
      if (soundBtn.dataset.on !== String(on)) {
        soundBtn.dataset.on = String(on);
        // a static name; the state is carried by aria-pressed alone (no "Sound off, not pressed")
        soundBtn.setAttribute("aria-pressed", String(on));
        soundBtn.firstElementChild.outerHTML = on ? ICON_SOUND_ON : ICON_SOUND_OFF;
      }
      // Pulse a small hint only while the browser actually blocks audio (it plays without any
      // gesture where allowed). It floats above the button (css/build.css), so removing it never
      // changes the pill's width: a first click whose pointerdown unlocks audio still lands on
      // the button it was aimed at.
      const refused = blocked === undefined ? !unlocked : !!blocked;
      soundBtn.classList.toggle("is-hint", on && refused);
    },

    show() {
      el.classList.remove("is-hidden");
      el.inert = false;
    },
    /** Slides the pill away; inert takes its buttons out of the tab order and the a11y tree. */
    hide() {
      el.classList.add("is-hidden");
      el.inert = true;
    },
    get hidden() {
      return el.classList.contains("is-hidden");
    },

    destroy() {
      el.remove();
    },
  };
}
