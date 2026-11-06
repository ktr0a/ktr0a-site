/**
 * sfx.js: procedural WebAudio sound engine (no audio files).
 *
 * Contract (SPEC section 6):
 *   sfx.init()                        idempotent; tries to start audio at once, installs the first-gesture unlock
 *   sfx.unlocked / sfx.enabled / sfx.blocked   read-only state
 *   sfx.setEnabled(bool), sfx.toggle({ feedback }), sfx.onChange(cb) -> unsubscribe
 *   sfx.play(name, { x = 0.5, pitch = 0, gain = 1 })
 *   sfx.bed.start() / .setProgress(p) / .stop()
 *
 * Design:
 *   - Every sound is a tiny synth patch ("voice builder") that receives a Voice helper bound to ANY
 *     BaseAudioContext, so the exact same graph renders in real time and in an OfflineAudioContext
 *     (see renderOffline(), used by dev/sfx-lab.html for objective level/length checks).
 *   - Signal flow:  voices -> bus ┐
 *                   bed ──────────┼-> master (0.35) -> gate (enable/visibility fades) -> compressor -> trim -> out
 *                   reverb return ┘
 *     Each voice: layers -> voice gain -> StereoPanner(x) -> bus, plus an optional send -> reverb
 *     (high-passed generated-impulse ConvolverNode).
 *   - Density control, so hundreds of build events per second read as texture, never as a machine gun:
 *     per-name cooldowns (jittered for the "dense" sounds so the rhythm never locks into a buzz),
 *     per-name concurrency caps, a global cap of MAX_VOICES (steals the lowest-priority, oldest voice),
 *     rate-adaptive attenuation for dense sounds, and per-hit pitch/filter/level randomisation.
 *   - Robustness: never throws; unknown names are ignored; no WebAudio -> silent no-op; nothing is
 *     scheduled while the context is not running (so no queued burst on resume); suspended while
 *     disabled or while the tab is hidden; nodes are disconnected when a voice ends; noise / impulse
 *     buffers are generated once per context.
 *   - Autoplay: init() creates the AudioContext at once and asks it to run, so sound starts on the
 *     first beat wherever the browser allows audio without a gesture (Chrome desktop: high Media
 *     Engagement, a same-origin navigation after an interaction, enterprise policy; Firefox / Safari:
 *     the site's autoplay permission set to allow). navigator.getAutoplayPolicy('audiocontext') is
 *     asked first where it exists (Firefox), so a context that would be refused is not even created
 *     (no console warning). Otherwise the context waits, suspended, for the earliest activation-
 *     granting event (pointerdown / mousedown / keydown / touchend / click, capture phase).
 *     `blocked` is true only while audio is known to be refused (it drives the "sound" hint).
 */

const STORE_KEY = 'ktr0a:sound'; // 'on' | 'off' (missing = on)
const MAX_VOICES = 24;
const MASTER_GAIN = 0.35;
const OUTPUT_TRIM = dbToGain(-1.5); // post-compressor trim (keeps the compressor ceiling well below -3 dBFS)
const REVERB_RETURN = 0.55;
const LOOKAHEAD = 0.012; // s; lets attack ramps land on time in real-time scheduling
const BED_LEVEL = 0.1;
const GESTURE_GRACE_MS = 650;
const RESUME_HOLD = 0.04; // s the gate stays shut after the context resumes
// How long the boot attempt waits for the context to report 'running' before calling audio blocked.
// Chrome answers synchronously; the slack covers engines that start the device asynchronously.
const PROBE_MS = 300;

const noop = () => {};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function dbToGain(db) { return Math.pow(10, db / 20); } // declaration: hoisted for the constants above
const semis = (n) => Math.pow(2, n / 12);

/** Small, fast seeded PRNG (deterministic offline renders). */
export function mulberry32(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ───────────────────────── shared buffers (generated once per context) ───────────────────────── */

const RESOURCES = new WeakMap();

function resources(ctx, rng) {
  let r = RESOURCES.get(ctx);
  if (!r) {
    r = { noise: makeNoise(ctx, rng), crushed: makeCrushed(ctx, rng), impulse: makeImpulse(ctx, rng) };
    RESOURCES.set(ctx, r);
  }
  return r;
}

/** 1 s of white noise; sources start at a random offset so repeated hits never sound identical. */
function makeNoise(ctx, rng) {
  const n = ctx.sampleRate;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
  return buf;
}

/** "Bit-crushed" noise: random sample-and-hold blocks quantised to 3 bits (the glitch texture). */
function makeCrushed(ctx, rng) {
  const n = ctx.sampleRate;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let i = 0;
  while (i < n) {
    const hold = 4 + Math.floor(rng() * 36);
    const v = Math.round((rng() * 2 - 1) * 3.5) / 3.5;
    for (let k = 0; k < hold && i < n; k++, i++) d[i] = v * 0.85;
  }
  return buf;
}

/** Small, dark room: stereo decaying noise whose one-pole low-pass closes over time, 12 ms pre-delay. */
function makeImpulse(ctx, rng) {
  const sr = ctx.sampleRate;
  const seconds = 1.3, rt60 = 1.0;
  const len = Math.floor(sr * seconds), pre = Math.floor(sr * 0.012);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const fc = 1400 + 8600 * Math.exp(-t * 3.2); // brightness falls from ~10 kHz to ~1.4 kHz
      const k = Math.exp((-2 * Math.PI * fc) / sr);
      lp = (1 - k) * (rng() * 2 - 1) + k * lp;
      d[i] = lp * Math.exp((-6.91 * t) / rt60);
    }
  }
  return buf;
}

/* ───────────────────────────────────────── Voice ───────────────────────────────────────── */

/** One playing sound: owns its nodes, disconnects them when every source has ended. */
class Voice {
  constructor(engine, name, def, t, level, pan, send) {
    const ctx = engine.ctx;
    this.ctx = ctx;
    this.res = engine.res;
    this.rng = engine.rng;
    this.name = name;
    this.pri = def.pri;
    this.t0 = t;
    this.end = t;
    this.level = level;
    this.nodes = [];
    this.srcs = [];
    this.live = 0;
    this.killed = false;
    this.disposed = false;

    this.out = this.gain(level);
    let tail = this.out;
    this.pan = null;
    if (ctx.createStereoPanner) {
      this.pan = this.add(ctx.createStereoPanner());
      this.pan.pan.value = pan;
      tail.connect(this.pan);
      tail = this.pan;
    }
    tail.connect(engine.bus);
    if (send > 0) {
      const s = this.gain(send);
      tail.connect(s);
      s.connect(engine.reverbIn);
    }
  }

  add(node) { this.nodes.push(node); return node; }
  r(a, b) { return a + (b - a) * this.rng(); }

