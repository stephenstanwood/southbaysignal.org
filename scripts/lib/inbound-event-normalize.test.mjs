import assert from "node:assert/strict";
import test from "node:test";

import {
  inboundClock,
  JEREMY_FREY_EXHIBITION_URL,
  PAPAHUGS_OCCURRENCE_URL,
  SJ_GIANTS_JAPANESE_HERITAGE_2026_07_26_URL,
  normalizeInboundEventPresentation,
} from "./inbound-event-normalize.mjs";

test("inbound end-of-day and midnight sentinels are not visitor times", () => {
  assert.equal(inboundClock("2026-07-20T23:59:59-07:00"), null);
  assert.equal(inboundClock("2026-07-20T00:00:00-07:00"), null);
  assert.equal(inboundClock("2026-07-20T18:30:00-07:00"), "6:30 PM");
});

test("Jeremy Frey closing day uses official museum hours and exhibition URL", () => {
  assert.deepEqual(normalizeInboundEventPresentation({
    title: "Jeremy Frey: Woven closing",
    startsAt: "2026-07-20T23:59:59-07:00",
    endsAt: null,
    location: "Cantor Arts Center, Stanford University",
    sourceUrl: "https://guides.bloombergconnects.org/example",
  }), {
    time: "11:00 AM",
    endTime: "6:00 PM",
    url: JEREMY_FREY_EXHIBITION_URL,
  });
});

test("PapaHugs uses the museum occurrence page and published end time", () => {
  assert.deepEqual(normalizeInboundEventPresentation({
    title: "David PapaHugs Sharpe concert",
    startsAt: "2026-07-22T11:00:00-07:00",
    endsAt: null,
    location: "Children's Discovery Museum of San Jose Amphitheatre, 180 Woz Way, San Jose, CA 95110",
    sourceUrl: "https://14945.blackbaudhosting.com/14945/page.aspx?pid=196&tab=2&txobjid=generic-ticket",
  }), {
    time: "11:00 AM",
    endTime: "11:45 AM",
    url: PAPAHUGS_OCCURRENCE_URL,
  });
});

test("SJ Giants Japanese Heritage Night uses the official MiLB ticket sales group", () => {
  assert.deepEqual(normalizeInboundEventPresentation({
    title: "San Jose Giants Japanese Heritage Game Night",
    startsAt: "2026-07-26T17:00:00-07:00",
    endsAt: null,
    location: "Excite Ballpark, 588 E Alma Ave, San Jose, CA 95112",
    sourceUrl: "https://www.eventbrite.com/e/3rd-annual-aapi-playwright-festival-sj-japantown-guided-tour-tickets-1989767460036",
  }), {
    time: "5:00 PM",
    endTime: null,
    url: SJ_GIANTS_JAPANESE_HERITAGE_2026_07_26_URL,
  });
});

test("inbound events prefer an explicit canonical URL", () => {
  assert.equal(normalizeInboundEventPresentation({
    title: "Example",
    startsAt: "2026-07-20T18:30:00-07:00",
    canonicalUrl: "https://venue.example.com/events/example",
    sourceUrl: "https://tracker.example.com/example",
  }).url, "https://venue.example.com/events/example");
});
