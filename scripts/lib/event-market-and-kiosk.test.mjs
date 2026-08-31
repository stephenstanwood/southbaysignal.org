import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inferCategory,
  isAdminNonEvent,
  isOffRegionUniversityEvent,
} from "../generate-events.mjs";

// Both fixtures below are real strings that reached upcoming-events.json on
// 2026-08-29 and were surfaced on southbaytoday.org city briefings.

test("possessive farmers' markets are markets, not concerts", () => {
  // The rule matched /farmers?\s+market/, which requires whitespace right after
  // "farmer(s)" — so every possessive spelling slipped through. This one landed
  // in `music` off its live-music blurb and ran as a Palo Alto music highlight.
  assert.equal(inferCategory("Downtown Palo Alto Farmers' Market", "", "", "Gilman Street between Hamilton and Forest"), "market");
  // Santana Row's bare possessive title had fallen through to `community`.
  assert.equal(inferCategory("Farmers' Market", "", "", "Santana Row"), "market");
  // Curly apostrophes arrive from feeds that smart-quote their titles.
  assert.equal(inferCategory("Downtown Palo Alto Farmers’ Market", "", "", ""), "market");
});

test("unpossessed farmers markets keep working", () => {
  // These always matched; they are here so a future regex edit cannot quietly
  // trade one spelling for the other.
  assert.equal(inferCategory("Campbell Farmers Market", "", "", "Downtown Campbell"), "market");
  assert.equal(inferCategory("Saratoga Farmers Market", "", "", "West Valley College"), "market");
});

test("civic events hosted at a market stay community", () => {
  // The possessive fix moved this title into range of the farmers-market rule,
  // which runs ahead of the government/civic rule that had been claiming it.
  // A mayor meet-and-greet is civic programming, not a market listing.
  assert.equal(inferCategory("Meet the Mayor at the Farmers' Market", "", "", "Saratoga Farmers' Market"), "community");
});

test("'farmer' without 'market' is not a market", () => {
  assert.notEqual(inferCategory("Farmer Mike Pumpkin Carving", "", "", "Santana Row"), "market");
});

test("front-desk kiosk rows are not events", () => {
  // SJSU's Localist feed publishes visitor sign-in systems as recurring all-day
  // events. These were 8 of the feed's 30 entries, and the city-briefing picker
  // chose "Event Center Check in" as a San José highlight over Chicano Soul Fest.
  assert.equal(
    isAdminNonEvent("Mosaic & USRC Check in Kiosk", "Front desk check in system for visitors at Mosaic & USRC"),
    true,
  );
  assert.equal(
    isAdminNonEvent("Event Center Check in", "Let us know what your up to during your visit"),
    true,
  );
  assert.equal(
    isAdminNonEvent("Aug 31, 2026: Event Center Check in", "Let us know what your up to during your visit"),
    true,
  );
});

test("real events that mention check-in survive", () => {
  // The bare "<place> Check in" arm is ambiguous on its own — attendees really
  // do check in at races and with advisors — so it requires front-desk framing
  // in the blurb before dropping anything.
  assert.equal(isAdminNonEvent("5K Race Packet Check In", "Pick up your bib the morning of the run."), false);
  assert.equal(isAdminNonEvent("Check in with your Advisor", "Drop by to discuss fall classes."), false);
  assert.equal(isAdminNonEvent("Welcome Back Social Mixer", "Meet fellow students."), false);
});

test("regional university alumni events stay in their own region", () => {
  assert.equal(
    isOffRegionUniversityEvent(
      "D.C. Broncos Night at the Nationals + Summer Send-Off Reception",
      "Pregame reception before heading to Nationals Park",
      "Royal Sands Social Club",
    ),
    true,
  );
});

test("parades and guidance are not arts substring matches", () => {
  assert.equal(
    inferCategory("Silicon Valley Pride Parade", "Dance, walk, roll, or cheer along the route.", "", "Downtown San Jose"),
    "community",
  );
  assert.equal(
    inferCategory("Citizenship Day: Naturalization Application Guidance", "Free application help and legal guidance.", "", "Central Park Library"),
    "community",
  );
  assert.equal(
    inferCategory("Leadership Fair", "Free treats, fun games, and leadership opportunities.", "", "SJSU"),
    "community",
  );
});
