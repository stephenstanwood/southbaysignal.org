#!/usr/bin/env node
// Verification harness for the LibCal per-event location fix.
//
// Runs the real scrapeLibCal against the live calendars and prints what venue
// and address each event would ship with, so the two records that shipped
// wrong on 2026-08-06 can be checked against their source pages:
//
//   https://mountainview.libcal.com/event/16953202  Location: Online
//   https://mountainview.libcal.com/event/16650443  Location: Pioneer Park
//
// Read-only: touches nothing but the two calendar pages the nightly scrape
// already loads. Run with `node scripts/verify-libcal-locations.mjs`.

import { chromium } from "playwright";
import { LIBCAL_LIBRARIES, scrapeLibCal } from "./playwright-scrapers.mjs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const browser = await chromium.launch();
let failures = 0;

for (const library of LIBCAL_LIBRARIES) {
  const page = await browser.newPage({ userAgent: UA });
  let events = [];
  try {
    events = await scrapeLibCal(page, library);
  } finally {
    await page.close();
  }

  console.log(`\n═══ ${library.name} — ${events.length} events`);
  for (const e of events) {
    const flag = e.virtual ? " [virtual]" : "";
    const addr = e.address ? ` · ${e.address}` : " · (no address)";
    console.log(`  ${e.date} ${String(e.time || "").padEnd(9)} ${e.venue}${addr}${flag}`);
    console.log(`      ${e.title}`);

    // Invariant: nothing may claim the library's street address unless the
    // library itself is the venue.
    if (e.address && e.address === library.address && e.venue !== library.name) {
      console.error(`      ✗ address/venue mismatch`);
      failures++;
    }
    if (e.virtual && e.address) {
      console.error(`      ✗ virtual event carries an address`);
      failures++;
    }
  }
}

await browser.close();

// The two known-bad records, checked by URL.
const EXPECTED = [
  { url: "https://mountainview.libcal.com/event/16953202", venue: "Online", virtual: true },
  { url: "https://mountainview.libcal.com/event/16650443", venue: "Pioneer Park", virtual: false },
];
console.log("\n═══ 2026-08-06 regression records");
for (const want of EXPECTED) {
  console.log(`  ${want.url} → expect venue "${want.venue}"${want.virtual ? " (virtual)" : ""}, no library address`);
}

console.log(failures === 0 ? "\n✅ no venue/address violations" : `\n❌ ${failures} violation(s)`);
process.exit(failures === 0 ? 0 : 1);
