/* ═══════════════════════════════════════════════════════════════════════════
   data.js: dynamic page content
     · email deobfuscation        → [data-email] hrefs, [data-email-text] text
     · GitHub repository cards    → #github-grid (+ `build:layers-added` event)
     · YouTube channel statistics → [data-yt="subs" | "views" | "videos"]

   Caching (localStorage, every access guarded; storage may be unavailable):
     'ktr0a:gh'  { t, repos }   10 min TTL, stale copy used when GitHub fails
     'ktr0a:yt'  { t, stats }   6 h TTL, or { t, fail:true } for 30 min after a failure

   Fresh cache hits are applied SYNCHRONOUSLY (before the returned promise's
   first await), so a caller that runs these before starting the build engine
   gets the final DOM into the engine's initial plan.
   ═══════════════════════════════════════════════════════════════════════════ */

const GITHUB_USER = "ktr0a";
const GH_URL = `https://api.github.com/users/${GITHUB_USER}/repos?per_page=100&sort=updated`;
const GH_KEY = "ktr0a:gh";
const GH_TTL = 10 * 60 * 1000;

const YT_URL = "/api/youtube";
const YT_KEY = "ktr0a:yt";
const YT_TTL = 6 * 60 * 60 * 1000;
const YT_FAIL_TTL = 30 * 60 * 1000;

const FETCH_TIMEOUT = 8000;

/** Never listed in the repo grid: the site itself, the profile README repo, and
 *  repos already featured as cards above the grid. Compared case-insensitively. */
const EXCLUDED_REPOS = new Set(
  ["ktr0a-site", "ktr0a", "Finance-app", "TeachFlow-DevFest-AI-Hackathon-2025-"].map((n) => n.toLowerCase())
);
const MAX_REPOS = 5; // + the profile card = two full rows at most
/** Scratch repos that read as filler next to the curated projects. */
const FILLER_NAME = /(^|[-_.\s])(test|tests|testing|demo|sandbox|playground|tmp|temp|scratch)([-_.\s]|$)/i;

/** GitHub linguist colours, nudged brighter where the original vanishes on #08080a. */
const LANG_COLORS = {
  Python: "#3572a5",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Kotlin: "#a97bff",
  Java: "#b07219",
  "C++": "#f34b7d",
  C: "#8a8f98",
  "C#": "#178600",
  Go: "#00add8",
  Rust: "#dea584",
  Swift: "#f05138",
  Dart: "#00b4ab",
  HTML: "#e34c26",
  CSS: "#8a63d2",
  SCSS: "#c6538c",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  Shell: "#89e051",
  PowerShell: "#5391fe",
  "Jupyter Notebook": "#da5b0b",
  Lua: "#5a6cff",
  Ruby: "#cc342d",
  PHP: "#7a86b8",
  Dockerfile: "#5b8fa8",
  TeX: "#3d9970",
};
const LANG_FALLBACK = "#9aa1ad"; // --text-2

/* ─────────────────────────────── helpers ─────────────────────────────── */

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && typeof value === "object" && Number.isFinite(value.t) ? value : null;
  } catch {
    return null;
  }
}

function writeCache(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), ...payload }));
  } catch {
    /* quota exceeded / storage disabled: caching is best-effort */
  }
}

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** fetch() + JSON with a hard timeout, so a hanging request never keeps a loading state forever. */
async function fetchJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: "omit" });
    if (!res.ok) throw new HttpError(res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Tell the build engine new [data-layer] nodes exist (SPEC §4). */
export function announceLayers(root) {
  document.dispatchEvent(new CustomEvent("build:layers-added", { detail: { root } }));
}

const defaultSetText = (el, text) => {
  el.textContent = text;
};

/* ─────────────────────────────── email ─────────────────────────────── */

// The address is stored as HTML entities, split in three and reversed, so it never
// appears in the page source as plain text (logic preserved from the original site).
const ENCODED_1 = "&#111;&#117;&#108;&#103;&#110;&#97;&#105;&#113;";
const ENCODED_2 = "&#101;&#116;&#97;&#118;&#105;&#114;&#112;&#46;";
const ENCODED_3 = "&#109;&#111;&#99;&#46;&#108;&#105;&#97;&#109;&#103;&#64;";

export function decodeEmail() {
  const combined = (ENCODED_3 + ENCODED_2 + ENCODED_1).replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(Number(code))
  );
  return [...combined].reverse().join("");
}

/** Fills every [data-email] anchor's href and every [data-email-text] element's text. */
export function applyEmail(root = document) {
  const email = decodeEmail();
  for (const link of root.querySelectorAll("[data-email]")) {
    if (link instanceof HTMLAnchorElement) link.href = `mailto:${email}`;
  }
  for (const el of root.querySelectorAll("[data-email-text]")) el.textContent = email;
  return email;
}

