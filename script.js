/* ═══════════════════════════════════════════════════════════════
   ktr0a — portfolio script.js
   Stack: Lenis + GSAP ScrollTrigger + vanilla JS
═══════════════════════════════════════════════════════════════ */

/* ───────────────────────────────────────────────────────────────
   CONFIG
─────────────────────────────────────────────────────────────── */
const GITHUB_USER        = "ktr0a";
const GH_CACHE_KEY       = "gh_repos_v2";
const GH_CACHE_TIME_KEY  = "gh_repos_time_v2";
const GH_CACHE_TTL       = 10 * 60 * 1000;     // 10 min

const YT_CACHE_KEY       = "yt_stats_v2";
const YT_CACHE_TIME_KEY  = "yt_stats_time_v2";
const YT_CACHE_TTL       = 6 * 60 * 60 * 1000; // 6 hours


/* ───────────────────────────────────────────────────────────────
   EMAIL OBFUSCATION  (logic preserved from original script.js)
─────────────────────────────────────────────────────────────── */
const encoded1 = "&#111;&#117;&#108;&#103;&#110;&#97;&#105;&#113;";
const encoded2 = "&#101;&#116;&#97;&#118;&#105;&#114;&#112;&#46;";
const encoded3 = "&#109;&#111;&#99;&#46;&#108;&#105;&#97;&#109;&#103;&#64;";

function decode(html) {
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
}

const combined = decode(encoded3 + encoded2 + encoded1);
const email    = combined.split("").reverse().join("");

const emailLink = document.getElementById("email-link");
if (emailLink) {
  emailLink.href        = "mailto:" + email;
  emailLink.textContent = email;
}


/* ───────────────────────────────────────────────────────────────
   SMOOTH SCROLL — Lenis
─────────────────────────────────────────────────────────────── */
const lenis = new Lenis({
  duration: 1.2,
  easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
});

// Anchor <a href="#..."> links work with Lenis
document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener("click", (e) => {
    const target = document.querySelector(anchor.getAttribute("href"));
    if (target) {
      e.preventDefault();
      lenis.scrollTo(target, { offset: -72 }); // account for nav height
    }
  });
});


/* ───────────────────────────────────────────────────────────────
   GSAP — register ScrollTrigger, hook to Lenis
─────────────────────────────────────────────────────────────── */
gsap.registerPlugin(ScrollTrigger);

lenis.on("scroll", ScrollTrigger.update);

gsap.ticker.add((time) => { lenis.raf(time * 1000); });
gsap.ticker.lagSmoothing(0);

// Drive Lenis via rAF (separate from GSAP ticker to avoid double-call)
// Using the standard pattern from Lenis docs for GSAP integration
function lenisRaf(time) {
  // lenis.raf is called via gsap.ticker above; this rAF keeps it running
  requestAnimationFrame(lenisRaf);
}
requestAnimationFrame(lenisRaf);


/* ───────────────────────────────────────────────────────────────
   NAV — active section highlight on scroll
─────────────────────────────────────────────────────────────── */
const NAV_SECTIONS  = ['projects', 'about', 'competitions', 'skills', 'contact'];
const navWordmark   = document.querySelector('.nav-wordmark');

const navLinkMap = {};
document.querySelectorAll('.nav-link[data-section]').forEach((link) => {
  navLinkMap[link.dataset.section] = link;
});

function updateActiveNav() {
  // Trigger line: 35% down the viewport
  const scrollY = window.scrollY + window.innerHeight * 0.35;
  let current = null;

  NAV_SECTIONS.forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.offsetTop <= scrollY) current = id;
  });

  // Nav links
  Object.entries(navLinkMap).forEach(([id, link]) => {
    link.classList.toggle('active', id === current);
  });

  // "me" wordmark — active when no section has been scrolled into yet (hero)
  if (navWordmark) navWordmark.classList.toggle('active', current === null);
}

// Hook into Lenis scroll for smooth sync
lenis.on('scroll', updateActiveNav);
updateActiveNav();