  gain(v = 0) {
    const g = this.add(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }

  filter(type, freq, q = 0.707) {
    const f = this.add(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  /** Extra stereo placement inside a voice (falls back to a unity gain). */
  stereo(p) {
    if (!this.ctx.createStereoPanner) return this.gain(1);
    const s = this.add(this.ctx.createStereoPanner());
    s.pan.value = clamp(p, -1, 1);
    return s;
  }

  osc(type, freq, t, stop) {
    const o = this.add(this.ctx.createOscillator());
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    this.source(o, t, stop);
    return o;
  }

  /** Looping noise source starting at a random offset. which: 'noise' | 'crushed'. */
  noise(t, stop, which = 'noise', rate = 1) {
    const s = this.add(this.ctx.createBufferSource());
    s.buffer = this.res[which];
    s.loop = true;
    s.playbackRate.value = rate;
    this.source(s, t, stop, this.rng() * 0.9);
    return s;
  }

  source(src, t, stop, offset) {
    if (offset != null) src.start(t, offset); else src.start(t);
    src.stop(stop);
    src._stopAt = stop;
    this.srcs.push(src);
    this.live++;
    src.onended = () => { if (--this.live <= 0) this.dispose(); };
    if (stop > this.end) this.end = stop;
  }

  /** Connect nodes in series; returns the last one. */
  wire(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  /** Percussive envelope: linear attack, exponential decay to -60 dB, then hard zero. Returns end time. */
  perc(param, t, a, peak, d) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + a);
    param.exponentialRampToValueAtTime(Math.max(peak * 1e-3, 1e-6), t + a + d);
    param.setValueAtTime(0, t + a + d + 0.0005);
    return t + a + d;
  }

  /** Swell: linear rise to peak at t+a, exponential fall to -60 dB at t+a+d. */
  swell(param, t, a, peak, d) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + a);
    param.exponentialRampToValueAtTime(Math.max(peak * 1e-3, 1e-6), t + a + d);
    param.setValueAtTime(0, t + a + d + 0.0005);
  }

  /** Exponential frequency glide on an AudioParam. */
  glide(param, t, f0, f1, d) {
    param.setValueAtTime(f0, t);
    param.exponentialRampToValueAtTime(f1, t + d);
  }

  /** Voice stealing: 12 ms fade, then stop every source that would outlive it. */
  kill(at) {
    if (this.killed) return;
    this.killed = true;
    try {
      const g = this.out.gain;
      g.setValueAtTime(this.level, at);
      g.linearRampToValueAtTime(0, at + 0.012);
    } catch { /* ignore */ }
    const stopAt = at + 0.015;
    for (const s of this.srcs) {
      if (s._stopAt > stopAt) { try { s.stop(stopAt); s._stopAt = stopAt; } catch { /* already stopped */ } }
    }
    this.end = Math.min(this.end, stopAt);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* ignore */ } }
    this.nodes.length = 0;
    this.srcs.length = 0;
  }
}

/* ───────────────────────────────────────── Sounds ─────────────────────────────────────────
 * Each entry: pri (0 texture, 1 interaction, 2 signature; lower is stolen first), cd (cooldown s),
 * max (per-name concurrent voices), db (voice gain), send (reverb), dense (jittered cooldown + onset
 * offset + rate-adaptive attenuation + per-hit level jitter), cdJit (dense cooldown spread, default 0.6:
 * cd × 1..1+cdJit), build(v, t, P, opts) with P = pitch ratio.
 * Musical frame: the bed is an A/E fifth; chimes use C-major / A-minor pentatonic tones over it.
 */

const PENTA = [0, 2, 4, 7, 9];
function quantizePenta(s) {
  const oct = Math.floor(s / 12);
  const r = s - oct * 12;
  let best = 0;
  for (const p of [...PENTA, 12]) if (Math.abs(p - r) < Math.abs(best - r)) best = p;
  return oct * 12 + best;
}

/** Simple sine note with a short upward "bloop" glide; used by several chirps. */
function chirp(v, t, f, d, peak, { type = 'sine', from = 0.9, glideT = 0.016, attack = 0.003 } = {}) {
  const o = v.osc(type, f * from, t, t + attack + d + 0.01);
  o.frequency.exponentialRampToValueAtTime(f, t + glideT);
  const g = v.gain();
  v.perc(g.gain, t, attack, peak, d);
  return v.wire(o, g, v.out);
}

