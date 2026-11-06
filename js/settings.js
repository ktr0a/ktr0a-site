/* ═══════════════════════════════════════════════════════════════════════════
   settings.js: the small "Build settings" popover (gear in the nav)

   What a returning visitor's automatic build looks like: either the full
   animation every visit (start screen, 1x, tour), or a quicker build with its
   own playback speed (1x / 2x / 4x) and autoscroll (the build's tour) on or
   off. The first visit and the Rebuild button always play the full build at
   1x; main.js owns those rules, the storage keys and the live apply. This
   module only renders the controls and reports changes.

   Markup it injects (both removable, nothing else in the page is touched):
     .nav-actions › button#build-settings-btn.icon-btn[data-layer=chip]
       (same pattern as #sound-toggle, so style.css' .icon-btn covers it; the
       build engine builds it like the other nav chips)
     body › div#build-settings.build-settings.glass[role=dialog][hidden]
       (fixed, z-index above the build canvas and HUD; css/build.css)

   Keyboard: the gear opens it and focus moves to the first switch; Tab walks
   gear → full build → speed (roving tabindex, arrows / Home / End select) →
   autoscroll → the next nav control, as if the panel sat right after the gear
   (speed and autoscroll are skipped while "full build" is on); Esc,
   an outside press or focus leaving close it. Esc is consumed while it is
   open, so it never also skips the build.
   ═══════════════════════════════════════════════════════════════════════════ */

const SPEEDS = [1, 2, 4];

// 16px stroke gear, drawn like the nav's other icon glyphs (24-unit box, stroke 2)
const GEAR_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>' +
  '<circle cx="12" cy="12" r="3"/></svg>';

const EDGE = 16; // px kept free between the panel and the viewport edge (the 360 px gutter)
const GAP = 8; // px between the gear and the panel

/** Same probe as the HUD: until style.css ships the glass tokens, css/build.css paints a fallback. */
function hasGlass() {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue("--glass-fill").trim() !== "";
  } catch {
    return true;
  }
}

/**
 * @param {object} o
 * @param {{ speed: 1|2|4, tour: boolean, always: boolean }} o.initial  the stored return-visit settings
 * @param {(value: { speed: number, tour: boolean, always: boolean, changed: "speed"|"tour"|"always" }) => void} o.onChange
 * @param {(name: string, opts?: object) => void} o.play  UI sound (fire-and-forget)
 * @returns {{ button: HTMLButtonElement, panel: HTMLElement, open(): void, close(): void, readonly isOpen: boolean, destroy(): void } | null}
 */