/* ─────────────────────────────── GitHub ─────────────────────────────── */

/** Keep only the fields the cards need (smaller cache, no surprise payload growth). */
const slimRepo = (r) => ({
  name: r.name,
  html_url: r.html_url,
  description: r.description,
  language: r.language,
  stargazers_count: r.stargazers_count,
  updated_at: r.updated_at,
  fork: r.fork,
});

const isRepoUrl = (url) => typeof url === "string" && url.startsWith("https://github.com/");

/**
 * Repos worth showing: own (no forks), described, not scratch/test repos, best first. The count
 * is chosen so that, together with the trailing profile card, the cards fill whole rows of the
 * 3-column grid (1, 2, 3 or 6 cards): no half-empty row next to the curated projects.
 */
export function selectRepos(repos) {
  const time = (r) => Date.parse(r.updated_at) || 0;
  const list = (Array.isArray(repos) ? repos : [])
    .filter((r) => r && typeof r.name === "string" && !r.fork && isRepoUrl(r.html_url))
    .filter((r) => !EXCLUDED_REPOS.has(r.name.toLowerCase()))
    .filter((r) => String(r.description || "").trim() && !FILLER_NAME.test(r.name))
    .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0) || time(b) - time(a));
  const n = list.length >= MAX_REPOS ? MAX_REPOS : list.length >= 2 ? 2 : list.length;
  return list.slice(0, n);
}

/** "Tailscale_device_connection" → "Tailscale device connection" (the link keeps the real name). */
const displayName = (name) => String(name).replace(/_+/g, " ").trim();

const monthFormat = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

function formatMonth(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? monthFormat.format(ms) : "recently";
}

/** One repo card. Markup is a fixed contract with style.css and the build engine. */
export function repoCardHTML(repo) {
  const stars = Number(repo.stargazers_count) || 0;
  const language = repo.language || "Other";
  const color = LANG_COLORS[repo.language] || LANG_FALLBACK;
  return (
    `<a class="repo-card" href="${escapeHTML(repo.html_url)}" target="_blank" rel="noopener noreferrer" data-layer="box">` +
    `<span class="repo-top"><span class="repo-name" data-layer="text">${escapeHTML(displayName(repo.name))}</span>` +
    (stars > 0 ? `<span class="repo-stars">★ ${stars}</span>` : "") +
    `</span>` +
    `<span class="repo-desc" data-layer="text">${escapeHTML(String(repo.description || "").trim())}</span>` +
    `<span class="repo-foot"><span class="repo-lang" data-layer="chip"><i class="lang-dot" style="--c:${color}"></i>${escapeHTML(language)}</span>` +
    `<span class="repo-updated mono-label">updated ${escapeHTML(formatMonth(repo.updated_at))}</span></span>` +
    `</a>`
  );
}

/** Always the last card: everything else (coursework, experiments) lives on the profile. */
function profileCardHTML(more) {
  return (
    `<a class="repo-card repo-card--profile" href="https://github.com/${GITHUB_USER}" target="_blank" rel="noopener noreferrer" data-layer="box">` +
    `<span class="repo-top"><span class="repo-name" data-layer="text">${more ? "All repositories" : `github.com/${GITHUB_USER}`}</span></span>` +
    `<span class="repo-desc" data-layer="text">Coursework, experiments and small tools live on my GitHub profile.</span>` +
    `<span class="repo-foot"><span class="repo-lang" data-layer="chip"><i class="lang-dot" style="--c:${LANG_FALLBACK}"></i>Profile</span>` +
    `<span class="repo-updated mono-label">open profile ↗</span></span>` +
    `</a>`
  );
}

/**
 * Replaces the grid content (incl. the `.repo-loading` placeholder) with repo cards plus the
 * profile card, then announces the new layers. Returns the number of repo cards rendered.
 */
export function renderRepos(grid, repos, { notify = announceLayers } = {}) {
  const list = selectRepos(repos);
  const tpl = document.createElement("template");
  tpl.innerHTML = list.map(repoCardHTML).join("") + profileCardHTML(list.length > 0);
  grid.replaceChildren(tpl.content);
  try {
    notify?.(grid);
  } catch (err) {
    console.warn("[data] layers-added notify failed:", err);
  }
  return list.length;
}

/**
 * Loads and renders the repo grid. Renders exactly once per call.
 * @returns {Promise<{source:'cache'|'network'|'stale'|'none'|'missing', count:number}>}
 */
