import test from "node:test";
import assert from "node:assert/strict";

import { formatAge, resolvePostAgeHours } from "./postAge";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 7, 4, 14, 0, 0); // 2026-08-04T14:00:00Z
const secondsAgo = (hours: number) => (NOW - hours * HOUR) / 1000;

test("formatAge humanizes each bucket", () => {
  assert.equal(formatAge(0), "now");
  assert.equal(formatAge(0.4), "now");
  assert.equal(formatAge(1), "1h ago");
  assert.equal(formatAge(5.4), "5h ago");
  assert.equal(formatAge(23), "23h ago");
  assert.equal(formatAge(24), "1d ago");
  assert.equal(formatAge(480), "20d ago");
});

test("age is measured from createdUtc, not the stored value", () => {
  // The live defect: the generator stalled for 20 days and every tile kept
  // rendering its write-time ageHours.
  const hours = resolvePostAgeHours(secondsAgo(480), 1.2, NOW);
  assert.equal(formatAge(hours), "20d ago");
  assert.notEqual(formatAge(hours), formatAge(1.2));
});

test("a fresh post still reads fresh", () => {
  assert.equal(formatAge(resolvePostAgeHours(secondsAgo(2), 2, NOW)), "2h ago");
});

test("falls back to the stored value before the clock is read", () => {
  // SSR and first paint pass nowMs === null; using the stored value there is
  // what keeps the server HTML and the hydrated tree identical.
  assert.equal(resolvePostAgeHours(secondsAgo(480), 1.2, null), 1.2);
});

test("falls back to the stored value when createdUtc is missing", () => {
  assert.equal(resolvePostAgeHours(undefined, 3.5, NOW), 3.5);
  assert.equal(resolvePostAgeHours(NaN, 3.5, NOW), 3.5);
});

test("a timestamp ahead of the client clock reads as now, never negative", () => {
  const hours = resolvePostAgeHours(secondsAgo(-3), 0, NOW);
  assert.equal(hours, 0);
  assert.equal(formatAge(hours), "now");
});
