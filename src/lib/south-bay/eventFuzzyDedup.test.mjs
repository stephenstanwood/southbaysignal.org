// Tests for fuzzyDedupEvents — the fallback cross-source near-duplicate pass.
// This is load-bearing across 20+ event sources and had zero coverage; these
// pin the merge rules (subset/jaccard title match AND time-or-venue proximity),
// the sports skip, numeric-token distinction, and richness-based keep.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fuzzyDedupEvents } from "./eventFuzzyDedup.mjs";

let _id = 0;
const ev = (over = {}) => ({
  id: over.id ?? `e${_id++}`,
  date: "2026-06-01",
  city: "san-jose",
  title: "Untitled",
  time: null,
  venue: null,
  category: "community",
  ...over,
});

test("collapses subset-title duplicates that share a venue, keeping the richer", () => {
  const events = [
    ev({ id: "bare", title: "Big Truck Day", venue: "City Park" }),
    ev({ id: "rich", title: "LGPNS Big Truck Day", venue: "City Park", description: "A".repeat(300), url: "https://x" }),
  ];
  const { kept, droppedCount } = fuzzyDedupEvents(events);
  assert.equal(droppedCount, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "rich");
});

test("keeps events on different dates", () => {
  const events = [
    ev({ title: "Big Truck Day", venue: "City Park", date: "2026-06-01" }),
    ev({ title: "Big Truck Day", venue: "City Park", date: "2026-06-02" }),
  ];
  assert.equal(fuzzyDedupEvents(events).droppedCount, 0);
});

test("keeps events in different cities", () => {
  const events = [
    ev({ title: "Big Truck Day", venue: "City Park", city: "san-jose" }),
    ev({ title: "Big Truck Day", venue: "City Park", city: "campbell" }),
  ];
  assert.equal(fuzzyDedupEvents(events).droppedCount, 0);
});

test("title match alone is not enough — needs time OR venue proximity", () => {
  const events = [
    ev({ title: "Big Truck Day", venue: "City Park" }),
    ev({ title: "LGPNS Big Truck Day", venue: "Downtown Library Plaza" }), // no shared venue tokens, no times
  ];
  assert.equal(fuzzyDedupEvents(events).droppedCount, 0);
});

test("collapses when start times are within 30 minutes", () => {
  const events = [
    ev({ id: "a", title: "Jazz Jam Ft. Trio", venue: "Break Room", time: "7:00 PM" }),
    ev({ id: "b", title: "SJZ Break Room Jazz Jam Ft. Trio", venue: "Hedley Club", time: "7:15 PM", url: "https://x" }),
  ];
  const { droppedCount } = fuzzyDedupEvents(events);
  assert.equal(droppedCount, 1);
});

test("does not collapse when times differ by more than 30 minutes", () => {
  const events = [
    ev({ title: "Jazz Jam", venue: "Break Room", time: "7:00 PM" }),
    ev({ title: "SJZ Jazz Jam", venue: "Hedley Club", time: "9:00 PM" }),
  ];
  assert.equal(fuzzyDedupEvents(events).droppedCount, 0);
});

test("skips sports events (deduped upstream)", () => {
  const events = [
    ev({ category: "sports", title: "Sharks vs Kings", venue: "SAP Center", time: "7:00 PM" }),
    ev({ category: "sports", title: "Sharks vs Kings", venue: "SAP Center", time: "7:00 PM" }),
  ];
  assert.equal(fuzzyDedupEvents(events).droppedCount, 0);
});

test("numeric tokens prevent merging distinct grade/age bands", () => {
  const events = [
    ev({ title: "Chess Club Grades 1 5", venue: "Library", time: "4:00 PM" }),
    ev({ title: "Chess Club Grades 6 8", venue: "Library", time: "4:00 PM" }),
  ];
  assert.equal(fuzzyDedupEvents(events).droppedCount, 0);
});

test("prefers a sourced duplicate over an unsourced copy with minor extra detail", () => {
  const events = [
    ev({
      id: "older",
      title: "Toddler Time with Malinky Music (bilingual Spanish and English)",
      venue: "Sunnyvale Public Library",
      time: "11:00 AM",
      endTime: "12:00 PM",
      description: "Music performance for ages 2 to 5. Sing and dance with a special music performer. Drop-in; space limited.",
      url: "",
    }),
    ev({
      id: "sourced",
      title: "Toddler Time with Malinky Music",
      venue: "Sunnyvale Public Library",
      time: "11:00 AM",
      description: "Sing and dance with bilingual Spanish and English music performance for ages 2 to 5.",
      url: "https://www.library.sunnyvale.ca.gov/events/calendar-month-view",
    }),
  ];

  const { kept, droppedCount } = fuzzyDedupEvents(events);
  assert.equal(droppedCount, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "sourced");
});