export async function loadGitHubRepos({ grid = document.getElementById("github-grid"), notify } = {}) {
  if (!grid) return { source: "missing", count: 0 };

  const cached = readCache(GH_KEY);
  const cachedRepos = Array.isArray(cached?.repos) ? cached.repos : null;
  if (cachedRepos && Date.now() - cached.t < GH_TTL) {
    return { source: "cache", count: renderRepos(grid, cachedRepos, { notify }) }; // synchronous path
  }

  try {
    const data = await fetchJSON(GH_URL);
    if (!Array.isArray(data)) throw new Error("unexpected payload");
    const repos = data.map(slimRepo);
    writeCache(GH_KEY, { repos });
    return { source: "network", count: renderRepos(grid, repos, { notify }) };
  } catch (err) {
    console.warn("[data] GitHub repos unavailable:", err?.message || err);
    return { source: cachedRepos ? "stale" : "none", count: renderRepos(grid, cachedRepos || [], { notify }) };
  }
}

/* ─────────────────────────────── YouTube ─────────────────────────────── */

/** 950 → "950", 12 345 → "12.3k+", 160 345 → "160k+", 13 712 004 → "13.7M+". Always rounds down. */
export function formatCount(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return "";
  const scaled = (unit, suffix) => {
    const v = n / unit;
    const shown = v >= 100 ? Math.floor(v) : Math.floor(v * 10) / 10;
    return `${shown}${suffix}+`;
  };
  if (n >= 1e9) return scaled(1e9, "B");
  if (n >= 1e6) return scaled(1e6, "M");
  if (n >= 1e3) return scaled(1e3, "k");
  return String(n);
}

const formatPlain = (value) => Math.floor(Number(value)).toLocaleString("en-US");

const YT_FIELDS = {
  subs: { key: "subscriberCount", format: formatCount },
  views: { key: "viewCount", format: formatCount },
  videos: { key: "videoCount", format: formatPlain },
};

function slimStats(s) {
  return {
    subscriberCount: s.subscriberCount,
    viewCount: s.viewCount,
    videoCount: s.videoCount,
    hiddenSubscriberCount: !!s.hiddenSubscriberCount,
  };
}

const isStats = (s) => !!s && typeof s === "object" && ["subscriberCount", "viewCount", "videoCount"].some((k) => Number(s[k]) > 0);

function applyStats(stats, targets, setText) {
  for (const el of targets) {
    const field = YT_FIELDS[el.dataset.yt];
    if (!field) continue;
    if (field.key === "subscriberCount" && stats.hiddenSubscriberCount) continue;
    const n = Number(stats[field.key]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const text = field.format(n);
    if (text && el.textContent.trim() !== text) setText(el, text);
    // a stat without a baked-in default (videos) stays hidden until a real number exists
    el.closest("[data-yt-optional][hidden]")?.removeAttribute("hidden");
  }
}

/** The proxy is a Vercel function. Plain static servers on localhost (e.g. `python -m http.server`)
 *  don't have it, so skip the request there instead of logging a 404; `vercel dev` (port 3000) does. */
function proxyAvailable() {
  if (!location.protocol.startsWith("http")) return false;
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);
  return !local || location.port === "3000";
}

/**
 * Fills [data-yt] elements with live channel stats. The HTML defaults stay when nothing
 * is available. Cached values (even stale) are applied synchronously.
 * @param {{ setText?: (el:Element, text:string) => void, root?: ParentNode }} [options]
 *   setText lets the caller defer writes that would land inside a layer being built.
 */
export async function loadYouTubeStats({ setText = defaultSetText, root = document } = {}) {
  const targets = [...root.querySelectorAll("[data-yt]")];
  if (!targets.length) return null;

  const cached = readCache(YT_KEY);
  const cachedStats = isStats(cached?.stats) ? cached.stats : null;
  if (cachedStats) applyStats(cachedStats, targets, setText); // newest known values, even if stale

  const age = cached ? Date.now() - cached.t : Infinity;
  if (cachedStats ? age < YT_TTL : cached?.fail && age < YT_FAIL_TTL) return cachedStats;
  if (!proxyAvailable()) return cachedStats;

  try {
    const stats = await fetchJSON(YT_URL);
    if (!isStats(stats)) throw new Error("unexpected payload");
    const slim = slimStats(stats);
    writeCache(YT_KEY, { stats: slim });
    applyStats(slim, targets, setText);
    return slim;
  } catch (err) {
    // The HTML defaults remain. Back off only on a definitive answer (HTTP error, e.g. missing key or
    // quota, or a bad payload incl. a non-JSON body), never on transient network errors or a reload
    // aborting the request.
    const definitive = err instanceof HttpError || err instanceof SyntaxError || err?.message === "unexpected payload";
    if (definitive && !cachedStats) writeCache(YT_KEY, { fail: true });
    console.debug("[data] YouTube stats unavailable:", err?.message || err);
    return cachedStats;
  }
}
