#!/usr/bin/env node
// Daily sentinel: sample random photoRefs from places.json, test against
// Google. If too many come back with permanent errors, DM via the cat-signal so
// we catch silent expirations before users notice grey tiles everywhere.
//
// This sentinel exists to catch photoRefs that Google has silently expired. A
// network blip is not an expiration: on 2026-08-23/24 the Mini was pinned at
// load ~79 by 64 orphaned processes, which starved this script's event loop
// until all 20 parallel fetches aborted on their wall-clock deadline. That
// paged Stephen twice (100%, then 55%) for refs that were fine — the same
// sample returned 20/20 ok from the MacBook, and raw curl from the Mini
// reached Google in 80ms. So each sample is retried, timeouts are never
// counted as expirations, and a run that simply could not reach Google is
// reported as its own problem rather than as stale refs.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvLocal } from "./lib/env.mjs";
import { catSignal } from "./lib/notify.mjs";
import { fetchWithRetry } from "./lib/http.mjs";
import {
  classifyPhotoRefResult,
  summarize,
  decideAlert,
} from "./lib/photoref-health.mjs";

loadEnvLocal();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLACES = join(__dirname, "..", "src", "data", "south-bay", "places.json");

const apiKey = process.env.GOOGLE_PLACES_API_KEY;
if (!apiKey) {
  console.error("GOOGLE_PLACES_API_KEY not set");
  process.exit(1);
}

const SAMPLE_SIZE = 20;
// Small pool instead of 20 at once: kinder to Google, and it keeps the probe
// from contributing to the very stall it is trying to measure.
const CONCURRENCY = 5;

const data = JSON.parse(readFileSync(PLACES, "utf8"));
const withRefs = data.places.filter((p) => p.photoRef);
console.log(`sampling ${SAMPLE_SIZE} of ${withRefs.length} places with photoRef`);

const sample = [];
const seen = new Set();
while (sample.length < SAMPLE_SIZE && sample.length < withRefs.length) {
  const idx = Math.floor(Math.random() * withRefs.length);
  if (seen.has(idx)) continue;
  seen.add(idx);
  sample.push(withRefs[idx]);
}

async function probe(place) {
  const url =
    `https://places.googleapis.com/v1/${place.photoRef}/media` +
    `?maxWidthPx=120&maxHeightPx=120&key=${apiKey}`;
  try {
    // fetchWithRetry already returns permanent 4xx immediately and retries
    // only timeouts, 429 and 5xx — exactly the split this sentinel needs.
    const res = await fetchWithRetry(url, {
      timeout: 15_000,
      attempts: 3,
      // Quiet: a retried timeout is expected noise, not a per-place log line.
      onRetry: () => {},
    });
    await res.body?.cancel().catch(() => {});
    return {
      name: place.name,
      kind: classifyPhotoRefResult({ status: res.status }),
      detail: `${res.status}`,
    };
  } catch (err) {
    return {
      name: place.name,
      kind: classifyPhotoRefResult({ error: err }),
      detail: err?.message || String(err),
    };
  }
}

async function pooled(items, limit, fn) {
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

const results = await pooled(sample, CONCURRENCY, probe);
const counts = summarize(results);

console.log(
  `ok=${counts.ok} stale=${counts.stale} unreachable=${counts.unreachable}` +
  ` (${((counts.stale / counts.total) * 100).toFixed(0)}% stale)`,
);
for (const r of results) {
  if (r.kind !== "ok") console.log(`  - ${r.kind} ${r.name}: ${r.detail}`);
}

const alert = decideAlert(counts);
const lines = results
  .filter((r) => r.kind !== "ok")
  .slice(0, 10)
  .map((r) => `${r.kind} ${r.name}: ${r.detail}`);

if (alert.kind === "stale") {
  await catSignal({
    key: "photoref-health",
    title: "Google Places photoRefs are failing",
    body:
      `Sampled ${counts.total} places.json refs against Google Places — ` +
      `**${counts.stale}/${counts.total} returned permanent errors** ` +
      `(${((counts.stale / counts.total) * 100).toFixed(0)}%).\n\n` +
      `Run \`node scripts/refresh-place-photorefs.mjs --force --commit\` on the Mini to refresh.\n\n` +
      "```\n" + lines.join("\n") + "\n```",
  });
  console.log("alerted via cat-signal (stale refs)");
  process.exit(1);
}

if (alert.kind === "unreachable") {
  await catSignal({
    key: "photoref-unreachable",
    title: "photoRef health check could not reach Google",
    body:
      `**${counts.unreachable}/${counts.total}** probes timed out or failed to connect ` +
      "after 3 attempts each. This is a network/host problem, **not** expired photoRefs — " +
      "a refresh will not help.\n\n" +
      "Check the Mini's load and connectivity (runaway processes starve this " +
      "check's event loop until every request aborts at once).\n\n" +
      "```\n" + lines.join("\n") + "\n```",
  });
  console.log("alerted via cat-signal (unreachable)");
  process.exit(1);
}

if (counts.unreachable > 0) {
  console.log(`${counts.unreachable} transient failure(s) tolerated; not alerting`);
}
