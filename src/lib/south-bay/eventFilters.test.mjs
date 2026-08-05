import test from "node:test";
import assert from "node:assert/strict";
import {
  COVERED_LOCATION,
  LOCAL_DEPARTURE_TRIP,
  OUT_OF_AREA_LOCATION,
  hasOutOfAreaDestination,
  isVirtualEvent,
  resolveVirtualFlag,
  virtualFromSourceSignal,
} from "./eventFilters.mjs";

// The event that shipped as an in-person newsletter destination on
// 2026-08-05. events.sjsu.edu lists it VIRTUAL; nothing in its title or blurb
// says so, and SJSU's RSS defaults every event to the San Jose campus.
const CRC_MEETING = {
  title: "Collegiate Recovery Community (CRC) All Recovery Meeting",
  description:
    "Meet with students exploring recovery and substance-free living in a supportive group",
  venue: "San Jose State University",
  city: "san-jose",
};

// ── isVirtualEvent — text fallback ──

test("virtual title prefixes are caught", () => {
  assert.ok(isVirtualEvent({ title: "Online: Author Talk with Ann Patchett" }));
  assert.ok(isVirtualEvent({ title: "[Virtual] Estate Planning Basics" }));
  assert.ok(isVirtualEvent({ title: "Bay Area Climate Webinar" }));
});

test("a physical event with an incidental word is not virtual", () => {
  assert.ok(!isVirtualEvent({ title: "Live Music on the Plaza" }));
  assert.ok(!isVirtualEvent({ title: "Streamside Nature Walk" }));
});

test("the text fallback alone cannot see the CRC meeting — that is the bug", () => {
  // Documents WHY the source signal exists. If this ever starts returning
  // true from text alone, the regex got broader, not the source signal
  // redundant — keep reading the source field regardless.
  assert.ok(!isVirtualEvent({ title: CRC_MEETING.title, description: CRC_MEETING.description }));
});

// ── isVirtualEvent — explicit flag wins ──

test("an event flagged virtual by its source is virtual with no text marker", () => {
  assert.ok(isVirtualEvent({ ...CRC_MEETING, virtual: true }));
});

test("the flag does not override a text match in the other direction", () => {
  // virtual:false must not un-flag copy that plainly says webinar.
  assert.ok(isVirtualEvent({ title: "Bay Area Climate Webinar", virtual: false }));
});

// ── virtualFromSourceSignal ──

test("Localist experience values map correctly", () => {
  assert.equal(virtualFromSourceSignal("virtual"), true);
  assert.equal(virtualFromSourceSignal("inperson"), false);
  // Hybrid has a real room — it stays a destination.
  assert.equal(virtualFromSourceSignal("hybrid"), false);
});

test("LiveWhale online_type values map correctly", () => {
  assert.equal(virtualFromSourceSignal("Online only"), true);
  assert.equal(virtualFromSourceSignal("Hybrid"), false);
});

test("BiblioCommons booleans and unknowns map correctly", () => {
  assert.equal(virtualFromSourceSignal(true), true);
  assert.equal(virtualFromSourceSignal(false), false);
  // Silence is not an in-person guarantee — null keeps the text fallback.
  assert.equal(virtualFromSourceSignal(null), null);
  assert.equal(virtualFromSourceSignal(undefined), null);
  assert.equal(virtualFromSourceSignal(""), null);
  assert.equal(virtualFromSourceSignal("in-person and outdoors"), false);
  assert.equal(virtualFromSourceSignal("something else entirely"), null);
});

// ── resolveVirtualFlag — the ingest-time decision ──

test("the source's own field flags the CRC meeting the regex misses", () => {
  assert.equal(resolveVirtualFlag(CRC_MEETING, "virtual"), true);
});

test("the regex fallback still applies when the source says nothing", () => {
  assert.equal(resolveVirtualFlag({ title: "Online: Author Talk" }, null), true);
  assert.equal(resolveVirtualFlag({ title: "Online: Author Talk" }, undefined), true);
});

