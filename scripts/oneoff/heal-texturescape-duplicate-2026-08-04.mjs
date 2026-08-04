#!/usr/bin/env node
// One-off cleanup for the duplicate that shipped as the 2026-08-04 newsletter's
// Evening Pick:
//
//   "Hammer Presents `Texturscape` Hammer2 Gallery Opening Reception"
//   5:00 PM · Hammer Theatre Center · paid
//
// upcoming-events.json carried two records for one event. The Hammer Theatre
// (VBO ticketing) listing misspelled the title, started an hour early, marked a
// free RSVP as paid, and linked a bare forms.gle form. The SJSU Events listing
// — Hammer Theatre is SJSU's venue, so its calendar is the system of record —
// had the correct title, 6:00 PM start, "free", and a real event page:
// https://events.sjsu.edu/event/opening-reception-for-the-hammer2-gallery-texturescape
//
// The forward fix is in src/lib/south-bay/eventFuzzyDedup.mjs: venue words are
// stripped from both titles once two events are known to share a venue, long
// tokens tolerate a one-character typo, and the survivor is picked by URL
// authority before richness. Run scripts/dedup-existing-events.mjs to apply it
// to upcoming-events.json — that is what removes the bad record.
//
// This script repairs the surfaces that copied the bad record's strings before
// it was dropped, so they don't sit stale until their next regen:
//   • event-blurb-cache.json — keyed "fp:<title>|<venue>", so the misspelled
//     title owns its own entry. Orphaned once the record is gone, and a cache
//     is never pruned by a regen, so it would persist indefinitely.
//   • default-plans.json     — the live homepage day plans
//   • shared-plans.json      — /plan/<id> reader snapshots
//
// Day-plan cards are repaired IN PLACE: `role` and `bucket` are untouched and
// no card is added, dropped, or swapped, so the pillar pairs stay atomic
// (docs/day-plan-selection.md). The evening pillar is the same event at the
// same venue, just sourced from the record that gets it right. Its `id` does
// change, so the paired meal card's `pairedWithId` is repointed in the same
// pass — otherwise the pair's reciprocal link dangles.
//
// Deliberately NOT touched:
//   • newsletter-hero.json / the sent issue + its archive — immutable history.
//   • newsletter-editorial-memory.json — its four "Texturscape" mentions are QA
//     notes *about* this defect ("Prefer canonical event pages over
//     form/registration links"). Correcting the spelling there would falsify an
//     accurate record of what went out.
//
// Re-runnable: every operation is idempotent and guarded on the corrected
// record actually being present.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "../lib/io.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = (name) => resolve(__dirname, "../../src/data/south-bay", name);
const EVENTS_PATH = dataPath("upcoming-events.json");
const PLANS_PATH = dataPath("default-plans.json");
const SHARED_PLANS_PATH = dataPath("shared-plans.json");
const BLURB_CACHE_PATH = dataPath("event-blurb-cache.json");

// Identity of the record we keep — the URL is stable across regens, the
// content-hashed id is not.
const CANONICAL_URL =
  "https://events.sjsu.edu/event/opening-reception-for-the-hammer2-gallery-texturescape";
// The dropped record, matched on either its id or the misspelling.
const BAD_EVENT_ID = "hammertheatre-030fe2046064ece3";
const MISSPELLING = /texturscape/i;

const trailingNewline = new Map();

function readJson(path) {
  const raw = readFileSync(path, "utf8");
  trailingNewline.set(path, raw.endsWith("\n") ? "\n" : "");
  return JSON.parse(raw);
}

const isBadCard = (card) =>
  card?.id === `event:${BAD_EVENT_ID}`
  || (MISSPELLING.test(card?.name || "") && /hammer/i.test(card?.venue || ""));

