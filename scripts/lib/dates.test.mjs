import assert from "node:assert/strict";
import test from "node:test";

import {
  displayTime,
  isoDate,
  isoDateParts,
  parseDatePT,
  recurringWeekdayDates,
} from "./dates.mjs";

test("date-only BiblioCommons occurrences stay all-day on the source date", () => {
  for (const sourceDate of ["2026-03-01", "2026-08-15", "2026-11-30"]) {
    const occurrence = parseDatePT(sourceDate);
    assert.equal(isoDate(occurrence), sourceDate);
    assert.equal(displayTime(occurrence), null);
  }
});

test("Saturday recurrence cannot emit the preceding Friday in a UTC runner", () => {
  assert.equal(isoDateParts("2026-08-14").weekday, 5);
  assert.equal(isoDateParts("2026-08-15").weekday, 6);
  assert.deepEqual(
    recurringWeekdayDates("2026-08-14", 6, 14),
    ["2026-08-15", "2026-08-22"],
  );
});
