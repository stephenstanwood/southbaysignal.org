import test from "node:test";
import assert from "node:assert/strict";
import {
  COVERED_LOCATION,
  LOCAL_DEPARTURE_TRIP,
  OUT_OF_AREA_LOCATION,
  hasOutOfAreaDestination,
  isVirtualEvent,
} from "./eventFilters.mjs";

// ── isVirtualEvent ──

test("virtual title prefixes are caught", () => {
  assert.ok(isVirtualEvent({ title: "Online: Author Talk with Ann Patchett" }));
  assert.ok(isVirtualEvent({ title: "[Virtual] Estate Planning Basics" }));
  assert.ok(isVirtualEvent({ title: "Bay Area Climate Webinar" }));
});

test("a physical event with an incidental word is not virtual", () => {
  assert.ok(!isVirtualEvent({ title: "Live Music on the Plaza" }));
  assert.ok(!isVirtualEvent({ title: "Streamside Nature Walk" }));
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
