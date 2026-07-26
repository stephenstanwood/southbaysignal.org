// Tests for the lookout extractor's pure helpers — city normalization, event
// validation/sanitization, and LLM-response fence stripping. The extractEvents
// model call itself isn't unit-tested, but these pin the deterministic logic
// around it (the part that decides what's a valid event and how the raw model
// output is parsed).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeCityKey,
  isValidExtractedEvent,
  sanitizeExtractedEvent,
  sourceUrlAlignsWithTitle,
  stripCodeFence,
  type ExtractedEvent,
} from "./extractor.ts";

const ev = (over: Partial<ExtractedEvent> = {}): ExtractedEvent => ({
  title: "Spring Fair",
  startsAt: "2026-06-01T10:00:00-07:00",
  endsAt: null,
  location: null,
  description: "",
  sourceUrl: null,
  cityName: null,
  ...over,
});

test("normalizeCityKey maps covered cities (case-insensitive) to slugs", () => {
  assert.equal(normalizeCityKey("San Jose"), "san-jose");
  assert.equal(normalizeCityKey("Palo Alto"), "palo-alto");
  assert.equal(normalizeCityKey("MOUNTAIN VIEW"), "mountain-view");
  assert.equal(normalizeCityKey("san-jose"), "san-jose"); // already a slug
});

test("normalizeCityKey returns null for uncovered / empty input", () => {
  assert.equal(normalizeCityKey("Morgan Hill"), null); // outside our geo
  assert.equal(normalizeCityKey("Gilroy"), null);
  assert.equal(normalizeCityKey("Oakland"), null);
  assert.equal(normalizeCityKey(null), null);
  assert.equal(normalizeCityKey(""), null);
});

test("isValidExtractedEvent requires non-empty title + startsAt strings", () => {
  assert.equal(isValidExtractedEvent(ev()), true);
  assert.equal(isValidExtractedEvent({ title: "", startsAt: "2026-06-01T10:00:00-07:00" }), false);
  assert.equal(isValidExtractedEvent({ title: "Fair", startsAt: "" }), false);
  assert.equal(isValidExtractedEvent({ title: "Fair" }), false); // missing startsAt
  assert.equal(isValidExtractedEvent({ startsAt: "2026-06-01" }), false); // missing title
  assert.equal(isValidExtractedEvent(null), false);
  assert.equal(isValidExtractedEvent("nope"), false);
});

test("sanitizeExtractedEvent nulls mailto sourceUrl, keeps http(s)", () => {
  assert.equal(sanitizeExtractedEvent(ev({ sourceUrl: "mailto:hi@x.org" })).sourceUrl, null);
  assert.equal(sanitizeExtractedEvent(ev({ sourceUrl: "https://ex.com/e" })).sourceUrl, "https://ex.com/e");
  assert.equal(sanitizeExtractedEvent(ev({ sourceUrl: null })).sourceUrl, null);
});

test("sanitizeExtractedEvent nulls cross-wired newsletter links", () => {
  const mismatched = sanitizeExtractedEvent(ev({
    title: "San Jose Giants Japanese Heritage Game Night",
    sourceUrl: "https://www.eventbrite.com/e/3rd-annual-aapi-playwright-festival-sj-japantown-guided-tour-tickets-1989767460036",
  }));
  assert.equal(mismatched.sourceUrl, null);
});

test("sourceUrlAlignsWithTitle keeps aligned Eventbrite slugs", () => {
  assert.equal(
    sourceUrlAlignsWithTitle(
      "3rd Annual AAPI Playwright Festival SJ Japantown Guided Tour",
      "https://www.eventbrite.com/e/3rd-annual-aapi-playwright-festival-sj-japantown-guided-tour-tickets-1989767460036",
    ),
    true,
  );
});

test("sourceUrlAlignsWithTitle allows opaque MiLB ticket vendors", () => {
  assert.equal(
    sourceUrlAlignsWithTitle(
      "San Jose Giants Japanese Heritage Game Night",
      "https://mlb.tickets.com/schedule/?agency=MILB_MPV&orgid=56749#/sales_group_code;salesGroupId=13349",
    ),
    true,
  );
});

test("sanitizeExtractedEvent does not mutate its input", () => {
  const original = ev({ sourceUrl: "mailto:hi@x.org" });
  sanitizeExtractedEvent(original);
  assert.equal(original.sourceUrl, "mailto:hi@x.org");
});

test("stripCodeFence unwraps ```json and ``` fences", () => {
  assert.equal(stripCodeFence('```json\n{"events":[]}\n```').trim(), '{"events":[]}');
  assert.equal(stripCodeFence('```\n{"a":1}\n```').trim(), '{"a":1}');
});

test("stripCodeFence recovers the outermost JSON object from chatter", () => {
  assert.equal(stripCodeFence('Sure: {"events":[]} — done').trim(), '{"events":[]}');
});

test("stripCodeFence returns already-clean JSON unchanged", () => {
  assert.equal(stripCodeFence('{"events":[]}').trim(), '{"events":[]}');
});
