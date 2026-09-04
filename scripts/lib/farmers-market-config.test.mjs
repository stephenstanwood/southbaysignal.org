// Offline invariants on the projected-market config in generate-events.mjs.
//
// These markets are the one event source the pipeline projects forward instead
// of scraping per-occurrence, so a config typo doesn't fail loudly — it just
// silently publishes the wrong thing, or nothing. Both happened:
//
//   * Mountain View and Santana Row went dark for weeks because their evidence
//     patterns had drifted off the organizer pages' wording. sourceHealth still
//     showed the farmers-market source as "ok" the whole time, because the
//     other five markets were fine.
//   * Mountain View publishes six Sundays where the market moves to the Hope
//     St. lots. A relocation keyed to a date that isn't the market's weekday
//     would never fire and nobody would know.
//
// Nothing here touches the network: verifyMarketScheduleSource still has to
// confirm each page at run time, and these checks only guarantee the config it
// is handed is internally coherent.

import assert from "node:assert/strict";
import test from "node:test";

import { FARMERS_MARKETS } from "../generate-events.mjs";

test("every projected market carries a complete, verifiable config", () => {
  assert.ok(FARMERS_MARKETS.length > 0);
  for (const m of FARMERS_MARKETS) {
    assert.ok(m.title, "market needs a title");
    assert.match(m.url, /^https:\/\//, `${m.title}: source must be https`);
    assert.ok(Number.isInteger(m.day) && m.day >= 0 && m.day <= 6, `${m.title}: bad weekday`);
    assert.ok(m.city, `${m.title}: needs a city`);
    assert.ok(m.venue && m.address, `${m.title}: needs a venue and address`);
    // verifyMarketScheduleSource refuses to confirm on fewer than three, so a
    // market configured with two would be permanently suppressed.
    assert.ok(
      Array.isArray(m.evidencePatterns) && m.evidencePatterns.length >= 3,
      `${m.title}: needs at least 3 evidence patterns`,
    );
    for (const p of m.evidencePatterns) {
      assert.ok(p instanceof RegExp, `${m.title}: evidence patterns must be regexes`);
    }
    const [from, to] = m.season;
    assert.ok(from >= 1 && to <= 12 && from <= to, `${m.title}: bad season window`);
  }
});

test("date-keyed exceptions land on the market's own weekday", () => {
  const weekdayOf = (iso) => new Date(`${iso}T12:00:00-07:00`).getDay();
  for (const m of FARMERS_MARKETS) {
    for (const date of m.excludedDates ?? []) {
      assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `${m.title}: excludedDates must be ISO`);
      assert.equal(weekdayOf(date), m.day, `${m.title}: excluded ${date} is not a market day`);
    }
    for (const [date, alt] of Object.entries(m.relocations ?? {})) {
      assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `${m.title}: relocations must be keyed by ISO date`);
      assert.equal(weekdayOf(date), m.day, `${m.title}: relocation ${date} is not a market day`);
      assert.ok(alt.venue, `${m.title}: relocation ${date} needs a venue`);
      assert.ok(alt.address, `${m.title}: relocation ${date} needs an address`);
      assert.notEqual(alt.venue, m.venue, `${m.title}: relocation ${date} repeats the usual venue`);
    }
  }
});

test("Mountain View's published alternate-location Sundays are all configured", () => {
  const mv = FARMERS_MARKETS.find((m) => m.title === "Mountain View Farmers Market");
  assert.ok(mv, "Mountain View market is configured");
  // The six "Market Relocates" notices on the CAFMA page as of 2026-09-04.
  assert.deepEqual(Object.keys(mv.relocations).sort(), [
    "2026-09-20", "2026-09-27", "2026-10-04",
    "2026-11-08", "2026-11-29", "2026-12-13",
  ]);
});
