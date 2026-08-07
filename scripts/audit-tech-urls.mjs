#!/usr/bin/env node
// ---------------------------------------------------------------------------
// audit-tech-urls.mjs
//
// Link audit for every company card on the Tech tab (RECENTLY_FUNDED,
// SCC_SPOTLIGHT, TECH_COMPANIES in src/data/south-bay/tech-companies.ts).
//
// The point is NOT just dead links — it's catching the staleness those links
// betray. A company card whose domain now lands on a *different* domain is
// almost always an acquisition, a rebrand, or a lapsed domain someone else
// bought. All three make the card factually wrong, and none of them show up
// in a typecheck. Real finds from the 2026-08-07 run:
//
//   celestial.ai   -> marvell.com/ai.html    (acquired by Marvell, Feb 2026)
//   purestorage.com-> everpuredata.com       (rebranded to Everpure, Feb 2026)
//   naive.com      -> a stranger's LinkedIn  (wrong domain; real site is
//                                             usenaive.ai)
//
// Usage:
//   node --import tsx scripts/audit-tech-urls.mjs           # report only
//   node --import tsx scripts/audit-tech-urls.mjs --strict  # exit 1 on findings
//   node --import tsx scripts/audit-tech-urls.mjs --json    # machine-readable
//
// Exit codes:
//   0 — audit ran (findings are advisory unless --strict)
//   1 — --strict and at least one MOVED or DEAD result
//   2 — could not load the tech data module
//
// Politeness: reuses the shared SouthBaySignal UA and hits each company's own
// homepage at most once, four at a time. Sites that block non-browser agents
// come back as BLOCKED, which is informational — an honest UA is worth more
// than a lower false-positive count here.
// ---------------------------------------------------------------------------

import { UA } from "./lib/http.mjs";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const asJson = args.includes("--json");

const CONCURRENCY = 4;
const TIMEOUT_MS = 25_000;

// 401/403/406/429 from a homepage means a bot wall, not a broken link. These
// are reported separately so they never drown out the findings that matter.
const BOT_WALL_STATUSES = new Set([401, 403, 406, 429]);

let data;
try {
  data = await import("../src/data/south-bay/tech-companies.ts");
} catch (err) {
  console.error(`[audit-tech-urls] failed to load tech-companies.ts: ${err.message}`);
  console.error("[audit-tech-urls] run with: node --import tsx scripts/audit-tech-urls.mjs");
  process.exit(2);
}

const SOURCES = [
  ["RECENTLY_FUNDED", data.RECENTLY_FUNDED],
  ["SCC_SPOTLIGHT", data.SCC_SPOTLIGHT],
  ["TECH_COMPANIES", data.TECH_COMPANIES],
];

const targets = [];
for (const [section, rows] of SOURCES) {
  for (const row of rows ?? []) {
    if (row?.url) targets.push({ section, id: row.id, name: row.name, url: row.url });
  }
}

/** Hostname without a leading "www.", for comparing where a URL ended up. */
function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

async function check(target) {
  const from = host(target.url);
  if (!from) return { ...target, status: "INVALID", detail: "unparseable url" };

  let res;
  try {
    res = await fetch(target.url, {
      headers: { "user-agent": UA, accept: "text/html,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ...target, status: "DEAD", detail: err.message || "request failed" };
  }

  const to = host(res.url);
  if (BOT_WALL_STATUSES.has(res.status)) {
    return { ...target, status: "BLOCKED", detail: `HTTP ${res.status}`, finalUrl: res.url };
  }
  if (!res.ok) {
    return { ...target, status: "DEAD", detail: `HTTP ${res.status}`, finalUrl: res.url };
  }
  if (to && to !== from) {
    return {
      ...target,
      status: "MOVED",
      detail: `${from} -> ${to}`,
      finalUrl: res.url,
    };
  }
  return { ...target, status: "OK", finalUrl: res.url };
}

/** Run `worker` over `items` with a fixed number of workers in flight. */
async function pool(items, worker, size) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return results;
}

const results = await pool(targets, check, CONCURRENCY);
const by = (s) => results.filter((r) => r.status === s);

if (asJson) {
  console.log(JSON.stringify({ checked: results.length, results }, null, 2));
} else {
  const moved = by("MOVED");
  const dead = [...by("DEAD"), ...by("INVALID")];
  const blocked = by("BLOCKED");

  console.log(
    `[audit-tech-urls] checked ${results.length} card links · ` +
      `${by("OK").length} ok · ${moved.length} moved · ${dead.length} dead · ${blocked.length} blocked`,
  );

  if (moved.length) {
    console.log(
      "\nMOVED — landed on a different domain. Check for an acquisition, a rebrand,\n" +
        "or a lapsed domain before trusting the card's copy:",
    );
    for (const r of moved) console.log(`  ${r.section} · ${r.name}\n    ${r.url}\n    ${r.detail}`);
  }

  if (dead.length) {
    console.log("\nDEAD — link is broken and readers will hit an error:");
    for (const r of dead) console.log(`  ${r.section} · ${r.name}\n    ${r.url}  (${r.detail})`);
  }

  if (blocked.length) {
    console.log(
      "\nBLOCKED — bot wall, almost certainly a live site. Informational only:",
    );
    for (const r of blocked) console.log(`  ${r.section} · ${r.name} — ${r.url} (${r.detail})`);
  }

  if (!moved.length && !dead.length) console.log("\nNo broken or relocated card links.");
}

if (strict && (by("MOVED").length || by("DEAD").length || by("INVALID").length)) {
  process.exit(1);
}