/* ───────────────────────────────────────────────────────────────
   THEME TOGGLE
─────────────────────────────────────────────────────────────── */
const themeToggle = document.getElementById('theme-toggle');

// Restore saved preference
if (localStorage.getItem('theme') === 'light') {
  document.body.classList.add('light');
  themeToggle.textContent = '☾';
}

themeToggle.addEventListener('click', () => {
  const isLight = document.body.classList.toggle('light');
  themeToggle.textContent = isLight ? '☾' : '☀';
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
});


/* ───────────────────────────────────────────────────────────────
   CUSTOM CURSOR — dot with motion blur + blend-contrast ring
─────────────────────────────────────────────────────────────── */
const cursor        = document.getElementById("cursor");
const cursorBlend   = document.getElementById("cursor-blend");
const blurNode      = document.getElementById("cursor-gaussian");
const DOT_RADIUS    = 5.5;  // half of 11px dot
const BLEND_RADIUS  = 11;   // half of 22px blend overlay

let mouseX = window.innerWidth  / 2;
let mouseY = window.innerHeight / 2;
let prevMouseX = mouseX;
let prevMouseY = mouseY;

// Blur amount that decays each rAF frame
let blurX = 0;
let blurY = 0;

document.addEventListener("mousemove", (e) => {
  prevMouseX = mouseX;
  prevMouseY = mouseY;
  mouseX = e.clientX;
  mouseY = e.clientY;

  // Velocity → directional blur
  const vx = mouseX - prevMouseX;
  const vy = mouseY - prevMouseY;
  blurX = Math.min(Math.abs(vx) * 0.45, 10);
  blurY = Math.min(Math.abs(vy) * 0.45, 10);

  cursor.style.transform      = `translate(${mouseX - DOT_RADIUS}px,  ${mouseY - DOT_RADIUS}px)`;
  if (cursorBlend) cursorBlend.style.transform = `translate(${mouseX - BLEND_RADIUS}px, ${mouseY - BLEND_RADIUS}px)`;
});

// Fade on window leave/enter
document.addEventListener("mouseleave", () => {
  cursor.style.opacity = "0";
  if (cursorBlend) cursorBlend.style.opacity = "0";
});
document.addEventListener("mouseenter", () => {
  cursor.style.opacity = "1";
  if (cursorBlend) cursorBlend.style.opacity = cursorBlend.classList.contains('active') ? "1" : "0";
});

// Each rAF: decay motion blur back to 0
function animateCursor() {
  blurX *= 0.78;
  blurY *= 0.78;
  const bx = blurX < 0.05 ? 0 : blurX;
  const by = blurY < 0.05 ? 0 : blurY;
  if (blurNode) blurNode.setAttribute("stdDeviation", `${bx.toFixed(2)} ${by.toFixed(2)}`);
  requestAnimationFrame(animateCursor);
}
animateCursor();

// Blend-contrast: activate on buttons whose bg matches cursor color
document.addEventListener("mouseover", (e) => {
  if (e.target.closest(".btn-primary") && cursorBlend) {
    cursorBlend.classList.add("active");
  }
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest(".btn-primary") && cursorBlend) {
    cursorBlend.classList.remove("active");
  }
});


/* ───────────────────────────────────────────────────────────────
   HERO — reactive parallax on mousemove
─────────────────────────────────────────────────────────────── */
const heroBg      = document.getElementById("hero-bg");
const heroSection = document.getElementById("hero");

let heroTargetX  = 0, heroTargetY  = 0;
let heroCurrentX = 0, heroCurrentY = 0;

heroSection.addEventListener("mousemove", (e) => {
  heroTargetX = (e.clientX / window.innerWidth  - 0.5) * 30;
  heroTargetY = (e.clientY / window.innerHeight - 0.5) * 30;
});

heroSection.addEventListener("mouseleave", () => {
  heroTargetX = 0;
  heroTargetY = 0;
});