const SOUNDS = {
  /* ── build texture (very short, quiet, randomised) ── */
  type: {
    // cooldown 28–90 ms (random per hit): a loose, uneven texture instead of a 20 Hz rattle
    pri: 0, cd: 0.028, cdJit: 2.2, max: 3, db: -14.5, dense: true,
    build(v, t, P) {
      const dec = v.r(0.011, 0.02);
      // filtered-noise "key" transient; band centre/Q randomised per hit (timbre varies, loudness doesn't:
      // band power ∝ f/Q, so the amplitude is normalised by sqrt(Q/f))
      const n = v.noise(t, t + dec + 0.006);
      const f = v.r(2400, 4400), q = v.r(1, 1.6);
      const bp = v.filter('bandpass', f * P, q);
      const lp = v.filter('lowpass', 6500, 0.7); // keep it soft: no hiss above the key "body"
      const ng = v.gain();
      v.perc(ng.gain, t, 0.0008, Math.sqrt((q / 1.3) * (3400 / f)), dec);
      v.wire(n, bp, lp, ng, v.out);
      // tiny pitched body that falls fast: the "plastic" weight of a key
      const fb = v.r(1000, 1600) * P;
      const o = v.osc('triangle', fb, t, t + 0.026);
      o.frequency.exponentialRampToValueAtTime(fb * 0.55, t + 0.02);
      const og = v.gain();
      v.perc(og.gain, t, 0.0006, v.r(0.18, 0.4), v.r(0.008, 0.016));
      v.wire(o, og, v.out);
    },
  },
  typeHeavy: {
    pri: 0, cd: 0.045, max: 3, db: -15.5, dense: true, send: 0.04,
    build(v, t, P) {
      const f = v.r(150, 185) * P;
      const o = v.osc('sine', f, t, t + 0.085);
      o.frequency.exponentialRampToValueAtTime(f * 0.5, t + 0.06);
      const og = v.gain();
      v.perc(og.gain, t, 0.002, 1, 0.075);
      v.wire(o, og, v.out);
      const n = v.noise(t, t + 0.03);
      const lp = v.filter('lowpass', v.r(1100, 1600) * P, 0.9);
      const ng = v.gain();
      v.perc(ng.gain, t, 0.0008, 0.7, 0.024);
      v.wire(n, lp, ng, v.out);
      const n2 = v.noise(t, t + 0.01);
      const bp = v.filter('bandpass', v.r(2600, 3400) * P, 1.2);
      const g2 = v.gain();
      v.perc(g2.gain, t, 0.0004, 0.5, 0.007);
      v.wire(n2, bp, g2, v.out);
    },
  },
  handle: {
    pri: 0, cd: 0.03, max: 3, db: -24, dense: true,
    build(v, t, P) {
      const o = v.osc('sine', v.r(3000, 3800) * P, t, t + 0.016);
      const og = v.gain();
      v.perc(og.gain, t, 0.0005, 1, 0.011);
      v.wire(o, og, v.out);
      const n = v.noise(t, t + 0.008);
      const bp = v.filter('bandpass', 6000, 0.9);
      const ng = v.gain();
      v.perc(ng.gain, t, 0.0003, 0.6, 0.005);
      v.wire(n, bp, ng, v.out);
    },
  },
  hover: {
    pri: 0, cd: 0.05, max: 2, db: -27, dense: true,
    build(v, t, P) {
      const o = v.osc('sine', v.r(1900, 2300) * P, t, t + 0.022);
      const g = v.gain();
      v.perc(g.gain, t, 0.0015, 1, 0.016);
      v.wire(o, g, v.out);
    },
  },
  spawn: {
    pri: 0, cd: 0.045, max: 4, db: -19, dense: true, send: 0.14,
    build(v, t, _P, opts) {
      // pentatonic by pitch: explicit pitch is quantised to C-major pentatonic; none -> random degree
      const p = Number(opts.pitch);
      const s = Number.isFinite(p) && opts.pitch != null
        ? quantizePenta(clamp(p, -24, 24))
        : PENTA[Math.floor(v.rng() * 5)] + (v.rng() < 0.35 ? 12 : 0);
      const f = 523.25 * semis(s);
      chirp(v, t, f, 0.07, 1, { from: 0.92, glideT: 0.012 });
      const o2 = v.osc('sine', f * 2, t, t + 0.035);
      const g2 = v.gain();
      v.perc(g2.gain, t, 0.002, 0.18, 0.026);
      v.wire(o2, g2, v.out);
    },
  },
  wireDraw: {
    pri: 0, cd: 0.05, max: 3, db: -3, dense: true, send: 0.06,
    build(v, t, P) {
      const d = v.r(0.07, 0.11);
      const up = v.rng() < 0.7;
      const f0 = (up ? 700 : 3400) * P, f1 = (up ? 3800 : 900) * P;
      const n = v.noise(t, t + d + 0.006);
      const q = v.r(4, 7);
      const bp = v.filter('bandpass', f0, q);
      v.glide(bp.frequency, t, f0, f1, d);
      // amplitude-modulated "zipper" grain
      const am = v.gain(0.55);
      const lfo = v.osc('triangle', v.r(70, 110), t, t + d + 0.006);
      const lg = v.gain(0.45);
      v.wire(lfo, lg, am.gain);
      const g = v.gain();
      v.swell(g.gain, t, 0.012, Math.sqrt(q / 5.5), d - 0.012); // constant band power across random Q
      v.wire(n, bp, am, g, v.out);
    },
  },
  measure: {
    pri: 0, cd: 0.08, max: 2, db: -21.5, send: 0.05,
    build(v, t, P) {
      const tick = (tt, f, pk) => {
        const o = v.osc('sine', f, tt, tt + 0.022);
        const og = v.gain();
        v.perc(og.gain, tt, 0.0005, pk, 0.018);
        v.wire(o, og, v.out);
        const n = v.noise(tt, tt + 0.008);
        const hp = v.filter('highpass', 5000, 0.7);
        const ng = v.gain();
        v.perc(ng.gain, tt, 0.0003, pk * 0.5, 0.005);
        v.wire(n, hp, ng, v.out);
      };
      tick(t, 2500 * P, 1);
      tick(t + 0.05, 3750 * P, 0.8);
    },
  },

  /* ── interaction / mid-level events ── */
  select: {
    pri: 1, cd: 0.12, max: 2, db: -7, send: 0.12,
    build(v, t, P) {
      const d = 0.14;
      const n = v.noise(t, t + d + 0.01);
      const hp = v.filter('highpass', 700, 0.7);
      const bp = v.filter('bandpass', 1400 * P, 1.3);
      v.glide(bp.frequency, t, 1400 * P, 6500 * P, d);
      const g = v.gain();
      v.swell(g.gain, t, 0.08, 1, d - 0.08);
      v.wire(n, hp, bp, g, v.out);
    },
  },
  paste: {
    pri: 1, cd: 0.14, max: 2, db: -12, send: 0.15,
    build(v, t, P) {
      const note = (tt, f, d, pk) => {
        chirp(v, tt, f, d, pk, { from: 0.78, glideT: 0.02, attack: 0.004 });
        const o = v.osc('triangle', f / 2, tt, tt + d + 0.01);
        const lp = v.filter('lowpass', 2400, 0.7);
        const g = v.gain();
        v.perc(g.gain, tt, 0.004, pk * 0.25, d * 0.7);
        v.wire(o, lp, g, v.out);
      };
      note(t, 587.33 * P, 0.07, 0.9);
      note(t + 0.065, 880 * P, 0.1, 1);
    },
  },
  placeholder: {
    pri: 1, cd: 0.07, max: 3, db: -11, send: 0.1,
    build(v, t, P) {
      const o = v.osc('sine', 300 * P, t, t + 0.13);
      o.frequency.exponentialRampToValueAtTime(120 * P, t + 0.05);
      const g = v.gain();
      v.perc(g.gain, t, 0.002, 1, 0.11);
      v.wire(o, g, v.out);
      const n = v.noise(t, t + 0.025);
      const lp = v.filter('lowpass', 900, 0.7);
      const ng = v.gain();
      v.perc(ng.gain, t, 0.001, 0.3, 0.02);
      v.wire(n, lp, ng, v.out);
    },
  },
  glitch: {
    pri: 1, cd: 0.09, max: 2, db: -13.5, send: 0.05,
    build(v, t, P) {
      const d = v.r(0.06, 0.09);
      const src = v.noise(t, t + d + 0.004, 'crushed', v.r(0.35, 1.1));
      const bp = v.filter('bandpass', v.r(1400, 2800) * P, 0.8);
      const sq = v.osc('square', v.r(300, 900) * P, t, t + d + 0.004);
      const sqg = v.gain(0.2);
      const gate = v.gain(0);
      // stutter gate: random on/off slices of 6–14 ms with stepped square pitches
      let tt = t, first = true;
      while (tt < t + d - 0.006) {
        const on = first || v.rng() < 0.72;
        first = false;
        gate.gain.setTargetAtTime(on ? v.r(0.55, 1) : v.r(0, 0.08), tt, 0.0012);
        sq.frequency.setValueAtTime(v.r(250, 1800) * P, tt);
        tt += v.r(0.006, 0.014);
      }
      gate.gain.setTargetAtTime(0, t + d - 0.006, 0.0012);
      const lp = v.filter('lowpass', 6000, 0.7);
      v.wire(src, bp, gate);
      v.wire(sq, sqg, gate);
      v.wire(gate, lp, v.out);
    },
  },
  reveal: {
    pri: 1, cd: 0.18, max: 2, db: -6.5, send: 0.45,
    build(v, t, P) {
      [1567.98, 2093, 2637.02, 3135.96].forEach((f, i) => {
        const tt = t + i * 0.028 + v.r(0, 0.01);
        const end = tt + 0.6 - i * 0.05;
        const o = v.osc('sine', f * P * (1 + v.r(-0.002, 0.002)), tt, end + 0.01);
        const g = v.gain();
        v.swell(g.gain, tt, 0.03, 0.32 / (1 + i * 0.25), end - tt - 0.03);
        v.wire(o, g, v.out);
      });
      const n = v.noise(t, t + 0.4);
      const hp = v.filter('highpass', 5500, 0.7);
      const lp = v.filter('lowpass', 11000, 0.7);
      const ng = v.gain();
      v.swell(ng.gain, t, 0.06, 0.2, 0.3);
      v.wire(n, hp, lp, ng, v.out);
    },
  },
  qaFlag: {
    pri: 1, cd: 0.1, max: 2, db: -18.5, send: 0.1,
    build(v, t, P) {
      const o = v.osc('square', 196 * P, t, t + 0.13);
      const lp = v.filter('lowpass', 1800 * P, 3);
      v.glide(lp.frequency, t, 1800 * P, 500 * P, 0.11);
      const g = v.gain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 0.004);
      g.gain.setValueAtTime(1, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      g.gain.setValueAtTime(0, t + 0.1205);
      v.wire(o, lp, g, v.out);
      const s = v.osc('sine', 98 * P, t, t + 0.12);
      const sg = v.gain();
      v.perc(sg.gain, t, 0.004, 0.5, 0.1);
      v.wire(s, sg, v.out);
    },
  },
  qaPass: {
    pri: 1, cd: 0.1, max: 2, db: -9.5, send: 0.2,
    build(v, t, P) {
      chirp(v, t, 1046.5 * P, 0.07, 0.8, { type: 'triangle', from: 0.94, glideT: 0.015 });
      chirp(v, t + 0.06, 1318.51 * P, 0.13, 1, { type: 'triangle', from: 0.94, glideT: 0.015 });
    },
  },
  ruler: {
    pri: 1, cd: 0.25, max: 1, db: -14, send: 0.08,
    build(v, t, P) {
      // one oscillator + one noise source gated by a run of accelerating ticks with rising pitch
      const D = 0.26, N = 12;
      const o = v.osc('sine', 1800 * P, t, t + D + 0.03);
      o.frequency.exponentialRampToValueAtTime(3600 * P, t + D);
      const n = v.noise(t, t + D + 0.03);
      const hp = v.filter('bandpass', 6000, 1.2);
      const ng = v.gain(0.35);
      const gate = v.gain(0);
      for (let i = 0; i < N; i++) {
        const ti = t + D * Math.pow(i / N, 0.8);
        const lvl = 1 - (i / N) * 0.5;
        gate.gain.setValueAtTime(0, ti);
        gate.gain.linearRampToValueAtTime(lvl, ti + 0.0006);
        gate.gain.exponentialRampToValueAtTime(lvl * 0.002, ti + 0.009);
      }
      gate.gain.setValueAtTime(0, t + D + 0.02);
      v.wire(o, gate);
      v.wire(n, hp, ng, gate);
      v.wire(gate, v.out);
    },
  },
  click: {
    pri: 1, cd: 0.03, max: 3, db: -8.5, send: 0.04,
    build(v, t, P) {
      const n = v.noise(t, t + 0.01);
      const bp = v.filter('bandpass', 3400 * P, 1.1);
      const ng = v.gain();
      v.perc(ng.gain, t, 0.0003, 1, 0.005);
      v.wire(n, bp, ng, v.out);
      const o = v.osc('sine', 520 * P, t, t + 0.035);
      o.frequency.exponentialRampToValueAtTime(240 * P, t + 0.02);
      const og = v.gain();
      v.perc(og.gain, t, 0.0008, 0.7, 0.028);
      v.wire(o, og, v.out);
    },
  },
  toggleOn: {
    pri: 1, cd: 0.06, max: 2, db: -9, send: 0.12,
    build(v, t, P) {
      const n = v.noise(t, t + 0.008);
      const bp = v.filter('bandpass', 3000, 1.1);
      const ng = v.gain();
      v.perc(ng.gain, t, 0.0003, 0.5, 0.004);
      v.wire(n, bp, ng, v.out);
      chirp(v, t, 659.25 * P, 0.05, 0.8);
      chirp(v, t + 0.045, 987.77 * P, 0.09, 1);
    },
  },
  toggleOff: {
    pri: 1, cd: 0.06, max: 2, db: -8.5, send: 0.1,
    build(v, t, P) {
      const n = v.noise(t, t + 0.008);
      const bp = v.filter('bandpass', 2600, 1.1);
      const ng = v.gain();
      v.perc(ng.gain, t, 0.0003, 0.5, 0.004);
      v.wire(n, bp, ng, v.out);
      chirp(v, t, 987.77 * P, 0.045, 0.8, { from: 1.04 });
      chirp(v, t + 0.045, 622.25 * P, 0.08, 0.85, { from: 1.06 });
    },
  },
  speed: {
    pri: 1, cd: 0.06, max: 2, db: -11.5, send: 0.12,
    build(v, t, P) {
      const o = v.osc('sine', 680 * P, t, t + 0.085);
      o.frequency.exponentialRampToValueAtTime(1500 * P, t + 0.05);
      const g = v.gain();
      v.perc(g.gain, t, 0.002, 1, 0.075);
      v.wire(o, g, v.out);
      const o2 = v.osc('sine', 1360 * P, t, t + 0.05);
      o2.frequency.exponentialRampToValueAtTime(3000 * P, t + 0.05);
      const g2 = v.gain();
      v.perc(g2.gain, t, 0.002, 0.18, 0.04);
      v.wire(o2, g2, v.out);
    },
  },

  /* ── signature moments (richer, reverb) ── */
  boot: {
    pri: 2, cd: 1, max: 1, db: -6, send: 0.3,
    build(v, t, P) {
      const D = 1.2;
      const lp = v.filter('lowpass', 90 * P, 2.5);
      lp.frequency.setValueAtTime(90 * P, t);
      lp.frequency.exponentialRampToValueAtTime(1100 * P, t + 0.95);
      lp.frequency.exponentialRampToValueAtTime(260 * P, t + D + 0.3);
      const env = v.gain();
      v.swell(env.gain, t, 0.88, 1, D - 0.88 + 0.32);
      const o1 = v.osc('sawtooth', 55 * P, t, t + D + 0.25);
      o1.detune.value = -7;
      const o2 = v.osc('sawtooth', 82.41 * P, t, t + D + 0.25);
      o2.detune.value = 6;
      const sub = v.osc('sine', 55 * P, t, t + D + 0.25);
      const g1 = v.gain(0.5), g2 = v.gain(0.35), gs = v.gain(0.6);
      v.wire(o1, g1, lp);
      v.wire(o2, g2, lp);
      v.wire(sub, gs, env);
      v.wire(lp, env, v.out);
      const n = v.noise(t, t + D + 0.2);
      const bp = v.filter('bandpass', 2200, 0.7);
      const ng = v.gain();
      v.swell(ng.gain, t, 0.9, 0.16, D - 0.9 + 0.2);
      v.wire(n, bp, ng, v.out);
    },
  },
  logoPing: {
    pri: 2, cd: 0.4, max: 1, db: -3.5, send: 0.45,
    build(v, t, P) {
      // soft FM bell: modulation index decays fast, inharmonic ratio 3.5
      const fc = 880 * P;
      const car = v.osc('sine', fc, t, t + 1.5);
      const mod = v.osc('sine', fc * 3.5, t, t + 1.5);
      const mg = v.gain();
      mg.gain.setValueAtTime(fc * 1.8, t);
      mg.gain.exponentialRampToValueAtTime(fc * 0.03, t + 0.45);
      v.wire(mod, mg, car.frequency);
      const g = v.gain();
      v.perc(g.gain, t, 0.002, 1, 1.45);
      v.wire(car, g, v.out);
      const p2 = v.osc('sine', fc * 2.756, t, t + 0.5);
      const g2 = v.gain();
      v.perc(g2.gain, t, 0.002, 0.14, 0.45);
      v.wire(p2, g2, v.out);
    },
  },
  scatter: {
    pri: 2, cd: 0.6, max: 1, db: 2.5, send: 0.3,
    build(v, t, P) {
      const D = 0.65;
      // two band-passed noise whooshes, spread left/right, sweeping up then settling
      [-0.55, 0.55].forEach((pp, i) => {
        const n = v.noise(t, t + D + 0.01);
        const f0 = (i ? 340 : 280) * P;
        const bp = v.filter('bandpass', f0, 1.4);
        bp.frequency.setValueAtTime(f0, t);
        bp.frequency.exponentialRampToValueAtTime((i ? 4600 : 5400) * P, t + 0.3);
        bp.frequency.exponentialRampToValueAtTime(2200 * P, t + D);
        const g = v.gain();
        v.swell(g.gain, t, 0.13 + i * 0.02, 1, D - 0.15);
        v.wire(n, bp, g, v.stereo(pp), v.out);
      });
      // sparkle ticks: the trails of "+" marks
      for (let k = 0; k < 9; k++) {
        const tt = t + 0.06 + v.rng() * 0.4;
        const o = v.osc('sine', v.r(2600, 5200) * P, tt, tt + 0.024);
        const g = v.gain();
        v.perc(g.gain, tt, 0.0006, v.r(0.04, 0.09), 0.02);
        v.wire(o, g, v.stereo(v.r(-0.7, 0.7)), v.out);
      }
      const o = v.osc('sine', 95 * P, t, t + 0.3);
      o.frequency.exponentialRampToValueAtTime(48 * P, t + 0.2);
      const og = v.gain();
      v.perc(og.gain, t, 0.006, 0.3, 0.28);
      v.wire(o, og, v.out);
    },
  },
  sectionDone: {
    pri: 2, cd: 0.5, max: 2, db: -6, send: 0.3,
    build(v, t, P) {
      [783.99, 987.77, 1174.66].forEach((f, i) => {
        const tt = t + i * 0.075;
        const d = 0.32 + i * 0.1;
        const o = v.osc('sine', f * P, tt, tt + d + 0.01);
        const g = v.gain();
        v.perc(g.gain, tt, 0.004, 0.9 - i * 0.1, d);
        v.wire(o, g, v.out);
        const o2 = v.osc('sine', f * 2 * P, tt, tt + 0.13);
        const g2 = v.gain();
        v.perc(g2.gain, tt, 0.003, 0.12, 0.12);
        v.wire(o2, g2, v.out);
      });
    },
  },
  complete: {
    pri: 2, cd: 1.5, max: 1, db: -4.5, send: 0.45,
    build(v, t, P) {
      const arp = [523.25, 659.25, 783.99, 987.77, 1174.66, 1567.98];
      arp.forEach((f, i) => {
        const tt = t + i * 0.065;
        const d = 0.45 + i * 0.06;
        const o = v.osc('triangle', f * P, tt, tt + d + 0.01);
        const lp = v.filter('lowpass', 3200, 0.7);
        const g = v.gain();
        v.perc(g.gain, tt, 0.005, 0.5, d);
        v.wire(o, lp, g, v.out);
        const s = v.osc('sine', f * P, tt, tt + d + 0.01);
        const sg = v.gain();
        v.perc(sg.gain, tt, 0.004, 0.3, d);
        v.wire(s, sg, v.out);
      });
      // low hit as the arpeggio lands
      const th = t + arp.length * 0.065;
      const o = v.osc('sine', 110 * P, th, th + 0.6);
      o.frequency.exponentialRampToValueAtTime(46 * P, th + 0.3);
      const og = v.gain();
      v.perc(og.gain, th, 0.004, 0.9, 0.55);
      v.wire(o, og, v.out);
      const n = v.noise(th, th + 0.13);
      const lp = v.filter('lowpass', 220, 0.7);
      const ng = v.gain();
      v.perc(ng.gain, th, 0.002, 0.6, 0.12);
      v.wire(n, lp, ng, v.out);
      // shimmer tail with gentle tremolo
      [2093, 2637.02, 3135.96, 4186.01].forEach((f, i) => {
        const end = th + 1.5 + i * 0.1;
        const s = v.osc('sine', f * P * (1 + v.r(-0.002, 0.002)), th, end + 0.01);
        const g = v.gain();
        v.swell(g.gain, th, 0.12, 0.12 / (1 + i * 0.3), end - th - 0.12);
        const trem = v.gain(0.65);
        const lfo = v.osc('sine', v.r(5, 7), th, end + 0.01);
        const lg = v.gain(0.35);
        v.wire(lfo, lg, trem.gain);
        v.wire(s, g, trem, v.out);
      });
    },
  },
  depart: {
    pri: 2, cd: 0.35, max: 2, db: -1.5, send: 0.3,
    build(v, t, P) {
      const d = 0.6;
      const n = v.noise(t, t + d + 0.01);
      const bp = v.filter('bandpass', 4200 * P, 1.6);
      v.glide(bp.frequency, t, 4200 * P, 420 * P, d);
      const g = v.gain();
      v.swell(g.gain, t, 0.09, 1, d - 0.09);
      v.wire(n, bp, g, v.out);
      const o = v.osc('sine', 1100 * P, t, t + 0.5);
      o.frequency.exponentialRampToValueAtTime(260 * P, t + 0.48);
      const og = v.gain();
      v.perc(og.gain, t, 0.03, 0.08, 0.45);
      v.wire(o, og, v.out);
      // agents leave toward the top-right: pan drifts right
      if (v.pan) {
        v.pan.pan.setValueAtTime(v.pan.pan.value, t);
        v.pan.pan.linearRampToValueAtTime(0.8, t + d);
      }
    },
  },
  skip: {
    pri: 2, cd: 0.3, max: 1, db: -4, send: 0.2,
    build(v, t, P) {
      // rewind: reversed (crescendo) envelope, rising band-pass and a tape spin-up
      const d = 0.36;
      const env = (param, peak) => {
        param.setValueAtTime(0.0001, t);
        param.exponentialRampToValueAtTime(peak, t + d - 0.025);
        param.linearRampToValueAtTime(0, t + d);
      };
      const n = v.noise(t, t + d + 0.005);
      const bp = v.filter('bandpass', 450 * P, 2);
      v.glide(bp.frequency, t, 450 * P, 6800 * P, d);
      const g = v.gain();
      env(g.gain, 1);
      v.wire(n, bp, g, v.out);
      const o = v.osc('sawtooth', 130 * P, t, t + d + 0.005);
      o.frequency.exponentialRampToValueAtTime(880 * P, t + d);
      const lp = v.filter('lowpass', 2000, 0.7);
      const og = v.gain();
      env(og.gain, 0.14);
      v.wire(o, lp, og, v.out);
    },
  },
};