/** Rewrite one day-plan card from the surviving event record, in place. */
function healCard(card, survivor) {
  card.id = `event:${survivor.id}`;
  card.name = survivor.title;
  card.eventTime = survivor.time ?? null;
  card.eventEndTime = survivor.endTime ?? null;
  card.blurb = survivor.blurb ?? card.blurb;
  card.url = survivor.url;
  card.cost = survivor.cost ?? null;
  // The old card's `image` was the ticketing system's poster for the listing we
  // rejected; the survivor has none. photoRef (the venue's Places photo) is
  // already on the card and is what the generator would attach.
  card.image = survivor.image ?? null;
  if (survivor.photoRef) card.photoRef = survivor.photoRef;
  // `address` stays: the card carries Hammer Theatre's real street address and
  // the SJSU feed ships an empty one. Never blank a correct address.
  // `role`, `bucket`, `timeBlock`, `pairedWithId`, `locked` stay: the pair is
  // the same pillar, so none of the pairing metadata changes.
}

function healPlanFile(path, plansOf, survivor) {
  if (!existsSync(path)) return null;
  const data = readJson(path);
  let touched = 0;
  for (const plan of plansOf(data)) {
    for (const card of plan?.cards ?? []) {
      if (isBadCard(card)) {
        healCard(card, survivor);
        touched += 1;
      }
      // The pillar's id changes, which orphans its meal partner's back
      // reference and breaks the pair. Keyed on the old id rather than on
      // "did we just heal it", so a run following a partial one still
      // restores reciprocity.
      if (card?.pairedWithId === `event:${BAD_EVENT_ID}`) {
        card.pairedWithId = `event:${survivor.id}`;
        touched += 1;
      }
    }
  }
  return touched ? { path, data, touched } : null;
}

const events = readJson(EVENTS_PATH).events ?? [];
const survivor = events.find((e) => e?.url === CANONICAL_URL);
const stillBad = events.filter((e) => e?.id === BAD_EVENT_ID || MISSPELLING.test(e?.title || ""));

if (!survivor) {
  console.error(
    `No record with the canonical SJSU URL in upcoming-events.json — refusing to
rewrite plan cards against a missing target. Run the events refresh first.`,
  );
  process.exit(1);
}
if (stillBad.length) {
  console.error(
    `upcoming-events.json still holds ${stillBad.length} misspelled record(s).
Run scripts/dedup-existing-events.mjs first so plan cards aren't repointed at a
record that is about to be dropped.`,
  );
  process.exit(1);
}

const dirty = [];

// Day plans (homepage) and shared /plan/<id> snapshots.
const plansResult = healPlanFile(PLANS_PATH, (d) => Object.values(d.plans ?? {}), survivor);
if (plansResult) dirty.push(plansResult);
const sharedResult = healPlanFile(SHARED_PLANS_PATH, (d) => Object.values(d ?? {}), survivor);
if (sharedResult) dirty.push(sharedResult);

// Blurb cache — drop the orphaned misspelled key, but only once the corrected
// key is present, so a bad run can't leave the event with no cached blurb.
let blurbDropped = 0;
if (existsSync(BLURB_CACHE_PATH)) {
  const cache = readJson(BLURB_CACHE_PATH);
  const byKey = cache.byKey ?? {};
  const goodKey = Object.keys(byKey).find(
    (k) => /texturescape/i.test(k) && !MISSPELLING.test(k),
  );
  if (goodKey) {
    for (const key of Object.keys(byKey)) {
      if (!MISSPELLING.test(key)) continue;
      delete byKey[key];
      blurbDropped += 1;
    }
    if (blurbDropped) dirty.push({ path: BLURB_CACHE_PATH, data: cache, touched: blurbDropped });
  } else {
    console.warn("⚠️  No correctly-spelled blurb-cache key found — left the cache alone.");
  }
}

if (!dirty.length) {
  console.log("Nothing to heal — all surfaces already reference the SJSU record.");
  process.exit(0);
}

for (const { path, data } of dirty) {
  writeFileAtomic(path, JSON.stringify(data, null, 2) + (trailingNewline.get(path) ?? "\n"));
}

console.log(`Kept: "${survivor.title}" ${survivor.time} · ${survivor.cost} · ${survivor.url}`);
for (const { path, touched } of dirty) {
  console.log(`  ${path.split("/").pop().padEnd(24)} ${touched} entr${touched === 1 ? "y" : "ies"} healed`);
}
