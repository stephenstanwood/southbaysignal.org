import test from "node:test";
import assert from "node:assert/strict";

import {
  extractVenueFromTitle,
  stripRedundantVenueSuffix,
  venueTailSegment,
} from "./venue-suffix.mjs";

// ---------------------------------------------------------------------------
// venueTailSegment
// ---------------------------------------------------------------------------

test("venueTailSegment returns the trailing segment of a stuttered venue", () => {
  assert.equal(
    venueTailSegment("AI Center for Civic and Social Good at King Library"),
    "King Library",
  );
  assert.equal(
    venueTailSegment("InSITE2026 (MLK Library) at King Library"),
    "King Library",
  );
});

test("venueTailSegment splits on the LAST ' at '", () => {
  assert.equal(venueTailSegment("Room A at Wing B at King Library"), "King Library");
});

test("venueTailSegment returns null when there is nothing to split", () => {
  assert.equal(venueTailSegment("King Library"), null);
  assert.equal(venueTailSegment("International Student & Scholar Services"), null);
  assert.equal(venueTailSegment(""), null);
  assert.equal(venueTailSegment(null), null);
  assert.equal(venueTailSegment(undefined), null);
  // "Atrium" must not be mistaken for an " at " separator.
  assert.equal(venueTailSegment("Atrium"), null);
  assert.equal(venueTailSegment("Hammer Theatre Atrium"), null);
});

// ---------------------------------------------------------------------------
// extractVenueFromTitle — SJSU's Localist RSS carries no <location>, so every
// SJSU venue is derived from the title here.
// ---------------------------------------------------------------------------

test("extractVenueFromTitle takes the trailing venue, not the program name", () => {
  assert.equal(
    extractVenueFromTitle(
      "Jul 28, 2026: Open Lab Hours at AI Center for Civic and Social Good at King Library",
    ),
    "King Library",
  );
  assert.equal(
    extractVenueFromTitle(
      "Jul 28, 2026: Dr. Sandy Hirsh's keynote at InSITE2026 (MLK Library) at King Library",
    ),
    "King Library",
  );
});

test("extractVenueFromTitle handles the single-' at ' case unchanged", () => {
  assert.equal(
    extractVenueFromTitle("Aug 4, 2026: ISSS Campus Tours at International Student & Scholar Services"),
    "International Student & Scholar Services",
  );
  assert.equal(extractVenueFromTitle("Brass Ensemble at Music Building"), "Music Building");
});

test("extractVenueFromTitle strips the date prefix in every supported form", () => {
  assert.equal(extractVenueFromTitle("Jul 28: Workshop at King Library"), "King Library");
  assert.equal(extractVenueFromTitle("December 3, 2026: Workshop at King Library"), "King Library");
});

test("extractVenueFromTitle rejects city and time tails", () => {
  // Comma tail = "<City>, <State>", handled by the Pattern 1 title strip.
  assert.equal(
    extractVenueFromTitle("Men's Golf -  San Jose State at Palouse Collegiate at Pullman, Wash."),
    null,
  );
  assert.equal(extractVenueFromTitle("Jazz Night at 7 PM"), null);
  assert.equal(extractVenueFromTitle("Reception at Noon"), null);
  assert.equal(extractVenueFromTitle("meetup at the park"), null); // lowercase tail
  assert.equal(extractVenueFromTitle(""), null);
  assert.equal(extractVenueFromTitle(null), null);
});

test("extractVenueFromTitle returns null rather than a venue guessed mid-title", () => {
  // The first-" at " split used to hand back the whole "Cafe Stritch at 7 PM"
  // tail as a venue name. Null lets the caller fall back to the generic campus
  // venue instead of inventing a place.
  assert.equal(extractVenueFromTitle("Jazz Night at Cafe Stritch at 7 PM"), null);
});

// ---------------------------------------------------------------------------
// stripRedundantVenueSuffix — the 2026-07-28 newsletter defect
// ---------------------------------------------------------------------------

