#!/usr/bin/env node
// One-off backfill (cycle 110): apply SCCL branch venues + the relaxed
// stripRedundantVenueSuffix to the current upcoming-events.json so the
// improvement ships now rather than waiting for the next nightly regen.
//
// Idempotent — runs through the same data twice yield the same output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./lib/io.mjs";
import { stripRedundantVenueSuffix } from "./lib/venue-suffix.mjs";

import { polishDescription } from "./generate-events.mjs"; // forces module load (also a sanity check it exports)

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "src", "data", "south-bay", "upcoming-events.json");

// City slug → SCCL branch display name. Used when the location code isn't
// available (the existing JSON doesn't carry it), so we infer the branch from
// the city slug. Every SCCL slug except los-altos has a single branch in the
// system, so this is exact for those. los-altos collapses Woodland into Los
// Altos — Woodland is a small minority and the next regen will correct it
// using the actual branchLocationId.
const SCCL_CITY_BRANCH = {
  campbell: "Campbell Library",
  cupertino: "Cupertino Library",
  "los-altos": "Los Altos Library",
  "los-gatos": "Los Gatos Library",
  milpitas: "Milpitas Library",
  saratoga: "Saratoga Library",
  "santa-clara": "Santa Clara City Library",
};

// stripRedundantVenueSuffix used to be mirrored inline here. It drifted from
// the generator's copy (a 10-char base floor instead of 6, no pipe or subtitle
// handling), so both now import the canonical version from lib/venue-suffix.mjs.

function main() {
  void polishDescription; // no-op, just ensures the module loaded cleanly
  const raw = readFileSync(FILE, "utf8");
  const data = JSON.parse(raw);
  const events = data.events;

  let scclVenueChanged = 0;
  let titleStripped = 0;

  for (const e of events) {
    if (e.source === "Santa Clara County Library") {
      const branchVenue = SCCL_CITY_BRANCH[e.city];
      if (branchVenue && e.venue !== branchVenue) {
        e.venue = branchVenue;
        scclVenueChanged++;
      }
    }
    const before = e.title;
    const after = stripRedundantVenueSuffix(before, e.venue);
    if (after && after !== before) {
      e.title = after;
      titleStripped++;
    }
  }

  writeFileAtomic(FILE, JSON.stringify(data, null, 2));
  console.log(`SCCL venue updates: ${scclVenueChanged}`);
  console.log(`Title strips:       ${titleStripped}`);
}

main();
