import { test } from "node:test";
import assert from "node:assert/strict";
import { isClockTime, normalizeClockTime } from "./clock-time.mjs";

test("accepts ordinary 12-hour clock times", () => {
  for (const t of ["8pm", "8 PM", "8:00 PM", "10:30am", "12:15 am", "1:05pm", "12pm"]) {
    assert.equal(isClockTime(t), true, t);
  }
});

test("rejects the clipped-hour garbage that reached live event cards", () => {
  // "20pm" / "30pm" are what a scraper emits when its regex matches the
  // minutes half of "8:20pm" / "7:30pm" and drops the hour. These rendered as
  // "20:00 PM" and "30:00 PM" on San Jose Jazz cards.
  for (const t of ["20pm", "30pm", "13pm", "0am", "0:30 pm", "99pm"]) {
    assert.equal(isClockTime(t), false, t);
  }
});

test("rejects out-of-range minutes", () => {
  assert.equal(isClockTime("8:60 PM"), false);
  assert.equal(isClockTime("8:99 PM"), false);
});

test("rejects non-time strings and empties", () => {
  for (const t of ["", null, undefined, "Doors at 8", "all day", "TBD", "8"]) {
    assert.equal(isClockTime(t), false, String(t));
  }
});

test("judges comma-separated session lists on the last token", () => {
  assert.equal(isClockTime("12pm, 1pm, 2pm"), true);
  assert.equal(isClockTime("12pm, 1pm, 30pm"), false);
});

test("normalizes to canonical 8:00 PM form", () => {
  assert.equal(normalizeClockTime("8pm"), "8:00 PM");
  assert.equal(normalizeClockTime("8PM"), "8:00 PM");
  assert.equal(normalizeClockTime("10:30am"), "10:30 AM");
  assert.equal(normalizeClockTime("12:15 am"), "12:15 AM");
  assert.equal(normalizeClockTime("8:00 PM"), "8:00 PM");
});

test("leaves invalid times untouched rather than half-normalizing them", () => {
  // The old normalizer turned these into "20:00 PM" / "30:00 PM".
  assert.equal(normalizeClockTime("20pm"), "20pm");
  assert.equal(normalizeClockTime("30pm"), "30pm");
  assert.equal(normalizeClockTime("8:60 PM"), "8:60 PM");
  assert.equal(normalizeClockTime("all day"), "all day");
});

test("every normalized time round-trips as valid", () => {
  for (const t of ["8pm", "10:30am", "12:15 am", "1:05pm"]) {
    assert.equal(isClockTime(normalizeClockTime(t)), true, t);
  }
});
