#!/usr/bin/env node
// ---------------------------------------------------------------------------
// backfill-registration-2026-08-12.mjs
//
// One-time heal for library events already sitting in upcoming-events.json
// without a `registration` flag, because the BiblioCommons ingest read
// definition.title/start/end and dropped definition.registrationInfo entirely.
//
// The 2026-08-12 newsletter ran Palo Alto's "Vintage Media Lab" as its
// afternoon field-guide pick — "spend the afternoon digitizing family
// cassettes and photos", 1:00 PM, Mitchell Park Library, Free. The lab is
// appointment-only: one pre-booked two-hour appointment per person per week.
// A reader who followed the newsletter and turned up at 1:00 PM could not get
// in. Every registration-gated library event across every BiblioCommons
// library we ingest had the same defect — the flag simply did not exist.
//
// generate-events.mjs now reads registrationInfo at ingest, but the events
// already in the committed feed predate that and still render as walk-ups.
//
// Re-queries the same authoritative endpoint the ingest uses:
//   https://gateway.bibliocommons.com/v2/libraries/{id}/events
//
// Sets `registration` only, and only to a gated value. Never clears an
// existing flag, never edits any other field, never adds or removes an event,
// and never touches events-archive.json — the archive backs the already-sent
// /newsletters/2026-08-12 issue, and sent issues are immutable.
//
// Usage: node scripts/oneoff/backfill-registration-2026-08-12.mjs [--dry-run]
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "../lib/io.mjs";
import { fetchJson } from "../lib/http.mjs";
import {
  REGISTRATION_NONE,
  registrationFromBiblioCommons,
} from "../../src/lib/south-bay/eventFilters.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UPCOMING = join(ROOT, "src", "data", "south-bay", "upcoming-events.json");
const dryRun = process.argv.includes("--dry-run");

// Event ids in the feed are `${libraryId}-${biblioId}`, so the library id is
// recoverable from the id itself and no source-name mapping is needed.
// These are the four BiblioCommons libraries generate-events.mjs actually
// ingests. Mountain View is NOT among them despite sitting in the coverage
// area — its library publishes through LibCal, not BiblioCommons, and
// `mountainview` 404s on the gateway.
const LIBRARIES = ["sjpl", "sccl", "sunnyvale", "paloalto"];
const PAGE_SIZE = 50;
const MAX_PAGES = 200;
// SJPL alone is 130+ pages, so an unthrottled heal fires several hundred
// requests at someone else's gateway in a few seconds and earns a 403. Pace it.
const PAGE_DELAY_MS = 350;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** biblioId → normalized registration state, for one library. */
async function registrationMap(libraryId) {
  const map = new Map();
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchJson(
      `https://gateway.bibliocommons.com/v2/libraries/${libraryId}/events?limit=${PAGE_SIZE}&page=${page}`,
      { timeout: 30_000 },
    );
    if (data?.error) break;
    const events = data?.entities?.events ? Object.values(data.entities.events) : [];
    if (!events.length) break;
    // Pages are not date-ordered and eventually wrap; stop on a page that
    // brings nothing new rather than burning requests against their API.
    let fresh = 0;
    for (const ev of events) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      fresh++;
      map.set(ev.id, registrationFromBiblioCommons(ev));
    }
    if (!fresh) break;
    await sleep(PAGE_DELAY_MS);
  }
  return map;
}

const maps = new Map();
for (const libraryId of LIBRARIES) {
  // One library failing must not abandon the heal for the other three — a
  // partial backfill is strictly better than none, and re-running is safe
  // (already-flagged events are skipped).
  try {
    const map = await registrationMap(libraryId);
    maps.set(libraryId, map);
    const gated = [...map.values()].filter((s) => s !== REGISTRATION_NONE).length;
    console.log(`${libraryId}: ${map.size} events, ${gated} gated`);
  } catch (err) {
    console.warn(`${libraryId}: ⚠️  ${err.message} — skipped, its events keep their current state`);
  }
}

/** Split `${libraryId}-${biblioId}` without breaking on ids containing dashes. */
function lookup(eventId) {
  const id = String(eventId || "");
  for (const libraryId of LIBRARIES) {
    if (!id.startsWith(`${libraryId}-`)) continue;
    const state = maps.get(libraryId)?.get(id.slice(libraryId.length + 1));
    if (state) return state;
  }
  return null;
}

const data = JSON.parse(readFileSync(UPCOMING, "utf8"));
const healed = [];
const counts = {};
for (const event of data.events ?? []) {
  if (event.registration) continue;
  const state = lookup(event.id);
  if (!state || state === REGISTRATION_NONE) continue;
  event.registration = state;
  counts[state] = (counts[state] || 0) + 1;
  healed.push(event);
}

console.log(`\n${healed.length} event(s) flagged from their source: ${JSON.stringify(counts)}`);
for (const e of healed.slice(0, 40)) {
  console.log(`  ${e.date} ${e.time ?? "(no time)"} | ${e.registration} | ${e.title}`);
}
if (healed.length > 40) console.log(`  … and ${healed.length - 40} more`);

if (!healed.length) {
  console.log("\nnothing to heal");
} else if (dryRun) {
  console.log("\n--dry-run: no file written");
} else {
  writeFileAtomic(UPCOMING, JSON.stringify(data, null, 2) + "\n");
  console.log(`\nwrote ${UPCOMING}`);
}
