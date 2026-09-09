#!/usr/bin/env node
// ---------------------------------------------------------------------------
// verify-place-urls.mjs
//
// Link audit for the two hand-curated data files nothing else checks:
//
//   src/data/south-bay/events-data.ts  — farmers' markets, concert series,
//                                        storytimes, seasonal events (Events
//                                        tab, Food tab, city pages)
//   src/data/south-bay/poi-data.ts     — the Plan My Day permanent-venue pool
//
// `audit-tech-urls` covers the Tech tab and `verify-camp-urls` covers camp
// registration links; these two files had no coverage at all, and the
// 2026-09-09 run found eight bad links in them — including a farmers' market
// card pointing at a domain-squatter and a coffee house whose host serves a
// certificate for the wrong name.
//
// Usage:
//   node scripts/verify-place-urls.mjs           # report only, exit 0
//   node scripts/verify-place-urls.mjs --strict  # exit 1 on hard findings
//
// A hard finding is broken / parked / tls. 403 and 406 are reported as
// suspicious only: many venue and .gov sites bot-block a scripted fetch while
// working fine in a browser, and failing on those would make the check noise.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyLink, extractLinks, HARD_BUCKETS } from "./lib/link-health.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "src", "data", "south-bay");

const FILES = [
  { file: "events-data.ts", surface: "events" },
  { file: "poi-data.ts", surface: "poi" },
];

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const CONCURRENCY = 6;
const TIMEOUT_MS = 25_000;

const ICON = { ok: "✓", suspicious: "!", broken: "✗", parked: "$", tls: "🔒" };

async function check(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let title = "";
    try {
      title = ((await res.text()).match(/<title[^>]*>([^<]*)/i) ?? [])[1]?.trim() ?? "";
    } catch {
      // A body we cannot read still leaves the status usable.
    }
    return { status: res.status, finalUrl: res.url, title };
  } catch (err) {
    return {
      errorCode: err?.cause?.code ?? err?.code ?? "",
      detail: String(err?.message ?? err).slice(0, 80),
      finalUrl: url,
    };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const targets = [];
for (const { file, surface } of FILES) {
  const src = readFileSync(join(DATA_DIR, file), "utf8");
  for (const link of extractLinks(src)) {
    if (!/^https?:/i.test(link.url)) continue;
    targets.push({ ...link, surface, file });
  }
}

console.log(`Checking ${targets.length} curated place/event links...\n`);

const results = await mapLimit(targets, CONCURRENCY, async (t) => {
  const res = await check(t.url);
  return { ...t, ...res, bucket: classifyLink(res) };
});

const byBucket = (b) => results.filter((r) => r.bucket === b);
const hard = results.filter((r) => HARD_BUCKETS.has(r.bucket));

for (const r of results) {
  if (r.bucket === "ok") continue;
  const code = r.status ?? r.errorCode ?? "ERR";
  console.log(`${ICON[r.bucket]} [${String(code).padEnd(5)}] ${r.label}  (${r.file})`);
  console.log(`    ${r.url}`);
  if (r.finalUrl && r.finalUrl !== r.url) console.log(`    → ${r.finalUrl}`);
  if (r.detail) console.log(`    ${r.detail}`);
  console.log();
}

console.log("─".repeat(64));
console.log(
  `Summary: ${byBucket("ok").length} OK · ${byBucket("suspicious").length} suspicious ` +
    `· ${byBucket("broken").length} broken · ${byBucket("parked").length} parked ` +
    `· ${byBucket("tls").length} tls`,
);

if (hard.length) {
  console.log("\nFIX THESE:");
  for (const r of hard) console.log(`  ${r.bucket.padEnd(6)} ${r.label} — ${r.url}`);
}

if (process.argv.includes("--strict") && hard.length) process.exit(1);