export function mountBuildSettings({ initial = {}, onChange = () => {}, play = () => {} } = {}) {
  const actions = document.querySelector("#nav .nav-actions") || document.querySelector(".nav-actions");
  if (!actions || document.getElementById("build-settings-btn")) return null;

  const value = {
    speed: SPEEDS.includes(Number(initial.speed)) ? Number(initial.speed) : 2,
    tour: initial.tour === true,
    always: initial.always === true, // the full animation (start screen, 1x, tour) on every visit
  };

  /* ── gear ── */
  const button = document.createElement("button");
  button.className = "icon-btn";
  button.id = "build-settings-btn";
  button.type = "button";
  button.setAttribute("aria-label", "Build settings");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "build-settings");
  button.title = "Build settings";
  button.dataset.layer = "chip";
  button.innerHTML = GEAR_SVG;
  const anim = document.getElementById("anim-toggle");
  const rebuild = document.getElementById("rebuild-btn");
  if (anim && anim.parentElement === actions) anim.after(button);
  else if (rebuild && rebuild.parentElement === actions) rebuild.before(button);
  else actions.append(button);

  /* ── panel ── */
  const panel = document.createElement("div");
  panel.id = "build-settings";
  panel.className = hasGlass() ? "build-settings glass" : "build-settings glass no-glass";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Build settings");
  panel.setAttribute("aria-describedby", "bs-note");
  panel.tabIndex = -1; // a press on its text keeps focus inside (no "focus left" close)
  panel.hidden = true;
  panel.innerHTML = `
    <p class="bs-title">On return visits</p>
    <div class="bs-row">
      <span class="bs-label" id="bs-always-label">Full build every visit</span>
      <button type="button" class="bs-switch" data-key="always" role="switch" aria-checked="false" aria-labelledby="bs-always-label"><span class="bs-knob" aria-hidden="true"></span></button>
    </div>
    <div class="bs-group">
      <div class="bs-row">
        <span class="bs-label" id="bs-speed-label">Speed</span>
        <div class="bs-seg" role="radiogroup" aria-labelledby="bs-speed-label">${SPEEDS.map(
          (n) => `<button type="button" class="bs-opt" role="radio" data-speed="${n}" aria-checked="false" tabindex="-1">${n}x</button>`
        ).join("")}</div>
      </div>
      <div class="bs-row">
        <span class="bs-label" id="bs-tour-label">Autoscroll</span>
        <button type="button" class="bs-switch" data-key="tour" role="switch" aria-checked="false" aria-labelledby="bs-tour-label"><span class="bs-knob" aria-hidden="true"></span></button>
      </div>
    </div>
    <p class="bs-note" id="bs-note">Your first visit and the Rebuild button always play the full build at 1x.</p>`;
  document.body.appendChild(panel);

  const radios = [...panel.querySelectorAll(".bs-opt")];
  const toggle = panel.querySelector('.bs-switch[data-key="tour"]');
  const always = panel.querySelector('.bs-switch[data-key="always"]');
  const group = panel.querySelector(".bs-group");
  const checkedRadio = () => radios.find((r) => Number(r.dataset.speed) === value.speed) || radios[0];
  /** The last control in tab order: autoscroll, or "full build" while the quicker build's rows are off. */
  const lastControl = () => (value.always ? always : toggle);

  function render() {
    for (const r of radios) {
      const on = Number(r.dataset.speed) === value.speed;
      r.setAttribute("aria-checked", String(on));
      r.tabIndex = on ? 0 : -1;
      r.disabled = value.always;
    }
    toggle.setAttribute("aria-checked", String(value.tour));
    toggle.disabled = value.always;
    always.setAttribute("aria-checked", String(value.always));
    // "Full build every visit" makes speed / autoscroll irrelevant: shown, but dimmed and inert
    group.classList.toggle("is-off", value.always);
    group.setAttribute("aria-disabled", String(value.always));
  }
  render();

  function emit(changed) {
    try {
      onChange({ speed: value.speed, tour: value.tour, always: value.always, changed });
    } catch (err) {
      console.warn("[settings] onChange failed:", err);
    }
  }

  function chooseSpeed(n, { focus = false } = {}) {
    const changed = n !== value.speed;
    value.speed = n;
    render();
    if (focus) checkedRadio().focus({ preventScroll: true });
    if (!changed) return;
    play("speed", { pitch: Math.log2(n) * 4 });
    emit("speed");
  }

  function flipTour() {
    if (value.always) return;
    value.tour = !value.tour;
    render();
    play(value.tour ? "toggleOn" : "toggleOff");
    emit("tour");
  }

  function flipAlways() {
    value.always = !value.always;
    render();
    play(value.always ? "toggleOn" : "toggleOff");
    emit("always");
  }

  /* ── open / close ── */

  let isOpen = false;
  let pressingButton = false; // a press on the gear is in progress (Safari does not focus buttons on click)

  /**
   * Under the gear: right edges aligned when the panel fits to the gear's left (gear at the right
   * of the nav), else left edges aligned; always clamped to the viewport (fits 360 px).
   * Vertically below the whole nav bar, so on phones (two-row nav) it never covers the links row.
   */
  function position() {
    const r = button.getBoundingClientRect();
    const bar = button.closest(".nav-bar")?.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const w = panel.offsetWidth;
    let left = r.right - w;
    if (left < EDGE) left = r.left;
    left = Math.max(EDGE, Math.min(left, vw - EDGE - w));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(Math.max(r.bottom, bar ? bar.bottom : 0) + GAP)}px`;
  }

  /** viaKeyboard: the focus ring shows on the first control only for keyboard users. */
  function open({ viaKeyboard = true } = {}) {
    if (isOpen) return;
    isOpen = true;
    panel.hidden = false;
    position();
    button.setAttribute("aria-expanded", "true");
    always.focus({ preventScroll: true, focusVisible: viaKeyboard });
  }

  /** focusGear: Esc / gear / Tab-back closes give focus to the gear; outside presses and focus leaving do not. */
  function close({ focusGear = false } = {}) {
    if (!isOpen) return;
    isOpen = false;
    const hadFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focusGear && (hadFocus || document.activeElement === button || document.activeElement === document.body)) {
      button.focus({ preventScroll: true });
    }
  }

  /* ── events ── */

  const offs = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    offs.push(() => target.removeEventListener(type, fn, opts));
  };

  on(button, "pointerdown", () => (pressingButton = true));
  on(button, "click", (e) => {
    pressingButton = false;
    if (isOpen) close({ focusGear: true });
    else open({ viaKeyboard: e.detail === 0 }); // detail 0: Enter / Space, not a pointer
  });
  on(window, "pointerup", () => setTimeout(() => (pressingButton = false), 0), { passive: true });

  on(panel, "click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const radio = t?.closest(".bs-opt");
    const sw = t?.closest(".bs-switch");
    if (radio) {
      if (!value.always) chooseSpeed(Number(radio.dataset.speed), { focus: true });
    } else if (sw?.dataset.key === "always") flipAlways();
    else if (sw?.dataset.key === "tour") flipTour();
  });

  // Radio group: arrows move the selection (and focus), wrapping; Home / End jump.
  const STEP = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
  on(panel.querySelector(".bs-seg"), "keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    let i = SPEEDS.indexOf(value.speed);
    if (e.key in STEP) i = (i + STEP[e.key] + SPEEDS.length) % SPEEDS.length;
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = SPEEDS.length - 1;
    else return;
    e.preventDefault();
    chooseSpeed(SPEEDS[i], { focus: true });
  });

  // Tab order as if the panel followed the gear in the DOM: gear → full build → speed → autoscroll → next nav control.
  on(panel, "keydown", (e) => {
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
    const first = always;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault();
      button.focus({ preventScroll: true }); // stays open: the gear belongs to it
    } else if (!e.shiftKey && document.activeElement === lastControl()) {
      e.preventDefault();
      close();
      const controls = [...actions.querySelectorAll("button, a[href]")].filter((n) => n.getClientRects().length);
      const next = controls[controls.indexOf(button) + 1];
      (next || button).focus({ preventScroll: true });
    }
  });
  on(button, "keydown", (e) => {
    if (!isOpen || e.key !== "Tab" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    always.focus({ preventScroll: true });
  });

  // Esc closes the panel, and only the panel: consumed before the build's own Esc (skip) sees it.
  on(
    window,
    "keydown",
    (e) => {
      if (!isOpen || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close({ focusGear: true });
    },
    true
  );

  // An outside press closes it (the press itself carries on to whatever it hit).
  on(
    document,
    "pointerdown",
    (e) => {
      if (!isOpen) return;
      const t = e.target instanceof Node ? e.target : null;
      if (t && (panel.contains(t) || button.contains(t))) return;
      close();
    },
    { capture: true, passive: true }
  );

  // Focus leaving both the panel and the gear closes it (not a window switch: the page keeps its focus).
  const checkFocus = () =>
    setTimeout(() => {
      if (!isOpen || pressingButton || !document.hasFocus()) return;
      const a = document.activeElement;
      if (a && (panel.contains(a) || a === button)) return;
      close();
    }, 0);
  on(panel, "focusout", checkFocus);
  on(button, "focusout", checkFocus);

  on(window, "resize", () => isOpen && position(), { passive: true });

  return {
    button,
    panel,
    open: () => open(),
    close: () => close({ focusGear: true }),
    get isOpen() {
      return isOpen;
    },
    destroy() {
      offs.splice(0).forEach((off) => off());
      button.remove();
      panel.remove();
    },
  };
}

export default mountBuildSettings;
