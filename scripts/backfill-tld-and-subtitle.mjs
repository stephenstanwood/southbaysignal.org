#!/usr/bin/env node
// Hot-fix backfill for cycle 110's two follow-ups:
// 1. "COM Ticket Resale…" description fragments — the cycle-110 polish pass
//    mishandled SHOUTY-CASE TLDs (TICKETWEB.COM), the period leaked through
//    the masker, the sentence splitter chopped at the dot, and the trailing
//    ".COM Ticket Resale…" survived into the visible description. Forward
//    fix is the case-insensitive flag on KNOWN_TLDS in generate-events.mjs;
//    this script repairs already-stored events by nulling out descriptions
//    that decay into a leading TLD-only fragment.
// 2. Subtitle-aware suffix strip — "Poetry Open Mic at the Cupertino Library
//    - Poetry Month Celebration" survived cycle 110 because the strict
//    suffix-match couldn't see past the dash. Forward fix is in
//    stripRedundantVenueSuffix; this script applies the same logic to the
//    one (or more) titles already on disk.
//
// Re-runnable: every operation is idempotent.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./lib/io.mjs";
import { stripRedundantVenueSuffix } from "./lib/venue-suffix.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, "../src/data/south-bay/upcoming-events.json");

const TLD_TOKENS = new Set([
  "COM", "ORG", "NET", "EDU", "GOV", "IO", "CO", "APP", "AI",
  "INFO", "BIZ", "US", "TV",
]);

// Drop descriptions whose first word is a bare TLD token. "COM Ticket Resale…",
// "ORG The event…", etc. — these are always the tail end of a hostname that
// got chopped at the period during the polish pass. The surrounding context is
// gone; what's left is unsalvageable.
function isTldOrphan(desc) {
  if (!desc) return false;
  const first = desc.trim().split(/\s+/, 1)[0]?.replace(/[.,]+$/, "");
  return !!first && TLD_TOKENS.has(first);
}

// The subtitle-aware strip used to be mirrored inline here, with a guard that
// skipped titles the generator's strict-equality pass had already handled. The
// canonical stripRedundantVenueSuffix in lib/venue-suffix.mjs now covers both
// cases and is idempotent, so the special-casing is gone.

function main() {
  const raw = readFileSync(DATA_PATH, "utf8");
  const data = JSON.parse(raw);

  const samples = { tld: [], subtitle: [] };
  let tldDropped = 0;
  let subtitleStripped = 0;

  for (const evt of data.events ?? []) {
    if (evt.description && isTldOrphan(evt.description)) {
      if (samples.tld.length < 6) {
        samples.tld.push({ id: evt.id, before: evt.description });
      }
      evt.description = "";
      tldDropped += 1;
    }
    if (evt.title && evt.venue) {
      const next = stripRedundantVenueSuffix(evt.title, evt.venue);
      if (next !== evt.title) {
        if (samples.subtitle.length < 6) {
          samples.subtitle.push({ id: evt.id, before: evt.title, after: next });
        }
        evt.title = next;
        subtitleStripped += 1;
      }
    }
  }

  if (!tldDropped && !subtitleStripped) {
    console.log("No matching events — file unchanged.");
    return;
  }

  writeFileAtomic(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(`Dropped TLD-orphan descriptions: ${tldDropped}`);
  console.log(`Stripped subtitle-aware venue suffix: ${subtitleStripped}\n`);
  for (const s of samples.tld) {
    console.log(`  • ${s.id}`);
    console.log(`      tld-orphan: ${s.before}`);
  }
  for (const s of samples.subtitle) {
    console.log(`  • ${s.id}`);
    console.log(`      before: ${s.before}`);
    console.log(`      after:  ${s.after}`);
  }
}

main();
