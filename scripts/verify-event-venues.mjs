#!/usr/bin/env node
// Live-source verification for event venue resolution.
//
// Checks, against the real calendars, that no event is filed under a building
// it is not held in. Covers both ingest paths that have shipped this defect:
//
//   LibCal          scripts/lib/libcal-location.mjs
//   BiblioCommons   scripts/lib/biblio-location.mjs
//
// Records this exists to keep fixed:
//   mountainview.libcal.com/event/16953202   Location: Online       (2026-08-06)
//   mountainview.libcal.com/event/16650443   Location: Pioneer Park (2026-08-06)
//   mountainview.libcal.com/event/17295774   Location: Offsite      (2026-09-03)
//   paloalto.bibliocommons.com/events/68faec5706078d3600744ca3      (2026-09-03)
//
// The earlier version of this harness asserted only that nothing may claim the
// library's STREET ADDRESS unless the library is the venue. Both 2026-09-03
// records carried an EMPTY address, so they slipped straight through it. The
// invariants below are on the venue NAME, which is what a reader acts on.
//
// Read-only: fetches the same public listings the nightly refresh already
// loads. Run with `npm run verify:venues`.

import { LIBCAL_LIBRARIES, scrapeLibCal } from "./playwright-scrapers.mjs";
import { classifyLibCalLocation } from "./lib/libcal-location.mjs";
import { resolveBiblioLocation } from "./lib/biblio-location.mjs";

const UA = "SouthBaySignal/1.0 (southbaytoday.org; public event calendar aggregator)";
const LIBCAL_CRAWL_DELAY_MS = 10_000;

let failures = 0;
let checked = 0;
const fail = (msg) => { console.error(`      ✗ ${msg}`); failures++; };

// ── LibCal ─────────────────────────────────────────────────────────────────

async function libcalRaw(origin) {
  const out = [];
  for (let page = 1; page <= 4; page++) {
    if (page > 1) await new Promise((r) => setTimeout(r, LIBCAL_CRAWL_DELAY_MS));
    const res = await fetch(
      `${origin}/ajax/calendar/list?c=-1&date=&perpage=100&page=${page}&audience=&cats=&camps=&inc=0`,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    if (results.length === 0) break;
    out.push(...results);
    if (results.length < 100) break;
  }
  return out;
}

for (const library of LIBCAL_LIBRARIES) {
  const origin = new URL(library.urls[0]).origin;
  console.log(`\n═══ ${library.name} — LibCal`);

  const raw = await libcalRaw(origin);
  const suppressed = [];

  for (const ev of raw) {
    const place = classifyLibCalLocation(ev.location || "", library, {
      title: ev.title || "",
      description: ev.description || ev.shortdesc || "",
    });
    checked++;

    // The venue name is the claim a reader acts on. Anything the source says
    // is not in the building must not carry the building's name.
    if (place.kind !== "onsite" && place.kind !== "unknown" && place.kind !== "bookmobile") {
      if (place.venue === library.name) {
        fail(`${ev.url} — Location "${place.location}" (${place.kind}) resolved to "${library.name}"`);
      }
    }
    // The 2026-09-03 shape: "Offsite" must never name the host library, with
    // or without an address.
    if (place.kind === "offsite-unnamed" && place.venue === library.name) {
      fail(`${ev.url} — Location "Offsite" resolved to the library`);
    }
    // The 2026-08-06 shape: only the library may hold the library's address.
    if (place.address && place.address === library.address && place.venue !== library.name) {
      fail(`${ev.url} — "${place.venue}" claims the library's street address`);
    }
    if (place.virtual && place.address) {
      fail(`${ev.url} — virtual event carries an address`);
    }
    if (place.suppress) suppressed.push(`${ev.title} (${ev.url})`);
  }

  const events = await scrapeLibCal(null, library);
  console.log(`  ${raw.length} raw → ${events.length} shipped`);

  for (const e of events) {
    // End-to-end: nothing may ship under the library's name with no address.
    // A real library program carries the library's street address; this is the
    // exact form both 2026-09-03 defects took.
    if (e.venue === library.name && !e.address) {
      fail(`"${e.title}" (${e.url}) ships as "${library.name}" with no address`);
    }
    if (!e.venue) fail(`"${e.title}" (${e.url}) ships with no venue at all`);
  }

  if (suppressed.length > 0) {
    console.log(`  ⓘ ${suppressed.length} off-site event(s) suppressed for want of a verified venue —`);
    console.log("    add them to this library's offsiteAddresses once confirmed:");
    for (const s of suppressed) console.log(`      · ${s}`);
  }
}

// ── BiblioCommons ──────────────────────────────────────────────────────────

const BIBLIO = [
  { id: "paloalto", name: "Palo Alto City Library" },
  { id: "sjpl", name: "San Jose Public Library" },
];
const LOCATION_CHANGE = /^\s*[*\s]*(location\s+change|new\s+location|moved|relocated|venue\s+change)\b\s*[:\-—–]/i;

for (const library of BIBLIO) {
  console.log(`\n═══ ${library.name} — BiblioCommons`);
  let nonBranch = 0;
  let fallback = 0;
  let seen = 0;

  for (let page = 1; page <= 20; page++) {
    const res = await fetch(
      `https://gateway.bibliocommons.com/v2/libraries/${library.id}/events?limit=50&page=${page}`,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) throw new Error(`${library.id} gateway: HTTP ${res.status}`);
    const data = await res.json();
    const entities = data.entities || {};
    const events = entities.events ? Object.values(entities.events) : [];
    if (events.length === 0) break;

    for (const ev of events) {
      const definition = ev.definition || {};
      const got = resolveBiblioLocation({ event: ev, entities, libraryName: library.name });
      seen++;
      checked++;

      // An event the feed files at a non-branch place must never resolve to
      // the library system's own name. This is the 2026-09-03 defect.
      if (definition.nonBranchLocationId && (entities.places || {})[definition.nonBranchLocationId]) {
        nonBranch++;
        if (got.venue === library.name) {
          fail(`${library.id}/${ev.id} "${definition.title}" — non-branch place resolved to "${library.name}"`);
        }
        if (!got.address) {
          fail(`${library.id}/${ev.id} "${definition.title}" — non-branch place lost its address`);
        }
      }

      // A listing that announces a move must not name its own institution.
      if (LOCATION_CHANGE.test(definition.title || "") && got.venue === library.name) {
        fail(`${library.id}/${ev.id} "${definition.title}" — announces a move but resolved to "${library.name}"`);
      }

      if (got.kind === "library-fallback") fallback++;
    }
  }
  console.log(`  ${seen} events — ${nonBranch} at non-branch places, ${fallback} with no location in the feed`);
}

console.log(
  failures === 0
    ? `\n✅ ${checked} events checked — no venue violations`
    : `\n❌ ${failures} violation(s) across ${checked} events checked`,
);
process.exit(failures === 0 ? 0 : 1);
