#!/usr/bin/env node
// Daily sentinel: sample random photoRefs from places.json, test against
// Google. If >10% fail, DM via the cat-signal so we catch silent expirations
// before users notice grey tiles everywhere.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvLocal } from "./lib/env.mjs";
import { catSignal } from "./lib/notify.mjs";

loadEnvLocal();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLACES = join(__dirname, "..", "src", "data", "south-bay", "places.json");

const apiKey = process.env.GOOGLE_PLACES_API_KEY;
if (!apiKey) {
  console.error("GOOGLE_PLACES_API_KEY not set");
  process.exit(1);
}

const SAMPLE_SIZE = 20;
const ALERT_THRESHOLD = 0.10; // 10% failure → alert

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

// This sentinel exists to catch photoRefs that Google has silently expired.
// A network blip is not an expiration: on 2026-08-23 the Mini briefly lost
// connectivity and every one of the 20 samples timed out, which paged Stephen
// with a 100%-failure alarm for refs that were fine. So each sample gets a
// retry, and a run whose failures are ALL transport errors is reported as an
// inconclusive network problem instead of a photoRef alarm.
const ATTEMPTS = 2;

async function probe(place) {
  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const r = await fetch(
        `https://places.googleapis.com/v1/${place.photoRef}/media?maxWidthPx=120&maxHeightPx=120&key=${apiKey}`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (r.ok) return { ok: true };
      // A 4xx other than 429 is Google rejecting the ref itself — the exact
      // condition this sentinel watches for. Don't retry it.
      if (r.status < 500 && r.status !== 429) {
        return { ok: false, transport: false, label: `${r.status} ${place.name}` };
      }
      last = { transport: true, label: `${r.status} ${place.name}` };
    } catch (err) {
      last = { transport: true, label: `err ${place.name}: ${err.message}` };
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, ...last };
}

let ok = 0, fail = 0;
const failures = [];
let transportFailures = 0;
const results = await Promise.all(sample.map(probe));
for (const r of results) {
  if (r.ok) { ok++; continue; }
  fail++;
  failures.push(r.label);
  if (r.transport) transportFailures++;
}

const failPct = fail / sample.length;
console.log(`ok=${ok} fail=${fail} (${(failPct * 100).toFixed(0)}%)`);
if (failures.length) failures.forEach((f) => console.log("  -", f));

if (fail > 0 && transportFailures === fail) {
  console.log(
    `inconclusive: all ${fail} failures were network/transport errors, not ` +
      "photoRef rejections — treating as a connectivity blip, not alerting",
  );
  process.exit(0);
}

if (failPct > ALERT_THRESHOLD) {
  await catSignal({
    key: "photoref-health",
    title: "Google Places photoRefs are failing",
    body:
      `Sampled ${SAMPLE_SIZE} places.json refs against Google Places — ` +
      `**${fail}/${SAMPLE_SIZE} returned errors** (${(failPct * 100).toFixed(0)}%).\n\n` +
      `Run \`node scripts/refresh-place-photorefs.mjs --force --commit\` on the Mini to refresh.\n\n` +
      "```\n" + failures.slice(0, 10).join("\n") + "\n```",
  });
  console.log("alerted via cat-signal");
  process.exit(1);
}
