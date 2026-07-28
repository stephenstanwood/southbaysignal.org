#!/usr/bin/env node
// One-off backfill: repair the SJSU title/venue stutter found in the
// 2026-07-28 daily-newsletter QA pass, which rendered the Morning pick as
//
//   "Dr. Sandy Hirsh's keynote at InSITE2026 (MLK Library) at King Library"
//   9:15 AM · InSITE2026 (MLK Library) at King Library · San Jose · Free
//
// SJSU's Localist RSS carries no <location> element, so every SJSU venue is
// derived from the title by extractVenueFromTitle(). That used to split on the
// FIRST " at ", so a title with two of them handed the program/room name back
// as part of the venue ("AI Center for Civic and Social Good at King Library")
// and left the whole thing duplicated in the title. Forward fixes are in
// scripts/lib/venue-suffix.mjs; this repairs the records already on disk so
// the current issue data is clean rather than waiting for the next regen.
//
// Scoped to source === "SJSU Events": that is where the venue is title-derived
// and the "<Program> at <Venue>" shape is a defect. Other sources carry the
// same shape legitimately — "School of Arts and Culture at MHP" is the
// organization's actual name, and "ASML Next Gen Stage at SJMA" names a real
// stage — so those venues are left alone.
//
// Four surfaces carry copies of these strings and all four are live:
//   • upcoming-events.json  — the events tab, plan-day, the next newsletter
//   • events-archive.json   — past events, rendered by /event/[slug]
//   • default-plans.json    — the pre-generated homepage day plans
//   • shared-plans.json     — /plan/<id> snapshots
// Already-sent newsletters and their archive pages are immutable and are not
// touched.
//
// Also re-keys the affected event-blurb cache entries. The cache is keyed on
// "fp:<title>|<venue>", so rewriting either field would otherwise orphan a
// good blurb and re-spend a Sonnet call on the next run.
//
// Re-runnable: every operation is idempotent.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "../lib/io.mjs";
import { stripRedundantVenueSuffix, venueTailSegment } from "../lib/venue-suffix.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = (name) => resolve(__dirname, "../../src/data/south-bay", name);
const DATA_PATH = dataPath("upcoming-events.json");
const ARCHIVE_PATH = dataPath("events-archive.json");
const PLANS_PATH = dataPath("default-plans.json");
const SHARED_PLANS_PATH = dataPath("shared-plans.json");
const BLURB_CACHE_PATH = dataPath("event-blurb-cache.json");

// Mirrors eventBlurbs.mjs cacheKey().
const blurbKey = (title, venue) =>
  `fp:${String(title || "").toLowerCase().replace(/\s+/g, " ").trim()}`
  + `|${String(venue || "").toLowerCase().replace(/\s+/g, " ").trim()}`;

const stats = { venueFixed: 0, titleFixed: 0, blurbRekeyed: 0 };
const samples = [];
const trailingNewline = new Map();

function readJson(path) {
  const raw = readFileSync(path, "utf8");
  trailingNewline.set(path, raw.endsWith("\n") ? "\n" : "");
  return JSON.parse(raw);
}

/** Repair one record in place. `titleField` differs per surface: events use
 *  `title`, day-plan cards use `name`. `isSjsu` gates the venue rewrite —
 *  plan cards don't carry a `source`, so the caller decides. */
function fixRecord(rec, { titleField, isSjsu, cache }) {
  const beforeTitle = rec[titleField];
  const beforeVenue = rec.venue;

  if (isSjsu && rec.venue) {
    const tail = venueTailSegment(rec.venue);
    if (tail && tail !== rec.venue) {
      rec.venue = tail;
      stats.venueFixed += 1;
    }
  }

  const nextTitle = stripRedundantVenueSuffix(rec[titleField], rec.venue);
  if (nextTitle && nextTitle !== rec[titleField]) {
    rec[titleField] = nextTitle;
    stats.titleFixed += 1;
  }

  if (rec[titleField] === beforeTitle && rec.venue === beforeVenue) return false;

  samples.push({
    id: rec.id || rec[titleField],
    beforeTitle,
    afterTitle: rec[titleField],
    beforeVenue,
    afterVenue: rec.venue,
  });

  if (cache?.byKey) {
    const oldKey = blurbKey(beforeTitle, beforeVenue);
    const newKey = blurbKey(rec[titleField], rec.venue);
    if (oldKey !== newKey && cache.byKey[oldKey] && !cache.byKey[newKey]) {
      cache.byKey[newKey] = cache.byKey[oldKey];
      delete cache.byKey[oldKey];
      stats.blurbRekeyed += 1;
    }
  }
  return true;
}

