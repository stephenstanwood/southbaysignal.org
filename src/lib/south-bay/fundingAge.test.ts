import test from "node:test";
import assert from "node:assert/strict";

import {
  fundingDateLabel,
  isFreshRound,
  pacificDate,
  pacificDaysAgo,
} from "./fundingAge.ts";

const AUG28_MORNING = Date.parse("2026-08-28T07:17:00-07:00");
const AUG28_LATE = Date.parse("2026-08-28T23:50:00-07:00");

test("pacificDate reads the Pacific calendar day, not the runtime's", () => {
  assert.equal(pacificDate(AUG28_MORNING), "2026-08-28");
  // 11:50 PM PT is already tomorrow in UTC — the old toISOString() bug class.
  assert.equal(pacificDate(AUG28_LATE), "2026-08-28");
});

test("pacificDaysAgo counts calendar days, not noon-anchored deltas", () => {
  // The regression: all morning on Aug 28, an Aug 26 round read "yesterday".
  assert.equal(pacificDaysAgo("2026-08-26", AUG28_MORNING), 2);
  assert.equal(pacificDaysAgo("2026-08-25", AUG28_MORNING), 3);
  assert.equal(pacificDaysAgo("2026-08-27", AUG28_MORNING), 1);
});

test("a round announced this morning is 0 days old, never -1", () => {
  // The old arithmetic returned -1 before noon PT, which also stripped the
  // NEW badge off the freshest card on the page.
  assert.equal(pacificDaysAgo("2026-08-28", AUG28_MORNING), 0);
  assert.ok(isFreshRound(pacificDaysAgo("2026-08-28", AUG28_MORNING)));
});

test("the day rolls over at Pacific midnight, not Pacific noon", () => {
  assert.equal(pacificDaysAgo("2026-08-26", AUG28_LATE), 2);
  assert.equal(
    pacificDaysAgo("2026-08-26", Date.parse("2026-08-29T00:10:00-07:00")),
    3,
  );
});

test("the same card ages identically for every reader's timezone", () => {
  const instant = Date.parse("2026-08-28T07:17:00-07:00");
  const original = process.env.TZ;
  try {
    for (const tz of ["America/Los_Angeles", "UTC", "Asia/Tokyo", "Pacific/Auckland"]) {
      process.env.TZ = tz;
      assert.equal(pacificDaysAgo("2026-08-26", instant), 2, `wrong in ${tz}`);
    }
  } finally {
    process.env.TZ = original;
  }
});

test("isFreshRound covers a two-week window and excludes the future", () => {
  assert.ok(isFreshRound(0));
  assert.ok(isFreshRound(14));
  assert.ok(!isFreshRound(15));
  assert.ok(!isFreshRound(-1));
});

test("fundingDateLabel humanizes inside 30 days", () => {
  assert.equal(fundingDateLabel("2026-08-28", AUG28_MORNING), "today");
  assert.equal(fundingDateLabel("2026-08-27", AUG28_MORNING), "yesterday");
  assert.equal(fundingDateLabel("2026-08-26", AUG28_MORNING), "2d ago");
  assert.equal(fundingDateLabel("2026-08-23", AUG28_MORNING), "5d ago");
  assert.equal(fundingDateLabel("2026-08-21", AUG28_MORNING), "1w ago");
  assert.equal(fundingDateLabel("2026-08-07", AUG28_MORNING), "3w ago");
});

test("fundingDateLabel falls back to an absolute Pacific date past 30 days", () => {
  assert.equal(fundingDateLabel("2026-05-04", AUG28_MORNING), "May 4, 2026");
});

test("a future-dated round shows its date instead of a negative age", () => {
  assert.equal(fundingDateLabel("2026-09-10", AUG28_MORNING), "Sep 10, 2026");
});
