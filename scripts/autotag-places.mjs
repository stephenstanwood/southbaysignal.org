#!/usr/bin/env node
// Backfill kidFriendly + indoorOutdoor on places.json using the shared
// heuristic lib. Pure post-processing — no Google API calls, safe to run
// any time. Use after updating the heuristics in lib/infer-place-tags.mjs
// without waiting for the next scheduled generate-places run.
//
// Usage: node scripts/autotag-places.mjs [--dry]

import { readFileSync, writeFileSync } from "node:fs";
import { ARTIFACTS } from "./lib/paths.mjs";
import { autotagPlace } from "./lib/infer-place-tags.mjs";

const DRY = process.argv.includes("--dry");

const json = JSON.parse(readFileSync(ARTIFACTS.places, "utf8"));
const places = Array.isArray(json) ? json : (json.places || []);
if (!places.length) {
  console.error("No places[] array found in places.json");
  process.exit(1);
}

let kfAdded = 0;
let ioAdded = 0;
const sampleKf = [];

for (const p of places) {
  const before = { kf: p.kidFriendly, io: p.indoorOutdoor };
  const { kidFriendlyChanged, indoorOutdoorChanged } = autotagPlace(p);
  if (kidFriendlyChanged) {
    kfAdded++;
    if (sampleKf.length < 20) sampleKf.push({ name: p.name, city: p.city, guess: p.kidFriendly, category: p.category, primaryType: p.primaryType });
  }
  if (indoorOutdoorChanged) ioAdded++;
}

console.log(`places scanned: ${places.length}`);
console.log(`kidFriendly tagged: ${kfAdded}`);
console.log(`indoorOutdoor tagged: ${ioAdded}`);
console.log(`\nsample of new kidFriendly tags (kid = true, adl = false):`);
for (const s of sampleKf) {
  const label = s.guess === true ? " kid " : "adl ";
  console.log(`  [${label}] ${s.name.padEnd(40)} ${String(s.city).padEnd(14)} ${s.category || ""}  (${s.primaryType || "?"})`);
}

if (DRY) {
  console.log("\n--dry: not writing places.json");
  process.exit(0);
}

writeFileSync(ARTIFACTS.places, JSON.stringify(json, null, 2));
console.log(`\nwrote ${ARTIFACTS.places}`);
