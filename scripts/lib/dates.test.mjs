import assert from "node:assert/strict";
import test from "node:test";

import {
  displayEndTime,
  displayTime,
  isoDate,
  isoDateParts,
  parseDate,
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

test("an end time on the next day is dropped rather than rendered as same-day", () => {
  // The real Meetup listing for the Aug 30 2026 Silicon Valley Pride parade:
  // the organizer typed PM for a 10:30 AM step-off and the end landed on Aug 31,
  // which used to print as "10:30 PM – 5:00 PM".
  const start = parseDate("2026-08-30T22:30:00-07:00");
  const end = parseDate("2026-08-31T17:00:00-07:00");
  assert.equal(displayTime(start), "10:30 PM");
  assert.equal(displayEndTime(start, end), null);
});

test("a run that crosses midnight keeps its end time", () => {
  const start = parseDate("2026-08-21T22:00:00-07:00");
  const end = parseDate("2026-08-22T01:00:00-07:00");
  assert.equal(displayEndTime(start, end), "1:00 AM");
});

test("displayEndTime rejects ends at or before the start, and missing values", () => {
  const start = parseDate("2026-09-12T12:00:00-07:00");
  assert.equal(displayEndTime(start, start), null);
  assert.equal(displayEndTime(start, parseDate("2026-09-12T11:00:00-07:00")), null);
  assert.equal(displayEndTime(start, null), null);
  assert.equal(displayEndTime(null, start), null);
});

test("displayEndTime keeps an all-day festival that runs inside twelve hours", () => {
  const start = parseDate("2026-10-03T10:00:00-07:00");
  const end = parseDate("2026-10-03T22:00:00-07:00");
  assert.equal(displayEndTime(start, end), "10:00 PM");
});