test("collapses exact (title,url) duplicates even when same-source times differ >30min and venues match", () => {
  // Two ingest paths for the same organizer feed (SJMA's direct scraper +
  // the Playwright mirror) can disagree on time — one resolves a real
  // detail-page time, the other defaults to noon — while sharing source,
  // venue, and canonical URL. D51.
  const events = [
    ev({
      id: "sjma-rich", title: "First Fridays: August 2026", venue: "San Jose Museum of Art",
      source: "San Jose Museum of Art", time: "6:00 PM", endTime: "9:00 PM",
      url: "https://sjmusart.org/event/first-fridays-august-2026",
    }),
    ev({
      id: "pw-bare", title: "First Fridays: August 2026", venue: "San Jose Museum of Art",
      source: "San Jose Museum of Art", time: "12:00 PM",
      url: "https://sjmusart.org/event/first-fridays-august-2026",
    }),
  ];
  const { kept, droppedCount } = fuzzyDedupEvents(events);
  assert.equal(droppedCount, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "sjma-rich");
});

test("exact (title,url) dedup requires both title and url to match", () => {
  const events = [
    ev({ id: "a", title: "First Fridays: August 2026", url: "https://sjmusart.org/event/first-fridays-august-2026", time: "6:00 PM" }),
    ev({ id: "b", title: "First Fridays: September 2026", url: "https://sjmusart.org/event/first-fridays-august-2026", time: "6:15 PM" }),
  ];
  assert.equal(fuzzyDedupEvents(events).droppedCount, 0);
});

test("first-party occurrence time wins over a richer aggregator duplicate", () => {
  const officialUrl = "https://my.montalvoarts.org/3230/3231";
  const events = [
    ev({
      id: "official",
      date: "2026-07-17",
      city: "saratoga",
      title: "2026 Marcus Festival: Enter if You Dare, a celebration of The Art and Architecture of Maybe",
      venue: "Montalvo Arts Center",
      source: "Montalvo Arts Center",
      time: "6:00 PM",
      endTime: "10:00 PM",
      url: officialUrl,
      occurrenceEvidence: {
        kind: "first-party-occurrence-page",
        sourceUrl: officialUrl,
        date: "2026-07-17",
      },
    }),
    ev({
      id: "meetup",
      date: "2026-07-17",
      city: "saratoga",
      title: "Enter If You Dare: Art, Music & Nighttime Adventures at Montalvo!",
      venue: "Montalvo Arts Center",
      source: "Meetup",
      time: "5:30 PM",
      endTime: "10:30 PM",
      url: "https://www.meetup.com/example/events/123",
      description: "A much longer aggregator description that used to win richness scoring.".repeat(4),
    }),
  ];

  const { kept, droppedCount } = fuzzyDedupEvents(events);
  assert.equal(droppedCount, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "official");
  assert.equal(kept[0].time, "6:00 PM");
  assert.equal(kept[0].endTime, "10:00 PM");
  assert.equal(kept[0].url, officialUrl);
});

// --- D194: same venue + date, venue name stamped onto one title, typo -------
// The Aug 4 2026 newsletter ran the Hammer Theatre record as its Evening Pick:
// misspelled title, 5:00 PM instead of 6:00, "paid" instead of a free RSVP.
// Both records survived dedup because "Hammer" (the venue, in the title) plus
// the "Texturscape" typo dragged title jaccard to 4/7.
test("collapses a venue-stamped, typo'd ticketing title against the institutional listing", () => {
  const events = [
    ev({
      id: "hammertheatre-030fe2046064ece3",
      date: "2026-08-04",
      title: "Hammer Presents `Texturscape` Hammer2 Gallery Opening Reception",
      venue: "Hammer Theatre Center",
      source: "Hammer Theatre",
      category: "arts",
      time: "5:00 PM",
      cost: "paid",
      description: "",
      url: "https://forms.gle/UDVr6gz84WDHWjp79",
      image: "https://vboblobprod-cdn-01.example.net/198589_event_md_365.png",
    }),
    ev({
      id: "sjsu-fc1b5a4c9ed399fd",
      date: "2026-08-04",
      title: "Opening Reception - Hammer2 Gallery: Texturescape",
      venue: "Hammer Theatre Center",
      source: "SJSU Events",
      category: "arts",
      time: "6:00 PM",
      cost: "free",
      description:
        "Hammer2 Gallery Exhibition: Texturescape Featuring the Work of Nine Local Artists and San José State University Alumni Exhibition Dates: July 18 – November 4, 2026 Reception: Tuesday, August 4, 2026…",
      url: "https://events.sjsu.edu/event/opening-reception-for-the-hammer2-gallery-texturescape",
      photoRef: "places/ChIJxfWisLvMj4ARLNfwpDgtJyY/photos/AWCwydg",
    }),
  ];

  const { kept, droppedCount } = fuzzyDedupEvents(events);
  assert.equal(droppedCount, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "sjsu-fc1b5a4c9ed399fd");
  assert.equal(kept[0].title, "Opening Reception - Hammer2 Gallery: Texturescape");
  assert.equal(kept[0].time, "6:00 PM");
  assert.equal(kept[0].cost, "free");
});