function animateHeroParallax() {
  heroCurrentX += (heroTargetX - heroCurrentX) * 0.06;
  heroCurrentY += (heroTargetY - heroCurrentY) * 0.06;
  if (heroBg) {
    heroBg.style.transform = `translate(${heroCurrentX}px, ${heroCurrentY}px) scale(1.1)`;
  }
  requestAnimationFrame(animateHeroParallax);
}
animateHeroParallax();

// Hero exit: content fades up, bg zooms out slightly (scrubbed)
gsap.to(".hero-content", {
  scrollTrigger: {
    trigger: "#hero",
    start: "top top",
    end: "bottom top",
    scrub: true,
  },
  opacity: 0,
  y: -60,
  ease: "none",
});

gsap.to("#hero-bg", {
  scrollTrigger: {
    trigger: "#hero",
    start: "top top",
    end: "bottom top",
    scrub: true,
  },
  scale: 1.18, // adds to the base scale(1.1) set by parallax
  ease: "none",
});

gsap.to(".hero-scroll-hint", {
  scrollTrigger: {
    trigger: "#hero",
    start: "top top",
    end: "25% top",
    scrub: true,
  },
  opacity: 0,
  ease: "none",
});


/* ───────────────────────────────────────────────────────────────
   SCROLL ANIMATIONS — GSAP ScrollTrigger
─────────────────────────────────────────────────────────────── */
const revealDefaults = {
  opacity: 0,
  y: 30,
  duration: 0.7,
  ease: "power2.out",
};

// Section headings — skip #projects heading (already visible on load)
gsap.utils.toArray(".section-heading").forEach((el) => {
  if (el.closest("#projects")) return; // handled below
  gsap.from(el, {
    ...revealDefaults,
    scrollTrigger: {
      trigger: el,
      start: "top 82%",
      toggleActions: "play none none none",
    },
  });
});

// Projects heading + featured cards: already in viewport on load,
// so animate immediately without a ScrollTrigger
gsap.from("#projects .section-heading", {
  ...revealDefaults,
  delay: 0.1,
});

gsap.from(".featured-card", {
  ...revealDefaults,
  delay: 0.2,
  stagger: 0,
});

// Timeline items — sequential
gsap.from(".timeline-item", {
  ...revealDefaults,
  duration: 0.5,
  scrollTrigger: {
    trigger: ".timeline",
    start: "top 80%",
    toggleActions: "play none none none",
  },
  stagger: 0.15,
});

// Competition cards
gsap.from(".comp-card", {
  ...revealDefaults,
  duration: 0.5,
  y: 20,
  scrollTrigger: {
    trigger: ".comp-list",
    start: "top 80%",
    toggleActions: "play none none none",
  },
  stagger: 0.1,
});

// Skills rows
gsap.from(".skills-row", {
  ...revealDefaults,
  duration: 0.5,
  y: 20,
  scrollTrigger: {
    trigger: ".skills-block",
    start: "top 80%",
    toggleActions: "play none none none",
  },
  stagger: 0.12,
});

// Contact section
gsap.from(".contact-inner > *", {
  opacity: 0,
  y: 20,
  duration: 0.6,
  ease: "power2.out",
  scrollTrigger: {
    trigger: "#contact",
    start: "top 80%",
    toggleActions: "play none none none",
  },
  stagger: 0.1,
});

// GitHub grid (called after repos render)
function animateRepoCards() {
  const cards = document.querySelectorAll(".repo-card");
  if (!cards.length) return;
  gsap.from(cards, {
    opacity: 0,
    y: 24,
    duration: 0.45,
    ease: "power2.out",
    scrollTrigger: {
      trigger: "#github-grid",
      start: "top 85%",
      toggleActions: "play none none none",
    },
    stagger: 0, // all cards enter as aligned rows, no staircase
  });
  ScrollTrigger.refresh();
}