test("an in-person source signal leaves a physical event alone", () => {
  assert.equal(
    resolveVirtualFlag({ title: "Music in the Park", venue: "Plaza de César Chávez" }, "inperson"),
    false,
  );
  assert.equal(resolveVirtualFlag({ title: "Jazz on the Plazz" }, "hybrid"), false);
});

test("either signal is enough — an in-person label cannot override webinar copy", () => {
  // A false positive costs one skipped recommendation; a false negative ships
  // a factual error.
  assert.equal(resolveVirtualFlag({ title: "Bay Area Climate Webinar" }, "inperson"), true);
});

// ── hasOutOfAreaDestination ──

test("out-of-area venue is flagged even when the city slug is in-area", () => {
  // The live case: a Sunnyvale senior-center day trip whose destination is SF.
  assert.ok(
    hasOutOfAreaDestination({
      title: "August Day Trip to San Francisco Zoo & Gardens",
      city: "sunnyvale",
      venue: "San Francisco Zoo & Gardens",
      address: "San Francisco Zoo & Gardens",
    }),
  );
  assert.ok(
    hasOutOfAreaDestination({
      title: "Giants vs. Dodgers Day Trip",
      city: "sunnyvale",
      address: "Oracle Park, San Francisco, CA",
    }),
  );
});

test("in-area events are not flagged", () => {
  assert.ok(
    !hasOutOfAreaDestination({
      title: "Music in the Park",
      city: "san-jose",
      venue: "Plaza de César Chávez",
      address: "194 S Market St, San Jose, CA",
    }),
  );
  assert.ok(!hasOutOfAreaDestination({ address: "Stanford Memorial Church" }));
});

test("an address naming both cities resolves to in-area", () => {
  // Departure-and-destination strings ("leaves from Sunnyvale Community
  // Center") must not strand a genuinely local event.
  assert.ok(
    !hasOutOfAreaDestination({
      address: "Sunnyvale Community Center, 550 E Remington Dr, Sunnyvale, CA",
      venue: "San Francisco Bay Trail trailhead",
    }),
  );
});

test("descriptions are never read for geography", () => {
  // The Kepler's 4/24 regression: a sponsor or beneficiary named in the
  // description is not the event's location.
  assert.ok(
    !hasOutOfAreaDestination({
      title: "Benefit Concert",
      venue: "Montalvo Arts Center",
      address: "15400 Montalvo Rd, Saratoga, CA",
      description: "Proceeds support families in Oakland and Richmond.",
    }),
  );
});

test("empty and missing input is safe", () => {
  assert.ok(!hasOutOfAreaDestination(null));
  assert.ok(!hasOutOfAreaDestination(undefined));
  assert.ok(!hasOutOfAreaDestination({}));
  assert.ok(!hasOutOfAreaDestination(""));
});

// ── shared geography regexes ──

test("south county cities are out of area", () => {
  // Gilroy and Morgan Hill are Santa Clara County but outside coverage.
  assert.ok(OUT_OF_AREA_LOCATION.test("Gilroy Library"));
  assert.ok(OUT_OF_AREA_LOCATION.test("Morgan Hill Library"));
  assert.ok(!COVERED_LOCATION.test("Gilroy Library"));
});

test("day-trip exemption matches the titles ingest relies on", () => {
  // generate-events.mjs uses this to keep city-run outings in the feed.
  for (const title of [
    "August Day Trip to San Francisco Zoo & Gardens",
    "Senior Bus Trip: Monterey Bay Aquarium",
    "September Day Trip to SFMOMA",
  ]) {
    assert.ok(LOCAL_DEPARTURE_TRIP.test(title), title);
  }
  assert.ok(!LOCAL_DEPARTURE_TRIP.test("Maggie Stiefvater: The Dream Thieves"));
});

test("the trip exemption does not leak into the day-plan filter", () => {
  // Ingest keeps these; plan-day must still drop them. Same event, opposite
  // answers by design — this is the contract between the two stages.
  const trip = {
    title: "August Day Trip to San Francisco Zoo & Gardens",
    address: "San Francisco Zoo & Gardens",
  };
  assert.ok(LOCAL_DEPARTURE_TRIP.test(trip.title));
  assert.ok(hasOutOfAreaDestination(trip));
});