function main() {
  const cache = existsSync(BLURB_CACHE_PATH)
    ? readJson(BLURB_CACHE_PATH)
    : null;
  const dirty = new Map();

  // upcoming-events.json + events-archive.json — same record shape.
  for (const path of [DATA_PATH, ARCHIVE_PATH]) {
    if (!existsSync(path)) continue;
    const data = readJson(path);
    let touched = 0;
    for (const e of data.events ?? []) {
      if (fixRecord(e, { titleField: "title", isSjsu: e.source === "SJSU Events", cache })) touched += 1;
    }
    if (touched) dirty.set(path, data);
  }

  // default-plans.json — pre-generated homepage day plans. Cards carry `name`
  // + `venue` and no `source`, so gate the venue rewrite on the stutter itself
  // rather than on provenance.
  if (existsSync(PLANS_PATH)) {
    const plans = readJson(PLANS_PATH);
    let touched = 0;
    for (const plan of Object.values(plans.plans ?? {})) {
      for (const card of plan.cards ?? []) {
        // Blurb-cache re-keying is the events pass's job — a plan card is a
        // copy of a record already handled there.
        const stutters = card.venue && card.name?.endsWith(` at ${card.venue}`);
        if (fixRecord(card, { titleField: "name", isSjsu: !!stutters, cache: null })) touched += 1;
      }
    }
    if (touched) dirty.set(PLANS_PATH, plans);
  }

  // shared-plans.json — reader-facing /plan/<id> snapshots, same card shape
  // keyed by share id. Copy is repaired in place; no card is added, dropped,
  // or swapped, so the pillar pairs stay intact.
  if (existsSync(SHARED_PLANS_PATH)) {
    const shared = readJson(SHARED_PLANS_PATH);
    let touched = 0;
    for (const plan of Object.values(shared ?? {})) {
      for (const card of plan?.cards ?? []) {
        const stutters = card.venue && card.name?.endsWith(` at ${card.venue}`);
        if (fixRecord(card, { titleField: "name", isSjsu: !!stutters, cache: null })) touched += 1;
      }
    }
    if (touched) dirty.set(SHARED_PLANS_PATH, shared);
  }

  if (!dirty.size) {
    console.log("No stuttered SJSU records — files unchanged.");
    return;
  }

  // Each writer has its own trailing-newline habit (share-plan.ts writes none,
  // generate-events.mjs writes one). Match what's already on disk so this
  // backfill doesn't leave a spurious one-line diff for the next regen.
  for (const [path, data] of dirty) {
    writeFileAtomic(path, JSON.stringify(data, null, 2) + (trailingNewline.get(path) ?? "\n"));
  }
  if (stats.blurbRekeyed) {
    writeFileAtomic(
      BLURB_CACHE_PATH,
      JSON.stringify(cache, null, 2) + (trailingNewline.get(BLURB_CACHE_PATH) ?? "\n"),
    );
  }

  console.log(`Venues collapsed to their real trailing segment: ${stats.venueFixed}`);
  console.log(`Titles de-stuttered:                             ${stats.titleFixed}`);
  console.log(`Blurb-cache entries re-keyed:                    ${stats.blurbRekeyed}`);
  console.log(`Records touched:                                 ${samples.length}`);
  console.log(`Files rewritten:                                 ${[...dirty.keys()].map((p) => p.split("/").pop()).join(", ")}\n`);
  for (const s of samples) {
    console.log(`  • ${s.id}`);
    if (s.beforeTitle !== s.afterTitle) {
      console.log(`      title: ${s.beforeTitle}`);
      console.log(`          →  ${s.afterTitle}`);
    }
    if (s.beforeVenue !== s.afterVenue) {
      console.log(`      venue: ${s.beforeVenue}`);
      console.log(`          →  ${s.afterVenue}`);
    }
  }
}

main();
