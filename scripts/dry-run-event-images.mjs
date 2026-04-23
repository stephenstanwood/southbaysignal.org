#!/usr/bin/env node
// Run the event-image resolver against the committed upcoming-events.json.
//
// Usage:
//   node scripts/dry-run-event-images.mjs --dry     # report only
//   node scripts/dry-run-event-images.mjs           # resolve + write back
//   RESOLVE_EVENT_IMAGES_RECRAFT=1 node scripts/dry-run-event-images.mjs  # also Tier 3

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEventImages } from "../src/lib/south-bay/eventImages.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVENTS_PATH = join(__dirname, "..", "src", "data", "south-bay", "upcoming-events.json");
const dryRun = process.argv.includes("--dry");

const data = JSON.parse(readFileSync(EVENTS_PATH, "utf8"));
const events = data.events;
console.log(`Loaded ${events.length} events from upcoming-events.json${dryRun ? " (DRY RUN)" : ""}\n`);

const t0 = Date.now();
const stats = await resolveEventImages(events, { dryRun });
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\nStats (${elapsed}s):`);
console.table(stats);

const resolved = stats.tier1 + stats.tier2_cached + stats.tier2_fetched + stats.tier3_cached + stats.tier3_generated + stats.preexisting;
console.log(`\nResolved: ${resolved} / ${events.length} (${((resolved / events.length) * 100).toFixed(0)}%)`);

if (!dryRun) {
  data.events = events;
  writeFileSync(EVENTS_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(`\n✓ Wrote upcoming-events.json with image fields`);
}