test("survivor holds regardless of input order", () => {
  const a = ev({ id: "form", title: "Hammer Presents `Texturscape` Opening Reception", venue: "Hammer Theatre Center", time: "5:00 PM", url: "https://forms.gle/UDVr6gz84WDHWjp79", description: "x".repeat(600) });
  const b = ev({ id: "edu", title: "Opening Reception - Hammer2 Gallery: Texturescape", venue: "Hammer Theatre Center", time: "6:00 PM", url: "https://events.sjsu.edu/event/opening-reception-for-the-hammer2-gallery-texturescape" });
  assert.equal(fuzzyDedupEvents([a, b]).kept[0].id, "edu");
  assert.equal(fuzzyDedupEvents([b, a]).kept[0].id, "edu");
});

test("a bare form or shortener link loses to a real event page", () => {
  for (const badUrl of ["https://forms.gle/abc123", "https://docs.google.com/forms/d/e/x/viewform", "https://bit.ly/abc", ""]) {
    const events = [
      ev({ id: "bad", title: "Summer Gala Fundraiser", venue: "Civic Hall", time: "7:00 PM", url: badUrl, description: "A".repeat(600) }),
      ev({ id: "page", title: "Summer Gala Fundraiser", venue: "Civic Hall", time: "7:00 PM", url: "https://civichall.example.com/events/summer-gala" }),
    ];
    const { kept, droppedCount } = fuzzyDedupEvents(events);
    assert.equal(droppedCount, 1, `expected collapse for ${badUrl || "(empty)"}`);
    assert.equal(kept[0].id, "page", `expected the event page to win over ${badUrl || "(empty)"}`);
  }
});

test("an institutional (.edu/.gov) event page outranks a commercial one", () => {
  const events = [
    ev({ id: "commercial", title: "Chamber Music Recital", venue: "Concert Hall", time: "7:30 PM", url: "https://tickets.example.com/e/chamber-music", description: "A".repeat(600), endTime: "9:00 PM" }),
    ev({ id: "institutional", title: "Chamber Music Recital", venue: "Concert Hall", time: "7:30 PM", url: "https://events.sjsu.edu/event/chamber-music-recital" }),
  ];
  const { kept, droppedCount } = fuzzyDedupEvents(events);
  assert.equal(droppedCount, 1);
  assert.equal(kept[0].id, "institutional");
});

test("single-character typos merge only on long words, not short ones", () => {
  // "Texturscape"/"Texturescape" must merge…
  assert.equal(
    fuzzyDedupEvents([
      ev({ title: "Texturscape Reception", venue: "Gallery", time: "6:00 PM" }),
      ev({ title: "Texturescape Reception", venue: "Gallery", time: "6:00 PM" }),
    ]).droppedCount,
    1,
  );
  // …while short words a single edit apart stay distinct events.
  assert.equal(
    fuzzyDedupEvents([
      ev({ title: "Bard Reading Circle", venue: "Library", time: "4:00 PM" }),
      ev({ title: "Bird Reading Circle", venue: "Library", time: "4:00 PM" }),
    ]).droppedCount,
    0,
  );
});

test("stripping the venue name does not merge distinct events at that venue", () => {
  const events = [
    ev({ id: "jazz", title: "Hammer Presents: Jazz Night", venue: "Hammer Theatre Center", time: "8:00 PM" }),
    ev({ id: "comedy", title: "Hammer Presents: Comedy Hour", venue: "Hammer Theatre Center", time: "8:00 PM" }),
  ];
  assert.equal(fuzzyDedupEvents(events).droppedCount, 0);
});

test("venue-stripping never collapses a title down to a single residual token", () => {
  // Once "Hammer Theatre Center" is removed, the first title is just
  // {auditions} — which would subset-match {auditions, workshop} and merge an
  // audition with the workshop about it. The ≥2-residual-token guard on the
  // retry is what stops that; the unstripped sets don't match either way.
  const events = [
    ev({ id: "audition", title: "Hammer Theatre Center Auditions", venue: "Hammer Theatre Center", time: "2:00 PM" }),
    ev({ id: "workshop", title: "Auditions Workshop", venue: "Hammer Theatre Center", time: "2:00 PM" }),
  ];
  assert.equal(fuzzyDedupEvents(events).droppedCount, 0);
});

test("venue-stripped retry still requires time or venue proximity", () => {
  const events = [
    ev({ title: "Hammer Presents `Texturscape` Opening Reception", venue: "Hammer Theatre Center", time: "5:00 PM" }),
    ev({ title: "Opening Reception: Texturescape", venue: "Triton Museum of Art", time: "9:00 PM" }),
  ];
  assert.equal(fuzzyDedupEvents(events).droppedCount, 0);
});

test("handles empty and malformed input without throwing", () => {
  assert.deepEqual(fuzzyDedupEvents([]), { kept: [], droppedCount: 0 });
  const messy = [null, { id: "x" }, ev({ title: "Solo Show", venue: "Hall" })];
  const { kept, droppedCount } = fuzzyDedupEvents(messy);
  assert.equal(droppedCount, 0);
  assert.equal(kept.length, 3);
});