export const SOUND_NAMES = Object.freeze(Object.keys(SOUNDS));

/* ───────────────────────────────────────── Engine ───────────────────────────────────────── */

const bedCutoff = (p) => 220 * Math.pow(2600 / 220, clamp(p, 0, 1));

/** The mixer + scheduler, bound to one BaseAudioContext (real-time or offline). */
class Engine {
  constructor(ctx, { rng = Math.random } = {}) {
    this.ctx = ctx;
    this.rng = rng;
    this.res = resources(ctx, rng);
    this.voices = []; // active voices, in start order
    this.state = Object.create(null); // per-name { next, dens, t }
    this.bed = null;
    this.stats = { played: 0, cooldown: 0, capped: 0, stolen: 0, dropped: 0, maxActive: 0, maxByName: {} };

    this.bus = ctx.createGain();
    this.master = ctx.createGain();
    this.master.gain.value = MASTER_GAIN;
    this.gate = ctx.createGain();
    this.gate.gain.value = 1;
    // Glue + safety in one stage. Note: browsers add automatic makeup gain ((1/fullRangeGain)^0.6, here
    // about +6.3 dB) on top of this curve; levels are calibrated with it. Measured ceiling ≈ -5 dBFS after trim.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 8;
    this.comp.ratio.value = 8;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.2;
    this.trim = ctx.createGain();
    this.trim.gain.value = OUTPUT_TRIM;
    this.bus.connect(this.master);
    this.master.connect(this.gate);
    this.gate.connect(this.comp);
    this.comp.connect(this.trim);
    this.trim.connect(ctx.destination);

    // reverb send: high-passed so low thumps stay dry and the room never gets muddy
    this.reverbIn = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 280;
    const conv = ctx.createConvolver();
    conv.buffer = this.res.impulse;
    const ret = ctx.createGain();
    ret.gain.value = REVERB_RETURN;
    this.reverbIn.connect(hp);
    hp.connect(conv);
    conv.connect(ret);
    ret.connect(this.master);
  }

