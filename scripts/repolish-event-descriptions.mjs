#!/usr/bin/env node
// One-off cleanup for description-polish regressions stored in
// upcoming-events.json: the sentence-splitter in polishDescription used to
// chop decimals ("1.5") and known-TLD domain names ("sccld.org") at their
// internal periods, then capitalize the next fragment — yielding visible
// regressions like "1. 5-hour workshop", "sccld. Org/accessibility", and
// "@svlg. Org" in scraped event descriptions.
//
// The scraper itself is fixed forward-looking; this script repairs the
// already-stored data in place. Re-runnable: ops on already-clean text are
// no-ops.
//
// Usage: node scripts/repolish-event-descriptions.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, "../src/data/south-bay/upcoming-events.json");

// Common TLDs that appear in scraped event descriptions, plus a handful of
// path extensions ("aspx", "html") that show up in dropped-URL fragments. The
// list is intentionally narrow — broader matches risk catching real sentence
// boundaries like "Library. Comp time…".
const KNOWN_TAILS = [
  "Org", "Com", "Net", "Edu", "Gov", "Io", "Co", "App", "Ai", "Info", "Biz", "Us", "Tv",
  "Aspx", "Html", "Htm", "Php",
];
const TAIL_RE = new RegExp(
  `\\b([a-z][a-z0-9-]{1,})\\.\\s+(${KNOWN_TAILS.join("|")})\\b`,
  "g",
);

function repairDescription(text) {
  if (!text) return text;
  let t = text;

  // Decimals: "1. 5-hour" → "1.5-hour", "24. 3%" → "24.3%". Only fires when
  // the period is followed by whitespace then another digit (not a letter,
  // which would be a real sentence break ending in a single-digit word).
  t = t.replace(/(\b\d+)\.\s+(\d)/g, "$1.$2");

  // Known-TLD hostnames: "sccld. Org" → "sccld.org", "@svlg. Org" → "@svlg.org",
  // "beachboardwalk. Com" → "beachboardwalk.com". Re-applied until stable so
  // multi-segment hosts ("interland3. Donorperfect. Net") collapse fully.
  let prev;
  do {
    prev = t;
    t = t.replace(TAIL_RE, (_, host, tail) => `${host}.${tail.toLowerCase()}`);
  } while (t !== prev);

  return t;
}

function main() {
  const raw = readFileSync(DATA_PATH, "utf8");
  const data = JSON.parse(raw);

  let touched = 0;
  const samples = [];
  for (const evt of data.events ?? []) {
    if (!evt.description) continue;
    const after = repairDescription(evt.description);
    if (after !== evt.description) {
      if (samples.length < 6) {
        samples.push({ id: evt.id, before: evt.description, after });
      }
      evt.description = after;
      touched += 1;
    }
  }

  if (touched === 0) {
    console.log("No regressions found — file unchanged.");
    return;
  }

  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(`Repaired ${touched} event descriptions.\n`);
  for (const s of samples) {
    console.log(`  • ${s.id}`);
    console.log(`      before: ${s.before.slice(0, 140)}`);
    console.log(`      after:  ${s.after.slice(0, 140)}`);
  }
}

main();