/* ───────────────────────────────────────────────────────────────
   GITHUB REPOS GRID
─────────────────────────────────────────────────────────────── */
async function fetchGitHubRepos() {
  try {
    const cached     = localStorage.getItem(GH_CACHE_KEY);
    const cachedTime = localStorage.getItem(GH_CACHE_TIME_KEY);
    const now        = Date.now();

    if (cached && cachedTime && now - Number(cachedTime) < GH_CACHE_TTL) {
      return JSON.parse(cached);
    }

    const res = await fetch(
      `https://api.github.com/users/${GITHUB_USER}/repos?per_page=100&sort=updated`
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);

    const data = await res.json();
    localStorage.setItem(GH_CACHE_KEY, JSON.stringify(data));
    localStorage.setItem(GH_CACHE_TIME_KEY, String(now));
    return data;
  } catch (err) {
    console.error("GitHub fetch failed:", err);
    const fallback = localStorage.getItem(GH_CACHE_KEY);
    return fallback ? JSON.parse(fallback) : [];
  }
}

async function loadGitHubGrid() {
  const grid = document.getElementById("github-grid");
  if (!grid) return;

  const repos = await fetchGitHubRepos();

  // Exclude the site repo and forks; sort by stars desc, then by last update
  const filtered = repos
    .filter((r) => r.name !== "ktr0a-site" && !r.fork)
    .sort((a, b) =>
      b.stargazers_count - a.stargazers_count ||
      new Date(b.updated_at) - new Date(a.updated_at)
    );

  grid.innerHTML = "";

  if (!filtered.length) {
    grid.innerHTML = '<p class="loading-text">No repos found.</p>';
    return;
  }

  filtered.forEach((repo) => {
    const card = document.createElement("div");
    card.className = "repo-card";

    const stars = repo.stargazers_count > 0
      ? `<span class="repo-stars">★ ${repo.stargazers_count}</span>`
      : "";

    card.innerHTML = `
      <div class="repo-card-top">
        <a href="${repo.html_url}" target="_blank" rel="noopener noreferrer" class="repo-name">${repo.name}</a>
        ${stars}
      </div>
      <p class="repo-desc">${repo.description || "No description provided."}</p>
      ${repo.language ? `<span class="repo-lang">${repo.language}</span>` : ""}
    `;

    grid.appendChild(card);
  });

  // Trigger scroll animation after DOM update
  animateRepoCards();
}

loadGitHubGrid();


/* ───────────────────────────────────────────────────────────────
   YOUTUBE STATS  (logic preserved from original script.js)
─────────────────────────────────────────────────────────────── */
function formatCount(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return n;
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M+";
  if (num >= 1_000)     return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "k+";
  return num.toString();
}

async function fetchYouTubeStats() {
  const cached     = localStorage.getItem(YT_CACHE_KEY);
  const cachedTime = localStorage.getItem(YT_CACHE_TIME_KEY);
  const now        = Date.now();

  if (cached && cachedTime && now - Number(cachedTime) < YT_CACHE_TTL) {
    return JSON.parse(cached);
  }

  const res = await fetch("/api/youtube");
  if (!res.ok) {
    const text = await res.text();
    console.error("YouTube proxy error:", res.status, text);
    throw new Error("YouTube proxy error");
  }

  const stats = await res.json();
  if (stats) {
    localStorage.setItem(YT_CACHE_KEY, JSON.stringify(stats));
    localStorage.setItem(YT_CACHE_TIME_KEY, String(now));
  }
  return stats;
}

async function loadYouTubeStats() {
  const subsEl = document.getElementById("yt-subs");
  const vidsEl = document.getElementById("yt-videos");
  if (!subsEl && !vidsEl) return;

  try {
    const stats = await fetchYouTubeStats();
    if (!stats) return;
    if (stats.subscriberCount && subsEl) subsEl.textContent = formatCount(stats.subscriberCount);
    if (stats.videoCount      && vidsEl) vidsEl.textContent = formatCount(stats.videoCount);
  } catch (e) {
    console.warn("YouTube stats unavailable:", e);
    // Default text is already in the HTML ("160k+") so no fallback needed
  }
}

loadYouTubeStats();
