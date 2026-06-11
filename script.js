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

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const FINE_POINTER   = window.matchMedia("(hover: hover) and (pointer: fine)").matches;


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
      lenis.scrollTo(target, { offset: -64 }); // account for nav height
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


/* ───────────────────────────────────────────────────────────────
   NAV — scrolled state + active section highlight
─────────────────────────────────────────────────────────────── */
const NAV_SECTIONS = ['projects', 'about', 'competitions', 'skills', 'contact'];
const navEl        = document.getElementById('nav');

const navLinkMap = {};
document.querySelectorAll('.nav-link[data-section]').forEach((link) => {
  navLinkMap[link.dataset.section] = link;
});

function updateNav() {
  // Frosted border once past the top
  if (navEl) navEl.classList.toggle('scrolled', window.scrollY > 24);

  // Trigger line: 35% down the viewport
  const scrollY = window.scrollY + window.innerHeight * 0.35;
  let current = null;

  NAV_SECTIONS.forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.offsetTop <= scrollY) current = id;
  });

  Object.entries(navLinkMap).forEach(([id, link]) => {
    link.classList.toggle('active', id === current);
  });
}

lenis.on('scroll', updateNav);
updateNav();


/* ───────────────────────────────────────────────────────────────
   THEME TOGGLE
─────────────────────────────────────────────────────────────── */
const themeToggle = document.getElementById('theme-toggle');

if (localStorage.getItem('theme') === 'light') {
  document.body.classList.add('light');
}

themeToggle.addEventListener('click', () => {
  const isLight = document.body.classList.toggle('light');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
});


/* ───────────────────────────────────────────────────────────────
   CUSTOM CURSOR — instant dot + trailing ring
─────────────────────────────────────────────────────────────── */
if (FINE_POINTER && !REDUCED_MOTION) {
  const cursor     = document.getElementById("cursor");
  const cursorRing = document.getElementById("cursor-ring");

  let mouseX = window.innerWidth / 2,  mouseY = window.innerHeight / 2;
  let ringX  = mouseX,                 ringY  = mouseY;

  document.addEventListener("mousemove", (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    cursor.style.transform = `translate(${mouseX}px, ${mouseY}px)`;
  });

  function animateRing() {
    ringX += (mouseX - ringX) * 0.16;
    ringY += (mouseY - ringY) * 0.16;
    cursorRing.style.transform = `translate(${ringX}px, ${ringY}px)`;
    requestAnimationFrame(animateRing);
  }
  animateRing();

  // Fade on window leave/enter
  document.addEventListener("mouseleave", () => {
    cursor.style.opacity = "0";
    cursorRing.style.opacity = "0";
  });
  document.addEventListener("mouseenter", () => {
    cursor.style.opacity = "1";
    cursorRing.style.opacity = "1";
  });

  // Ring grows over interactive elements
  const HOVER_SELECTOR = "a, button";
  document.addEventListener("mouseover", (e) => {
    if (e.target.closest(HOVER_SELECTOR)) document.body.classList.add("cursor-hover");
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest(HOVER_SELECTOR)) document.body.classList.remove("cursor-hover");
  });
}


/* ───────────────────────────────────────────────────────────────
   SPOTLIGHT CARDS — glow follows the mouse
─────────────────────────────────────────────────────────────── */
if (FINE_POINTER) {
  document.addEventListener("mousemove", (e) => {
    document.querySelectorAll(".spotlight").forEach((card) => {
      const rect = card.getBoundingClientRect();
      if (
        e.clientX < rect.left - 80 || e.clientX > rect.right + 80 ||
        e.clientY < rect.top - 80  || e.clientY > rect.bottom + 80
      ) return;
      card.style.setProperty("--mx", `${e.clientX - rect.left}px`);
      card.style.setProperty("--my", `${e.clientY - rect.top}px`);
    });
  });
}


/* ───────────────────────────────────────────────────────────────
   HERO — entrance + scroll-out
─────────────────────────────────────────────────────────────── */
if (!REDUCED_MOTION) {
  gsap.from(".reveal-hero", {
    opacity: 0,
    y: 34,
    duration: 0.9,
    ease: "power3.out",
    stagger: 0.1,
    delay: 0.15,
  });

  // Hero exit: content fades up as you scroll (scrubbed)
  gsap.to(".hero-content", {
    scrollTrigger: {
      trigger: "#hero",
      start: "top top",
      end: "bottom top",
      scrub: true,
    },
    opacity: 0,
    y: -70,
    ease: "none",
  });

  gsap.to(".hero-scroll-hint", {
    scrollTrigger: {
      trigger: "#hero",
      start: "top top",
      end: "20% top",
      scrub: true,
    },
    opacity: 0,
    ease: "none",
  });
}


/* ───────────────────────────────────────────────────────────────
   SCROLL ANIMATIONS — GSAP ScrollTrigger
─────────────────────────────────────────────────────────────── */
const revealDefaults = {
  opacity: 0,
  y: 30,
  duration: 0.7,
  ease: "power2.out",
};

function scrollReveal(targets, triggerEl, extra = {}) {
  if (REDUCED_MOTION) return;
  gsap.from(targets, {
    ...revealDefaults,
    scrollTrigger: {
      trigger: triggerEl,
      start: "top 82%",
      toggleActions: "play none none none",
    },
    ...extra,
  });
}

// Section headers
gsap.utils.toArray(".section-header").forEach((el) => {
  scrollReveal(el, el);
});

// Featured project cards
scrollReveal(".featured-card", ".featured-grid", { stagger: 0.12 });

// Timeline items — sequential
scrollReveal(".timeline-item", ".timeline", { duration: 0.5, stagger: 0.15 });

// Competition cards
scrollReveal(".comp-card", ".comp-list", { duration: 0.5, y: 20, stagger: 0.1 });

// Skills rows
scrollReveal(".skills-row", ".skills-block", { duration: 0.5, y: 20, stagger: 0.12 });

// Contact section
scrollReveal(".contact-inner > *", "#contact", { duration: 0.6, y: 20, stagger: 0.1 });

// GitHub grid (called after repos render)
function animateRepoCards() {
  const cards = document.querySelectorAll(".repo-card");
  if (!cards.length) return;
  if (!REDUCED_MOTION) {
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
  }
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
