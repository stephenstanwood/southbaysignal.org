import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRunWindow } from "../generate-events.mjs";

// Arts venues file a months-long show as ONE feed item whose start date is
// opening day. Every adapter that carried both a start and an end was dropping
// those items on the start date alone, so a show disappeared from the Events
// tab the day after it opened and stayed gone for its whole run. Stanford has
// had the ongoing rule since the exhibit work landed; resolveRunWindow is that
// rule, shared, so MACLA / Montalvo / the Squarespace museums match it.
//
// Fixtures are real rows pulled from the live feeds on 2026-08-31.

const NOW = new Date("2026-09-05T12:00:00-07:00");
const d = (s) => new Date(s);

test("a run that has opened and has not closed is kept as ongoing", () => {
  // maclaarte.org/events/feed/ — "Poetic Utterances" runs Sep 4 – Nov 15.
  // Before this fix it vanished on Sep 5 and stayed gone for ten weeks.
  const run = resolveRunWindow(d("2026-09-04T00:00:00-07:00"), d("2026-11-15T00:00:00-08:00"), NOW, {
    title: "Poetic Utterances: Work by Viviana Paredes",
    description:
      "Supported by MACLA and the Creative Work Fund, this solo exhibition features a new site-specific, immersive installation by San Francisco–based mixed-media artist Viviana Paredes.",
    venue: "MACLA",
  });
  assert.ok(run, "an open exhibition run must survive");
  assert.equal(run.ongoing, true);
  // Anchored to today, not to opening day — the exhibit belongs in the Exhibits
  // section, not filed under a date that has already passed.
  assert.equal(run.date, NOW);
});

test("jamsj's 'Now on View' exhibit survives its own opening day", () => {
  // jamsj.org/upcoming-events?format=json — the museum's only upcoming item,
  // opened Feb 14 and closes Sep 21. It was being dropped outright.
  const run = resolveRunWindow(d("2026-02-14T15:00:00-08:00"), d("2026-09-21T00:00:00-07:00"), NOW, {
    title: 'Now on View: "House Meeting(s): Opening the Door to Redress in San Jose"',
    description: "",
    venue: "Japanese American Museum of San Jose",
  });
  assert.equal(run?.ongoing, true);
});

test("a future event is untouched and keeps its own start date", () => {
  const start = d("2026-10-23T19:30:00-07:00");
  const run = resolveRunWindow(start, null, NOW, {
    title: "MACLA Presents: Diana Gameros in Concert Ft. Magik*Magik",
    description: "",
    venue: "MACLA",
  });
  assert.deepEqual(run, { date: start, ongoing: false });
});

test("a one-night show whose curtain has passed is still past", () => {
  // The whole risk of this change: performances must not become "ongoing"
  // because a multi-hour end time trails the start. Same-evening end < now.
  assert.equal(
    resolveRunWindow(d("2026-09-01T19:30:00-07:00"), d("2026-09-01T22:00:00-07:00"), NOW, {
      title: "50th Annual SF Stand-up Comedy Competition Semi-finals",
      description: "",
      venue: "Montalvo Arts Center",
    }),
    null,
  );
});

test("a still-running series that is not an exhibit stays dropped", () => {
  // A weekly class or workshop can span months without being something you can
  // walk in and see. isOngoingExhibitLike is the gate, and it stays the gate.
  assert.equal(
    resolveRunWindow(d("2026-06-01T18:00:00-07:00"), d("2026-12-01T20:00:00-08:00"), NOW, {
      title: "Beginning Ceramics Workshop",
      description: "A twelve-week hands-on class for adults.",
      venue: "MACLA",
    }),
    null,
  );
});

test("a closed run is past even though it is exhibit-shaped", () => {
  assert.equal(
    resolveRunWindow(d("2026-05-01T00:00:00-07:00"), d("2026-08-01T00:00:00-07:00"), NOW, {
      title: "Summer Group Exhibition",
      description: "Works by regional artists.",
      venue: "MACLA",
    }),
    null,
  );
});

test("a stale start with no end date is past, not open-ended", () => {
  // Missing end must never be read as "runs forever" — that would resurrect
  // every expired single-date listing in the feed.
  assert.equal(
    resolveRunWindow(d("2026-08-01T19:00:00-07:00"), null, NOW, {
      title: "Opening Reception: New Works Exhibition",
      description: "",
      venue: "MACLA",
    }),
    null,
  );
});

test("a missing start is dropped rather than thrown on", () => {
  assert.equal(resolveRunWindow(null, d("2026-11-15T00:00:00-08:00"), NOW, { title: "Exhibition" }), null);
});
