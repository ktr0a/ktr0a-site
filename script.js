const encoded1 = "&#111;&#117;&#108;&#103;&#110;&#97;&#105;&#113;"; 
const encoded2 = "&#101;&#116;&#97;&#118;&#105;&#114;&#112;&#46;";
const encoded3 = "&#109;&#111;&#99;&#46;&#108;&#105;&#97;&#109;&#103;&#64;";

// Caching
const GITHUB_USER = "ktr0a";
const CACHE_KEY = "github_repos_cache_v1";
const CACHE_TIME_KEY = "github_repos_cache_time_v1";

const YT_CHANNEL_ID = "UC8hnH4AKJvODl9SK6bJu3pw";

const YT_CACHE_KEY = "yt_stats_cache_v1";
const YT_CACHE_TIME_KEY = "yt_stats_cache_time_v1";

// cache lifetime in milliseconds (30 minutes)
const CACHE_TTL = 10 * 60 * 1000;
const YT_CACHE_TTL = 6 * 60 * 60 * 1000;


function decode(html) {
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
}

const combined = decode(encoded3 + encoded2 + encoded1);
const email = combined.split("").reverse().join("");

const link = document.getElementById("email-link");
if (link) {
  link.href = "mailto:" + email;
  link.textContent = email; 
}

const projectConfigs = {
  "Finance-app": {
    title: "Finance Tracker CLI",
    description:
      "A modular Python command-line finance tracker with save/load, analysis tools, and an expandable architecture for future GUI/automation.",
  },
  "ktr0a-site": {
    title: "QLuo.dev",
    description:
      "Portfolio Website",
  },
  "TeachFlow-DevFest-AI-Hackathon-2025-": {
    title: "TeachFlow - DevFest 2025",
    description:
      "An AI-powered grading assistant that helps educators provide structured, consistent feedback on student essays. \nBuilt in ~7h at DevFest Linz - AI Hackathon 2025.",
  },
};


// fetch from cache
async function fetchGitHubReposWithCache() {
  const cached = localStorage.getItem(CACHE_KEY);
  const cachedTime = localStorage.getItem(CACHE_TIME_KEY);

  const now = Date.now();

  if (cached && cachedTime && now - Number(cachedTime) < CACHE_TTL) {
    return JSON.parse(cached);
  }

  const res = await fetch(`https://api.github.com/users/${GITHUB_USER}/repos`);
  const data = await res.json();

  localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  localStorage.setItem(CACHE_TIME_KEY, now.toString());

  return data;
}


// Load Git Repos
async function loadGitHubProjects() {
  const container = document.getElementById("github-projects");

  try {
    const repos = await fetchGitHubReposWithCache();

    // Sort by last update 
    repos.sort(
      (a, b) => new Date(b.updated_at) - new Date(a.updated_at)
    );

    // Only include repos from projectConfigs
    const filtered = repos.filter((repo) => projectConfigs[repo.name]);

    container.innerHTML = "";

    filtered.forEach((repo) => {
      const cfg = projectConfigs[repo.name];

      const card = document.createElement("div");
      card.className = "card";

      card.innerHTML = `
        <h3>${cfg.title}</h3>
        <p>${cfg.description}</p>
        <p style="opacity:0.7; font-size:0.85rem; margin-top:0.5rem;">
          ${repo.language || "Unknown"}
        </p>
        <a href="${repo.html_url}" target="_blank"
           class="btn secondary"
           style="margin-top:0.8rem; display:inline-block;">
          View on GitHub
        </a>
      `;

      container.appendChild(card);
    });
  } catch (err) {
    container.innerHTML =
      "<p>Failed to load GitHub projects (rate limit or network error).</p>";
  }
}

loadGitHubProjects();


function formatCount(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return n;
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M+";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "k+";
  return num.toString();
}

// fetch from cache yt (via serverless proxy)
async function fetchYouTubeStatsWithCache() {
  const cached = localStorage.getItem(YT_CACHE_KEY);
  const cachedTime = localStorage.getItem(YT_CACHE_TIME_KEY);
  const now = Date.now();

  if (cached && cachedTime && now - Number(cachedTime) < YT_CACHE_TTL) {
    return JSON.parse(cached);
  }

  const res = await fetch("/api/youtube");

  if (!res.ok) {
    const text = await res.text();
    console.error("YouTube proxy HTTP error:", res.status, text);
    throw new Error("YouTube proxy error");
  }

  const stats = await res.json();
  console.log("YouTube stats from proxy:", stats);

  if (stats) {
    localStorage.setItem(YT_CACHE_KEY, JSON.stringify(stats));
    localStorage.setItem(YT_CACHE_TIME_KEY, now.toString());
  }

  return stats;
}


// Load YT stats
async function loadYouTubeStats() {
  const subsEl = document.getElementById("yt-subs");
  const vidsEl = document.getElementById("yt-videos");

  if (!subsEl || !vidsEl) return;

  try {
    const stats = await fetchYouTubeStatsWithCache();
    if (!stats) return;

    if (stats.subscriberCount) {
      subsEl.textContent = formatCount(stats.subscriberCount);
    }

    if (stats.videoCount) {
      vidsEl.textContent = formatCount(stats.videoCount);
    }
  } catch (e) {
    console.warn("Failed to load YouTube stats", e);
  }
}

loadYouTubeStats();