  /** Smoothly move the enable/visibility gate. If the context is not running, jump instead. */
  fade(target, delay = 0, tc = 0.03) {
    const g = this.gate.gain;
    if (this.ctx.state !== 'running') {
      g.cancelScheduledValues(0);
      g.value = target;
      return;
    }
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(target, now + delay, tc);
  }

  /**
   * Schedule one sound at `when` (context time). Returns a status string:
   * 'played' | 'cooldown' | 'dropped' | 'muted' | 'unknown' | 'error'.
   */
  play(name, opts = {}, when = this.ctx.currentTime) {
    const def = Object.prototype.hasOwnProperty.call(SOUNDS, name) ? SOUNDS[name] : null;
    if (!def) return 'unknown';
    const g = Number(opts.gain ?? 1);
    if (!(g > 0)) return 'muted';

    // Requests arrive on animation frames (16.7 ms grid): a random onset offset breaks that lock.
    if (def.dense) when += this.rng() * 0.022;
    // cooldown (jittered for dense sounds so bursts never lock into a periodic buzz)
    const st = this.state[name] || (this.state[name] = { next: -Infinity, dens: 0, t: -Infinity });
    if (when < st.next) { this.stats.cooldown++; return 'cooldown'; }
    st.next = when + def.cd * (def.dense ? 1 + this.rng() * (def.cdJit ?? 0.6) : 1);

    // rate-adaptive attenuation: exponentially-decayed hit count over ~250 ms
    st.dens = st.dens * Math.exp(-(when - st.t) / 0.25) + 1;
    st.t = when;
    const densMul = def.dense ? 1 / Math.sqrt(Math.max(1, st.dens / 3)) : 1;

    // voice management
    this.voices = this.voices.filter((v) => v.end > when && !v.killed);
    const same = this.voices.filter((v) => v.name === name);
    if (same.length >= def.max) { this.steal(same[0], when); this.stats.capped++; }
    if (this.voices.length >= MAX_VOICES) {
      let victim = null;
      for (const v of this.voices) if (!victim || v.pri < victim.pri) victim = v; // first = oldest among lowest
      if (victim.pri > def.pri) { this.stats.dropped++; return 'dropped'; }
      this.steal(victim, when);
      this.stats.stolen++;
    }

    const P = semis(clamp(Number(opts.pitch) || 0, -24, 24));
    const x = Number(opts.x);
    const pan = clamp(((Number.isFinite(x) ? x : 0.5) - 0.5) * 1.6, -0.8, 0.8);
    const jitter = def.dense ? dbToGain((this.rng() - 0.5) * 3) : 1; // ±1.5 dB
    const level = dbToGain(def.db) * Math.min(g, 2) * densMul * jitter;

    const v = new Voice(this, name, def, when, level, pan, def.send || 0);
    try {
      def.build(v, when, P, opts);
    } catch {
      for (const s of v.srcs) { try { s.stop(); } catch { /* ignore */ } }
      v.dispose();
      return 'error';
    }
    if (v.srcs.length === 0) { v.dispose(); return 'error'; }
    this.voices.push(v);
    this.stats.played++;
    this.stats.maxActive = Math.max(this.stats.maxActive, this.voices.length);
    const n = this.voices.reduce((c, o) => c + (o.name === name), 0);
    this.stats.maxByName[name] = Math.max(this.stats.maxByName[name] || 0, n);
    return 'played';
  }