test("strips a title suffix naming only the venue's trailing segment", () => {
  // The shape that shipped in the 2026-07-28 issue as "Dr. Sandy Hirsh's
  // keynote at InSITE2026 (MLK Library) at King Library" with the same string
  // repeated on the meta line. Covers already-ingested records whose venue
  // still carries the stutter.
  assert.equal(
    stripRedundantVenueSuffix(
      "Dr. Sandy Hirsh's keynote at InSITE2026 (MLK Library) at King Library",
      "InSITE2026 (MLK Library) at King Library",
    ),
    "Dr. Sandy Hirsh's keynote at InSITE2026 (MLK Library)",
  );
  assert.equal(
    stripRedundantVenueSuffix(
      "Open Lab Hours at AI Center for Civic and Social Good at King Library",
      "AI Center for Civic and Social Good at King Library",
    ),
    "Open Lab Hours at AI Center for Civic and Social Good",
  );
});

test("strips the same titles once the venue has been normalized to its tail", () => {
  // Post-fix ingest path: extractVenueFromTitle now yields "King Library".
  assert.equal(
    stripRedundantVenueSuffix(
      "Dr. Sandy Hirsh's keynote at InSITE2026 (MLK Library) at King Library",
      "King Library",
    ),
    "Dr. Sandy Hirsh's keynote at InSITE2026 (MLK Library)",
  );
  assert.equal(
    stripRedundantVenueSuffix(
      "Open Lab Hours at AI Center for Civic and Social Good at King Library",
      "King Library",
    ),
    "Open Lab Hours at AI Center for Civic and Social Good",
  );
});

test("matches across an undecoded HTML entity on either side", () => {
  // The ISSS record slipped through for weeks because cleanTitle() decodes
  // entities but the venue field is not decoded until ~250 lines later in the
  // generator, so "&" never equalled "&amp;".
  assert.equal(
    stripRedundantVenueSuffix(
      "Isss Campus Tours at International Student & Scholar Services",
      "International Student &amp; Scholar Services",
    ),
    "Isss Campus Tours",
  );
  assert.equal(
    stripRedundantVenueSuffix(
      "Isss Campus Tours at International Student &amp; Scholar Services",
      "International Student & Scholar Services",
    ),
    "Isss Campus Tours",
  );
  assert.equal(
    stripRedundantVenueSuffix(
      "Isss Campus Tours at International Student & Scholar Services",
      "International Student & Scholar Services",
    ),
    "Isss Campus Tours",
  );
});

// ---------------------------------------------------------------------------
// Regression cases — behavior that existed before the tail-segment widening
// ---------------------------------------------------------------------------

test("Pattern 1: drops the SJSU Athletics '<City>, Calif.' tail", () => {
  assert.equal(
    stripRedundantVenueSuffix(
      "Women's Soccer vs. Cal Poly at San Jose, Calif.",
      "San Jose State University",
    ),
    "Women's Soccer vs. Cal Poly",
  );
  assert.equal(
    stripRedundantVenueSuffix("Men's Golf at Pullman, Wash.", "San Jose State University"),
    "Men's Golf at Pullman, Wash.",
  );
});

test("Pattern 2: relaxed branch/library equality", () => {
  assert.equal(
    stripRedundantVenueSuffix("Tech Mentor at Edenvale Branch", "Edenvale Library"),
    "Tech Mentor",
  );
  assert.equal(
    stripRedundantVenueSuffix("Brass Ensemble at Music Building", "Music Building"),
    "Brass Ensemble",
  );
  assert.equal(
    stripRedundantVenueSuffix(
      "SJSU Alumni Night at the SJ Giants at Excite Ballpark",
      "Excite Ballpark",
    ),
    "SJSU Alumni Night at the SJ Giants",
  );
});

test("Pattern 2: preserves a dash subtitle", () => {
  assert.equal(
    stripRedundantVenueSuffix(
      "Poetry Open Mic at the Cupertino Library - Poetry Month Celebration",
      "Cupertino Library",
    ),
    "Poetry Open Mic — Poetry Month Celebration",
  );
});

test("Pattern 3: strips a pipe-appended venue", () => {
  assert.equal(
    stripRedundantVenueSuffix("Spotlight Tours Thursdays | Anderson Collection", "Anderson Collection"),
    "Spotlight Tours Thursdays",
  );
});

