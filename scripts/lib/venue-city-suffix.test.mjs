import test from "node:test";
import assert from "node:assert/strict";

import { cleanVenue, isOrganizationName } from "../generate-events.mjs";

// ---------------------------------------------------------------------------
// cleanVenue — trailing "City, CA 9xxxx" strip
//
// The city token must not span a comma. It used to (`[a-zA-Z\s,]+`), so the
// strip ran backwards past the comma and ate real venue words until it hit a
// period or a digit. "Peter T. Gill Park, Milpitas, CA 95035" shipped as the
// venue "Peter T." — a person's name — in upcoming-events.json on 2026-08-27.
// ---------------------------------------------------------------------------

test("cleanVenue strips the city/state/zip tail without eating the venue name", () => {
  assert.equal(
    cleanVenue("Peter T. Gill Park, Milpitas, CA 95035"),
    "Peter T. Gill Park",
  );
  assert.equal(cleanVenue("Gill Park, Milpitas, CA 95035"), "Gill Park");
  assert.equal(
    cleanVenue("Willow Glen Community & Senior Center, San Jose, CA 95125"),
    "Willow Glen Community & Senior Center",
  );
  assert.equal(
    cleanVenue("Martial Cottle Park, San Jose, CA 95123"),
    "Martial Cottle Park",
  );
});

test("cleanVenue keeps stripping the street address ahead of the city tail", () => {
  assert.equal(
    cleanVenue("History Park, 635 Phelan Ave, San Jose, CA 95112"),
    "History Park",
  );
  assert.equal(cleanVenue("Vasona Park 233 Blossom Hill Rd."), "Vasona Park");
});

test("cleanVenue still drops a bare city suffix with no address", () => {
  assert.equal(cleanVenue("West Valley College, Saratoga"), "West Valley College");
  assert.equal(
    cleanVenue("Sanborn-Skyline County Park, Saratoga, CA"),
    "Sanborn-Skyline County Park",
  );
});

test("cleanVenue leaves a plain venue name alone", () => {
  assert.equal(cleanVenue("Cupertino Library"), "Cupertino Library");
  assert.equal(cleanVenue("Computer History Museum"), "Computer History Museum");
});

// ---------------------------------------------------------------------------
// isOrganizationName — guards the Meetup group-name venue fallback
// ---------------------------------------------------------------------------

test("isOrganizationName catches Meetup group names that are not places", () => {
  for (const name of [
    "South Bay Indoor / Outdoor Activities Group (SBIO)",
    "Santa Clara Bombay Jam Dance Fitness Meetup Group",
    "Bay Area Musicians Meetup",
    "South Bay Brazilian Portuguese Conversation and Culture",
    "Growth Social Volunteering Professionals",
  ]) {
    assert.equal(isOrganizationName(name), true, name);
  }
});

test("isOrganizationName leaves real venue names alone", () => {
  for (const name of [
    "Alberto's Night Club",
    "Roosters Comedy Club",
    "Hacker Dojo",
    "Computer History Museum",
    "Maker Nexus",
    "Willow Glen Community & Senior Center",
  ]) {
    assert.equal(isOrganizationName(name), false, name);
  }
});

test("isOrganizationName tolerates empty input", () => {
  assert.equal(isOrganizationName(""), false);
  assert.equal(isOrganizationName(null), false);
  assert.equal(isOrganizationName(undefined), false);
});

// The street suffix arrives spelled out, not just abbreviated. "St" is
// word-boundary-anchored so it never matched "Street", and the Los Gatos town
// calendar writes it in full — "Civic Center Lawn 110 E. Main Street" shipped as
// the display venue for Oktoberfest and the Art and Wine Festival on 2026-08-28.
test("cleanVenue strips a spelled-out street suffix, not just the abbreviation", () => {
  assert.equal(cleanVenue("Civic Center Lawn 110 E. Main Street"), "Civic Center Lawn");
  assert.equal(cleanVenue("Town Park Plaza 4 Tait Avenue"), "Town Park Plaza");
});

test("cleanVenue keeps a venue whose own name contains a street word", () => {
  assert.equal(cleanVenue("Main Street Cafe"), "Main Street Cafe");
  assert.equal(cleanVenue("Castro Street Plaza"), "Castro Street Plaza");
});