  steal(v, when) {
    v.kill(when);
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }

  /* ── bed: two detuned saws (A2 + E3) + band-passed noise through a low-pass that opens with progress ── */

  bedStart(progress = 0, when = this.ctx.currentTime, fadeIn = 2.4) {
    if (this.bed) return;
    const ctx = this.ctx;
    const nodes = [], srcs = [];
    const mk = (n) => (nodes.push(n), n);
    const src = (n) => (srcs.push(mk(n)), n);

    const out = mk(ctx.createGain());
    out.gain.setValueAtTime(0, when);
    out.gain.setTargetAtTime(BED_LEVEL, when, fadeIn / 3);
    const lp = mk(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.Q.value = 0.9;
    lp.frequency.setValueAtTime(bedCutoff(progress), when);

    const o1 = src(ctx.createOscillator());
    o1.type = 'sawtooth'; o1.frequency.value = 110; o1.detune.value = -8;
    const o2 = src(ctx.createOscillator());
    o2.type = 'sawtooth'; o2.frequency.value = 164.81; o2.detune.value = 7;
    const g1 = mk(ctx.createGain()); g1.gain.value = 0.5;
    const g2 = mk(ctx.createGain()); g2.gain.value = 0.32;

    const n = src(ctx.createBufferSource());
    n.buffer = this.res.noise; n.loop = true;
    const bp = mk(ctx.createBiquadFilter());
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
    const ng = mk(ctx.createGain());
    ng.gain.setValueAtTime(0.12 + 0.25 * progress, when);

    // slow, incommensurate LFOs keep the drone evolving: beating, filter breathing, noise swell
    const lfo = (rate, depth, param) => {
      const o = src(ctx.createOscillator());
      o.frequency.value = rate;
      const g = mk(ctx.createGain());
      g.gain.value = depth;
      o.connect(g); g.connect(param);
    };
    lfo(0.071, 6, o2.detune);
    lfo(0.13, 260, lp.detune);
    lfo(0.043, 0.06, ng.gain);

    o1.connect(g1); g1.connect(lp);
    o2.connect(g2); g2.connect(lp);
    n.connect(bp); bp.connect(ng); ng.connect(lp);
    lp.connect(out);
    out.connect(this.master);
    const send = mk(ctx.createGain());
    send.gain.value = 0.18;
    out.connect(send); send.connect(this.reverbIn);

    for (const s of srcs) s.start(when, s === n ? this.rng() * 0.9 : undefined);
    let live = srcs.length;
    const dispose = () => { for (const x of nodes) { try { x.disconnect(); } catch { /* ignore */ } } };
    for (const s of srcs) s.onended = () => { if (--live === 0) dispose(); };
    this.bed = { out, lp, ng, srcs, dispose };
  }

  bedProgress(p, when = this.ctx.currentTime) {
    const b = this.bed;
    if (!b) return;
    p = clamp(Number(p) || 0, 0, 1);
    b.lp.frequency.setTargetAtTime(bedCutoff(p), when, 0.5);
    b.ng.gain.setTargetAtTime(0.12 + 0.25 * p, when, 0.5);
  }

  bedStop(when = this.ctx.currentTime, immediate = false, fade = 1.4) {
    const b = this.bed;
    if (!b) return;
    this.bed = null;
    if (immediate) {
      for (const s of b.srcs) { try { s.stop(); } catch { /* ignore */ } }
      b.dispose();
      return;
    }
    b.out.gain.setTargetAtTime(0, when, fade / 4);
    for (const s of b.srcs) { try { s.stop(when + fade * 1.6); } catch { /* ignore */ } }
  }
}

/* ─────────────────────────────── offline rendering (dev / tests) ─────────────────────────────── */

/**
 * Render a list of events through a fresh Engine on an OfflineAudioContext.
 * events: [{ t, name, opts }] sorted by t (seconds). bed: { start, progress, stop, fadeIn, ramp } (optional).
 * All times are shifted by `warmup` and the warm-up is trimmed from the returned buffer: the compressor's
 * automatic makeup gain needs ~0.3 s after context start to settle, which a live page always has had.
 * Resolves { buffer, stats, results }. Used by dev/sfx-lab.html; not used by the site at runtime.
 */
export async function renderOffline(events, { seconds = 2, sampleRate = 48000, seed = 1, bed = null, warmup = 0.6 } = {}) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw new Error('OfflineAudioContext unsupported');
  const ctx = new OAC(2, Math.ceil((seconds + warmup) * sampleRate), sampleRate);
  const eng = new Engine(ctx, { rng: mulberry32(seed) });
  const w = warmup;
  if (bed) {
    eng.bedStart(bed.progress ?? 0, (bed.start ?? 0) + w, bed.fadeIn ?? 2.4);
    for (const [t, p] of bed.ramp || []) eng.bedProgress(p, t + w);
    if (bed.stop != null) eng.bedStop(bed.stop + w);
  }
  const results = events.map((e) => eng.play(e.name, e.opts || {}, e.t + w));
  const full = await ctx.startRendering();
  const skip = Math.floor(w * sampleRate), len = full.length - skip;
  const buffer = ctx.createBuffer(2, len, sampleRate);
  for (let c = 0; c < 2; c++) buffer.getChannelData(c).set(full.getChannelData(c).subarray(skip));
  return { buffer, stats: eng.stats, results };
}

