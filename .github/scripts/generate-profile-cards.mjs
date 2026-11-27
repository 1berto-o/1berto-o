#!/usr/bin/env node
/**
 * Regenerates assets/{activity,stats,languages}.svg from the GitHub API.
 * Source of truth: GraphQL contributionCalendar + REST repo languages.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const login = process.env.GITHUB_USER || "1berto-o";
if (!token) {
  console.error("Missing GITHUB_TOKEN / GH_TOKEN");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const assetsDir = join(root, "assets");

const gh = async (path, { method = "GET", body } = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "1berto-o-profile-cards",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
};

const graphql = async (query, variables = {}) => {
  const json = await gh("/graphql", { method: "POST", body: { query, variables } });
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.data;
};

const escapeXml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

async function fetchContributionMonths() {
  const data = await graphql(
    `query($login:String!){
      user(login:$login){
        contributionsCollection{
          contributionCalendar{
            totalContributions
            weeks{ contributionDays{ date contributionCount } }
          }
        }
      }
    }`,
    { login },
  );
  const cal = data.user.contributionsCollection.contributionCalendar;
  const days = cal.weeks.flatMap((w) => w.contributionDays);

  // Last 12 calendar months ending at the latest day in the contribution grid.
  const lastDate = days[days.length - 1].date; // YYYY-MM-DD
  const end = new Date(`${lastDate}T00:00:00Z`);
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const sum = days
      .filter((x) => x.date.startsWith(key))
      .reduce((a, x) => a + x.contributionCount, 0);
    months.push({ key, label: MONTH_LABELS[d.getUTCMonth()], count: sum });
  }

  return { total: cal.totalContributions, months, days };
}

async function fetchUserStats() {
  const user = await gh("/user");
  return {
    followers: user.followers,
    publicRepos: user.public_repos,
    login: user.login,
  };
}

async function fetchTopLanguages() {
  const repos = await gh("/user/repos?per_page=100&affiliation=owner");
  const publicOwned = repos.filter(
    (r) => r.owner?.login === login && !r.fork && !r.private,
  );
  const totals = new Map();
  for (const repo of publicOwned) {
    const langs = await gh(`/repos/${repo.full_name}/languages`);
    for (const [name, bytes] of Object.entries(langs)) {
      totals.set(name, (totals.get(name) || 0) + bytes);
    }
  }
  const totalBytes = [...totals.values()].reduce((a, b) => a + b, 0) || 1;
  return [...totals.entries()]
    .map(([name, bytes]) => ({
      name,
      bytes,
      pct: Math.round((100 * bytes) / totalBytes),
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 4)
    .map((x, i, arr) => {
      // Fix rounding so top entries sum close to 100 when only a few langs
      if (i === arr.length - 1 && arr.length > 0) {
        const others = arr.slice(0, -1).reduce((s, y) => s + y.pct, 0);
        // keep displayed pct as-is; no forced adjust needed for top-4 of many
      }
      return x;
    });
}

function renderActivity({ total, months }) {
  const max = Math.max(1, ...months.map((m) => m.count));
  const barMaxH = 90;
  const baseY = 180;
  const xs = [55, 125, 195, 265, 335, 405, 475, 545, 615, 685, 755, 825];

  const bars = months
    .map((m, i) => {
      const x = xs[i];
      const cx = x + 23;
      if (m.count <= 0) {
        return `    <rect x="${x}" y="178" width="46" height="2" rx="1" fill="#2E1065"/>
    <text x="${cx}" y="198" text-anchor="middle">${escapeXml(m.label)}</text>`;
      }
      const h = Math.max(4, Math.round((m.count / max) * barMaxH));
      const y = baseY - h;
      const labelY = y - 6;
      const labelFill = m.count === max ? "#FFFFFF" : "#C4B5FD";
      const labelOpacity = m.count === max ? "0.95" : "1";
      return `    <rect x="${x}" y="${y}" width="46" height="${h}" rx="4" fill="url(#bar)"/>
    <text x="${cx}" y="${labelY}" fill="${labelFill}" fill-opacity="${labelOpacity}" text-anchor="middle">${m.count}</text>
    <text x="${cx}" y="198" text-anchor="middle">${escapeXml(m.label)}</text>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="220" viewBox="0 0 900 220" role="img" aria-label="Contribution activity">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0B0B0F"/>
      <stop offset="100%" stop-color="#140B22"/>
    </linearGradient>
    <linearGradient id="bar" x1="0%" y1="100%" x2="0%" y2="0%">
      <stop offset="0%" stop-color="#5B21B6"/>
      <stop offset="100%" stop-color="#8B5CF6"/>
    </linearGradient>
  </defs>
  <rect width="900" height="220" rx="12" fill="url(#bg)" stroke="#8B5CF6" stroke-opacity="0.35"/>
  <text x="28" y="40" fill="#FFFFFF" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="18" font-weight="700">Contribution activity</text>
  <text x="28" y="62" fill="#8B5CF6" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="12">Last 12 months | ${total} contributions total | source: GitHub API</text>

  <line x1="48" y1="180" x2="852" y2="180" stroke="#8B5CF6" stroke-opacity="0.25" stroke-width="1"/>

  <g font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="11" fill="#FFFFFF" fill-opacity="0.55">
${bars}
  </g>
</svg>
`;
}

function renderStats({ totalContributions, publicRepos, followers }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="195" viewBox="0 0 420 195" role="img" aria-label="GitHub stats">
  <defs>
    <linearGradient id="card" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0B0B0F"/>
      <stop offset="100%" stop-color="#140B22"/>
    </linearGradient>
  </defs>
  <rect width="420" height="195" rx="12" fill="url(#card)" stroke="#8B5CF6" stroke-opacity="0.35"/>
  <text x="28" y="42" fill="#FFFFFF" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="18" font-weight="700">GitHub Stats</text>
  <text x="28" y="64" fill="#8B5CF6" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="12">@${escapeXml(login)}</text>

  <g font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="14">
    <text x="28" y="104" fill="#FFFFFF" fill-opacity="0.72">Total contributions</text>
    <text x="392" y="104" fill="#FFFFFF" font-weight="700" text-anchor="end">${totalContributions}</text>

    <text x="28" y="132" fill="#FFFFFF" fill-opacity="0.72">Public repositories</text>
    <text x="392" y="132" fill="#FFFFFF" font-weight="700" text-anchor="end">${publicRepos}</text>

    <text x="28" y="160" fill="#FFFFFF" fill-opacity="0.72">Followers</text>
    <text x="392" y="160" fill="#FFFFFF" font-weight="700" text-anchor="end">${followers}</text>
  </g>
  <rect x="28" y="178" width="64" height="2" rx="1" fill="#8B5CF6"/>
</svg>
`;
}

function renderLanguages(langs) {
  const colors = ["#8B5CF6", "#7C3AED", "#5B21B6", "#A78BFA"];
  const rows = langs
    .map((l, i) => {
      const yText = 92 + i * 36;
      const yBar = 100 + i * 36;
      const w = Math.max(2, Math.round((l.pct / 100) * 364));
      return `  <text x="28" y="${yText}" fill="#FFFFFF" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="13">${escapeXml(l.name)}</text>
  <text x="392" y="${yText}" fill="#FFFFFF" fill-opacity="0.7" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="12" text-anchor="end">${l.pct}%</text>
  <rect x="28" y="${yBar}" width="364" height="8" rx="4" fill="#2E1065"/>
  <rect x="28" y="${yBar}" width="${w}" height="8" rx="4" fill="${colors[i % colors.length]}"/>`;
    })
    .join("\n\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="210" viewBox="0 0 420 210" role="img" aria-label="Top languages">
  <defs>
    <linearGradient id="card" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0B0B0F"/>
      <stop offset="100%" stop-color="#140B22"/>
    </linearGradient>
  </defs>
  <rect width="420" height="210" rx="12" fill="url(#card)" stroke="#8B5CF6" stroke-opacity="0.35"/>
  <text x="28" y="40" fill="#FFFFFF" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="18" font-weight="700">Top Languages</text>
  <text x="28" y="60" fill="#8B5CF6" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="12">Primary language across repos · GitHub API</text>

${rows}
</svg>
`;
}

const contrib = await fetchContributionMonths();
const user = await fetchUserStats();
const langs = await fetchTopLanguages();

mkdirSync(assetsDir, { recursive: true });

const activity = renderActivity(contrib);
const stats = renderStats({
  totalContributions: contrib.total,
  publicRepos: user.publicRepos,
  followers: user.followers,
});
const languages = renderLanguages(langs);

writeFileSync(join(assetsDir, "activity.svg"), activity, "utf8");
writeFileSync(join(assetsDir, "stats.svg"), stats, "utf8");
writeFileSync(join(assetsDir, "languages.svg"), languages, "utf8");

const nov = contrib.months.find((m) => m.label === "Nov");
console.log(
  JSON.stringify(
    {
      totalContributions: contrib.total,
      novemberContributions: nov?.count ?? null,
      months: contrib.months,
      publicRepos: user.publicRepos,
      followers: user.followers,
      languages: langs,
    },
    null,
    2,
  ),
);