test("Pattern 3: leaves a legitimate pipe subtitle alone", () => {
  const title = "Archive Room: Ester Hernandez | Selections from Special Collections at Stanford Libraries";
  assert.equal(stripRedundantVenueSuffix(title, "Green Library"), title);
  // …including when the venue itself carries an " at ", so the new tail
  // widening can't reach the pipe subtitle either.
  assert.equal(stripRedundantVenueSuffix(title, "Peterson Gallery at Green Library"), title);
});

test("leaves unrelated titles and short bases alone", () => {
  assert.equal(
    stripRedundantVenueSuffix("Jazz Night at Cafe Stritch", "Hammer Theatre"),
    "Jazz Night at Cafe Stritch",
  );
  // Base under the 6-char floor — stripping would leave a meaningless title.
  assert.equal(
    stripRedundantVenueSuffix("Yoga at Rose Garden", "Rose Garden"),
    "Yoga at Rose Garden",
  );
  assert.equal(stripRedundantVenueSuffix("", "King Library"), "");
  assert.equal(stripRedundantVenueSuffix(null, "King Library"), null);
  assert.equal(stripRedundantVenueSuffix("Concert at King Library", null), "Concert at King Library");
  assert.equal(stripRedundantVenueSuffix("Concert at King Library", 42), "Concert at King Library");
});

test("a venue that norms away to nothing never matches", () => {
  // norm() drops standalone "branch"/"library" tokens, so venue="Library"
  // reduces to "" — that must not swallow every " at <something>" suffix.
  assert.equal(
    stripRedundantVenueSuffix("Story Time at the Willow Glen Branch", "Library"),
    "Story Time at the Willow Glen Branch",
  );
});

test("is idempotent", () => {
  const cases = [
    ["Dr. Sandy Hirsh's keynote at InSITE2026 (MLK Library) at King Library", "King Library"],
    ["Open Lab Hours at AI Center for Civic and Social Good at King Library", "King Library"],
    ["Isss Campus Tours at International Student & Scholar Services", "International Student & Scholar Services"],
    ["Tech Mentor at Edenvale Branch", "Edenvale Library"],
    ["Spotlight Tours Thursdays | Anderson Collection", "Anderson Collection"],
    ["Poetry Open Mic at the Cupertino Library - Poetry Month Celebration", "Cupertino Library"],
  ];
  for (const [title, venue] of cases) {
    const once = stripRedundantVenueSuffix(title, venue);
    assert.equal(stripRedundantVenueSuffix(once, venue), once, `not idempotent: ${title}`);
  }
});

// ---------------------------------------------------------------------------
// Authored venue names that legitimately contain " at " must survive. Only the
// *title* comparison is widened — venues are never rewritten in place here.
// ---------------------------------------------------------------------------

test("a title that IS the venue name is never stripped", () => {
  // Day-plan place cards carry the business name in both fields, and plenty of
  // real South Bay venues have " at " in their actual name. Collapsing these to
  // their head would rename the place.
  for (const name of [
    "The Spa at Four Seasons Hotel Silicon Valley",
    "Joe's Trail at Cox and de Anza",
    "Cooper-Garrod Vineyards at Garrod Farms",
    "THE MARKET AT EDGEWOOD",
  ]) {
    assert.equal(stripRedundantVenueSuffix(name, name), name);
  }
  // Also when the two sides differ only by the tokens norm() ignores.
  assert.equal(
    stripRedundantVenueSuffix("The Reading Room at Edenvale Branch", "Reading Room at Edenvale Library"),
    "The Reading Room at Edenvale Branch",
  );
});

test("authored '<Org> at <Place>' venues are not treated as defective", () => {
  // Real names in the current data set: collapsing either to its tail would be
  // wrong, and neither title stutters.
  assert.equal(
    stripRedundantVenueSuffix("Wayne Wallace Latin Jazz Quintet", "ASML Next Gen Stage at SJMA"),
    "Wayne Wallace Latin Jazz Quintet",
  );
  assert.equal(
    stripRedundantVenueSuffix("Día de los Muertos Celebration", "School of Arts and Culture at MHP"),
    "Día de los Muertos Celebration",
  );
  // But a title that does stutter the tail still collapses.
  assert.equal(
    stripRedundantVenueSuffix("Summer Jazz Series at SJMA", "ASML Next Gen Stage at SJMA"),
    "Summer Jazz Series",
  );
});