/* ─────────────────────────────── real-time singleton ─────────────────────────────── */

const hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined';
const AC = hasDOM ? (window.AudioContext || window.webkitAudioContext || null) : null;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

let rt = null; // real-time Engine: created at init (bootAttempt) or, where that is refused up front, in the first gesture
let inited = false;
let enabled = readPref();
let unlocked = false;
let refused = false; // the boot attempt found audio blocked until a user gesture
let unlockGestureAt = -Infinity; // time of the gesture that first tried to unlock audio
let suspendTimer = 0, hideTimer = 0, probeTimer = 0;
const subs = new Set();
const bedWant = { on: false, p: 0 };
// One sound requested while the context is resuming (e.g. 'toggleOn' right after setEnabled(true), or the
// first click that unlocks audio). Single slot + short expiry: a resume can never release a burst.
let pending = null;
const PENDING_MS = 400;

function readPref() {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return !(v === 'off' || v === '0' || v === 'false');
  } catch { return true; }
}
function writePref() {
  try { localStorage.setItem(STORE_KEY, enabled ? 'on' : 'off'); } catch { /* storage blocked */ }
}

const isBlocked = () => enabled && !unlocked && refused;

function emit() {
  const s = { enabled, unlocked, blocked: isBlocked() };
  for (const cb of subs) {
    try { cb(s); } catch (e) { (globalThis.reportError || console.error)(e); }
  }
}

const isHidden = () => hasDOM && document.visibilityState === 'hidden';

/** Can we start audio right now without a browser autoplay warning? */
function activationOK() {
  const ua = hasDOM ? navigator.userActivation : null;
  return !ua || ua.isActive || ua.hasBeenActive;
}

function ensureEngine() {
  if (rt) return rt;
  if (!AC) return null;
  let ctx;
  try { ctx = new AC({ latencyHint: 'interactive' }); } catch {
    try { ctx = new AC(); } catch { return null; }
  }
  try { rt = new Engine(ctx); } catch {
    try { ctx.close(); } catch { /* ignore */ }
    return null;
  }
  try { ctx.addEventListener('statechange', onCtxState); } catch { ctx.onstatechange = onCtxState; }
  return rt;
}

/** ctx.suspend() that never throws (old WebKit returns no promise). */
function suspendCtx() {
  try {
    const p = rt && rt.ctx.suspend();
    if (p && p.catch) p.catch(noop);
  } catch { /* ignore */ }
}

function resumeCtx() {
  if (!rt || isHidden()) return;
  const c = rt.ctx;
  if (c.state === 'running') { onCtxState(); return; }
  try {
    const p = c.resume();
    if (p && p.then) p.then(onCtxState, noop);
  } catch { /* ignore */ }
}

function onCtxState() {
  if (!rt || rt.ctx.state !== 'running') return;
  clearTimeout(probeTimer);
  if (!unlocked) { unlocked = true; emit(); }
  // Smooth fade-in after (re)start. The gate opens RESUME_HOLD late: whatever was frozen in the
  // graph at suspend (e.g. a reverb tail) plays out silently instead of as a stale blip.
  if (enabled && !isHidden()) rt.fade(1, RESUME_HOLD);
  syncBed();
  const p = pending;
  pending = null;
  if (p && enabled && !isHidden() && now() - p.at < PENDING_MS) {
    try { rt.play(p.name, p.opts, rt.ctx.currentTime + LOOKAHEAD + RESUME_HOLD); } catch { /* ignore */ }
  }
}

function markUnlocked() {
  if (unlocked) return;
  unlocked = true;
  emit();
}

function onGesture(e) {
  try {
    if (!activationOK()) return; // e.g. Escape keydown or touch pointerdown: not a user activation
    if (rt && rt.ctx.state === 'running') return; // steady state: nothing to do
    if (!unlocked && e) unlockGestureAt = now();
    if (!enabled) { markUnlocked(); return; } // context is created later, when sound gets enabled
    if (!ensureEngine()) { markUnlocked(); return; } // no WebAudio: nothing to wait for
    resumeCtx();
  } catch { /* never throw from a global listener */ }
}

