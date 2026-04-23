#!/usr/bin/env node
// Re-run the OG quality gate against the full event-image-cache.json and
// clear out any cached images that fail the new rules. Next generate-events
// run will re-fetch (or fall through to Recraft) for the dropped entries.
//
// Usage:
//   node scripts/revalidate-og-images.mjs --dry     # report only
//   node scripts/revalidate-og-images.mjs           # apply + write cache
//
// Also scrubs event.image from upcoming-events.json for any event whose
// current image is now marked rejected in the cache — otherwise stale bad
// images linger until the next scrape.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { revalidateOgCache } from "../src/lib/south-bay/eventImages.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const EVENTS_PATH = join(REPO_ROOT, "src", "data", "south-bay", "upcoming-events.json");
const CACHE_PATH = join(REPO_ROOT, "src", "data", "south-bay", "event-image-cache.json");
const dryRun = process.argv.includes("--dry");

const t0 = Date.now();
const stats = await revalidateOgCache({ dryRun });
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`Revalidate OG cache (${elapsed}s)${dryRun ? " [DRY]" : ""}:`);
console.table(stats);

if (!dryRun && stats.rejected > 0) {
  // Sync upcoming-events.json: drop .image on any event whose image URL is
  // now in the cache's "rejected" slot (we replaced cache[url].image with null
  // so those events need their .image cleared too).
  const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  const rejectedImages = new Set(
    Object.values(cache.byUrl || {})
      .filter((v) => v?.rejected)
      .map((v) => v.rejected),
  );
  const data = JSON.parse(readFileSync(EVENTS_PATH, "utf8"));
  let cleared = 0;
  for (const e of data.events) {
    if (e.image && rejectedImages.has(e.image)) {
      delete e.image;
      cleared++;
    }
  }
  writeFileSync(EVENTS_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(`\n✓ Cleared .image on ${cleared} events whose OG image failed validation`);
}
