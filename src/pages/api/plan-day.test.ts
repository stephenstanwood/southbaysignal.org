// Minimal test harness for plan-day's pure math helpers. Protects the
// brittle time-parsing + blurb-fallback logic against regressions.
//
// Run: npm run test:plan-day
//
// These tests intentionally stay tiny — the goal is tripwires for the
// functions Stephen already debugged once, not exhaustive coverage.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseHour, timeBlockFromEventTime, fallbackBlurb } from "./plan-day.ts";

test("parseHour: AM/PM", () => {
  assert.equal(parseHour("9:00 AM"), 9);
  assert.equal(parseHour("12:00 AM"), 0);
  assert.equal(parseHour("12:00 PM"), 12);
  assert.equal(parseHour("7:30 PM"), 19);
  assert.equal(parseHour("11:45 PM"), 23);
});

test("parseHour: 24h", () => {
  assert.equal(parseHour("09:00"), 9);
  assert.equal(parseHour("23:15"), 23);
});

test("parseHour: unparseable", () => {
  assert.equal(parseHour("TBD"), null);
  assert.equal(parseHour("all day"), null);
  assert.equal(parseHour(""), null);
});

test("timeBlockFromEventTime: explicit end", () => {
  assert.equal(
    timeBlockFromEventTime("7:00 PM", "9:00 PM"),
    "7:00 PM - 9:00 PM",
  );
});

test("timeBlockFromEventTime: no end defaults to +90 min", () => {
  assert.equal(timeBlockFromEventTime("7:00 PM"), "7:00 PM - 8:30 PM");
  assert.equal(timeBlockFromEventTime("11:00 AM"), "11:00 AM - 12:30 PM");
});

test("timeBlockFromEventTime: null/invalid falls back", () => {
  assert.equal(timeBlockFromEventTime(null), "7:00 PM - 8:30 PM");
  assert.equal(timeBlockFromEventTime("TBD"), "7:00 PM - 8:30 PM");
});

test("timeBlockFromEventTime: sports show start time only", () => {
  assert.equal(
    timeBlockFromEventTime("7:00 PM", null, undefined, "sports"),
    "7:00 PM",
  );
  assert.equal(
    timeBlockFromEventTime("5:00 PM", null, undefined, "sports"),
    "5:00 PM",
  );
  // Explicit endTime still wins, even for sports
  assert.equal(
    timeBlockFromEventTime("7:00 PM", "10:00 PM", undefined, "sports"),
    "7:00 PM - 10:00 PM",
  );
});

test("fallbackBlurb: deterministic per-name", () => {
  const a1 = fallbackBlurb("event", "food", "Taco Festival", null);
  const a2 = fallbackBlurb("event", "food", "Taco Festival", null);
  assert.equal(a1, a2, "same name → same blurb every render");
});

test("fallbackBlurb: different names can differ", () => {
  const names = ["A", "B", "C", "D", "E", "F", "G"].map((n) =>
    fallbackBlurb("event", "music", `Show ${n}`, null),
  );
  // Pool is small but hash distribution should yield at least 2 distinct.
  assert.ok(new Set(names).size >= 2, "deterministic but varied");
});

test("fallbackBlurb: unknown category falls to events pool", () => {
  const out = fallbackBlurb("event", "space-travel-jamboree", "Rocket Night", null);
  assert.ok(out.length > 0);
  assert.ok(!out.includes("swing by"), "never the 'swing by X' anti-pattern");
});

test("fallbackBlurb: place + known category", () => {
  const out = fallbackBlurb("place", "food", "Luna Mexican Kitchen", null);
  assert.ok(out.length > 0);
  assert.ok(!out.startsWith("Quick stop"), "specific category should not hit last-ditch");
});

test("fallbackBlurb: truly unknown source/category → last ditch", () => {
  const out = fallbackBlurb("place", "__missing__", "Test Place", null);
  // Falls back to events pool for places, should produce a real blurb.
  assert.ok(out.length > 0);
});