function onVisibility() {
  try {
    if (!rt) {
      bootAttempt(); // a page opened in a background tab tries once it is first shown
      return;
    }
    clearTimeout(hideTimer);
    if (isHidden()) {
      rt.fade(0, 0, 0.01);
      hideTimer = setTimeout(() => {
        if (rt && isHidden() && rt.ctx.state === 'running') suspendCtx();
      }, 80);
    } else if (enabled && (unlocked || activationOK())) {
      resumeCtx(); // gate fades back in once running (onCtxState)
    }
  } catch { /* ignore */ }
}

/** Harmless retry when the window regains focus (e.g. an iOS context left "interrupted"). */
function onFocus() {
  try {
    if (!enabled || !rt || rt.ctx.state === 'running' || isHidden() || !activationOK()) return;
    resumeCtx();
  } catch { /* ignore */ }
}

/** The browser's verdict for Web Audio where it can be asked up front (Firefox 112+); null = unknown. */
function autoplayPolicy() {
  try {
    if (!hasDOM || typeof navigator.getAutoplayPolicy !== 'function') return null;
    return navigator.getAutoplayPolicy('audiocontext');
  } catch { return null; }
}

function markRefused() {
  if (refused || unlocked) return;
  refused = true;
  emit();
}

/**
 * Sound as early as possible: create the context now and ask it to run. Where the browser allows
 * audio without a gesture it is 'running' at once (Chrome reports it synchronously) and sound plays
 * from the first beat. Otherwise it stays suspended until onGesture() resumes it, and `blocked`
 * turns true (the "sound" hint). A policy answer of "disallowed" skips creating a context that would
 * only be refused (and logged); the first gesture creates it instead. Hidden tabs wait until shown.
 */
function bootAttempt() {
  try {
    if (!enabled || !AC || rt || unlocked || isHidden()) return;
    const policy = autoplayPolicy();
    if (policy && policy !== 'allowed') { markRefused(); return; }
    if (!ensureEngine()) { markUnlocked(); return; } // WebAudio unusable: nothing to wait for
    resumeCtx();
    if (rt.ctx.state === 'running') return;
    clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      if (rt && rt.ctx.state !== 'running') markRefused();
    }, PROBE_MS);
  } catch { /* never throw */ }
}

function syncBed() {
  try {
    if (!rt || !bedWant.on || rt.bed || !enabled || isHidden() || rt.ctx.state !== 'running') return;
    rt.bedStart(bedWant.p, rt.ctx.currentTime + LOOKAHEAD);
  } catch { /* ignore */ }
}

function init() {
  if (inited || !hasDOM) return;
  inited = true;
  const opts = { capture: true, passive: true };
  // The activation-granting events (HTML "activation triggering input events": keydown other than
  // Esc, mousedown, pointerdown for mice, pointerup / touchend for touch and pen) plus click as a
  // late safety net. Kept installed: they also recover iOS "interrupted" contexts.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'keydown', 'touchend', 'click']) {
    window.addEventListener(type, onGesture, opts);
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  // already activated earlier (e.g. module loaded late): unlock without waiting for another gesture
  if (navigator.userActivation && navigator.userActivation.hasBeenActive) onGesture(null);
  bootAttempt();
}

function setEnabled(value) {
  try {
    const v = !!value;
    if (v === enabled) return enabled;
    enabled = v;
    writePref();
    clearTimeout(suspendTimer);
    if (v) {
      if (unlocked || activationOK()) {
        if (ensureEngine()) resumeCtx(); else markUnlocked();
      } else {
        bootAttempt(); // enabled without a gesture: try, and report `blocked` if refused
      }
    } else if (rt) {
      // short delay so a 'toggleOff' played right before this call is still heard, then fade + suspend
      rt.fade(0, 0.12, 0.04);
      suspendTimer = setTimeout(() => {
        if (!enabled && rt && rt.ctx.state === 'running') {
          // End what is still sounding (the gate is already closed) so unmuting later never
          // resumes a frozen tail of stale build audio.
          const t = rt.ctx.currentTime;
          for (const v of rt.voices) v.kill(t);
          rt.voices = [];
          suspendCtx();
        }
      }, 450);
    }
    emit();
  } catch { /* ignore */ }
  return enabled;
}

export const sfx = {
  init,
  /** true once audio is allowed: the context runs (with or without a gesture), or a gesture happened while sound was disabled. */
  get unlocked() { return unlocked; },
  /** true only while sound is on but the browser is known to refuse audio until a gesture (show the hint). */
  get blocked() { return isBlocked(); },
  get enabled() { return enabled; },
  /** false when the browser has no WebAudio at all (everything stays a silent no-op). */
  get supported() { return !!AC; },
  setEnabled,
  /**
   * Flip the preference. Grace rule: if this very interaction is the one that just unlocked audio
   * (e.g. the visitor's first click lands on the pulsing sound button while sound is ON-but-locked),
   * keep sound on instead of muting, since they clicked to hear it. Returns the new enabled value.
   * { feedback: true } also plays the matching chirp (toggleOn / toggleOff), chosen after the rule,
   * so every sound button (nav, HUD, M key) shares one implementation.
   */
  toggle({ feedback = false } = {}) {
    if (enabled && now() - unlockGestureAt < GESTURE_GRACE_MS) {
      unlockGestureAt = -Infinity;
      emit();
      if (feedback) sfx.play('toggleOn'); // kept on: confirm it audibly
      return enabled;
    }
    // feedback = the matching chirp, chosen AFTER the rule above (never both chirps at once):
    // 'toggleOff' before muting (the gate closes 120 ms later, so it is still heard), 'toggleOn' after
    if (feedback && enabled) sfx.play('toggleOff');
    const v = setEnabled(!enabled);
    if (feedback && v) sfx.play('toggleOn');
    return v;
  },
  /** cb({ enabled, unlocked, blocked }) on every change; returns an unsubscribe function. */
  onChange(cb) {
    if (typeof cb !== 'function') return noop;
    subs.add(cb);
    return () => subs.delete(cb);
  },
  play(name, opts) {
    try {
      if (!inited) init();
      if (!enabled || !rt || isHidden()) return;
      const ctx = rt.ctx;
      if (ctx.state !== 'running') { // never queue more than one sound while suspended/resuming
        if (Object.prototype.hasOwnProperty.call(SOUNDS, name)) pending = { name, opts: opts || {}, at: now() };
        return;
      }
      rt.play(name, opts || {}, ctx.currentTime + LOOKAHEAD);
    } catch { /* never throw */ }
  },
  bed: {
    start() {
      if (!inited) init();
      bedWant.on = true;
      syncBed(); // otherwise starts (fading in) as soon as audio unlocks
    },
    setProgress(p) {
      bedWant.p = clamp(Number(p) || 0, 0, 1);
      try {
        if (rt && rt.bed && rt.ctx.state === 'running') rt.bedProgress(bedWant.p, rt.ctx.currentTime);
      } catch { /* ignore */ }
    },
    stop() {
      bedWant.on = false;
      try {
        if (rt && rt.bed) rt.bedStop(rt.ctx.currentTime, rt.ctx.state !== 'running');
      } catch { /* ignore */ }
    },
  },
};

/** Dev-only introspection of the real-time engine (voice stats, context state). */
export function sfxDebug() {
  return rt
    ? { state: rt.ctx.state, active: rt.voices.filter((v) => v.end > rt.ctx.currentTime).length, bed: !!rt.bed, stats: rt.stats }
    : { state: 'none' };
}

export default sfx;
