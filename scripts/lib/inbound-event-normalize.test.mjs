import assert from "node:assert/strict";
import test from "node:test";

import {
  inboundClock,
  JEREMY_FREY_EXHIBITION_URL,
  PAPAHUGS_OCCURRENCE_URL,
  SJ_GIANTS_JAPANESE_HERITAGE_2026_07_26_URL,
  SILICON_VALLEY_PRIDE_2026_URL,
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

test("Silicon Valley Pride uses the official parade time, route, and URL", () => {
  assert.deepEqual(normalizeInboundEventPresentation({
    title: "Silicon Valley Pride Parade",
    startsAt: "2026-08-30T10:30:00-07:00",
    endsAt: null,
    location: "Downtown San Jose",
    sourceUrl: "https://cmt.com/participant-check-in",
  }), {
    time: "11:00 AM",
    endTime: "12:30 PM",
    url: SILICON_VALLEY_PRIDE_2026_URL,
    venue: "Downtown San Jose — Julian Street & Market Street to Plaza Park",
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

test("a multi-week program's last date is not an end time", () => {
  // The real Monte Sereno record: an eight-week academy that starts Sep 17 and
  // graduates Nov 12. The extractor stamped the November date with July's
  // -07:00 offset, which lands at 11 PM Pacific on Nov 11 — past the midnight
  // sentinel — and the card read "9:00 AM – 11:00 PM".
  assert.deepEqual(normalizeInboundEventPresentation({
    title: "Community Police Academy",
    startsAt: "2026-09-17T00:00:00-07:00",
    endsAt: "2026-11-12T00:00:00-07:00",
    sourceUrl: "https://www.montesereno.org/civicalerts.aspx?AID=689",
  }), {
    time: null,
    endTime: null,
    url: "https://www.montesereno.org/civicalerts.aspx?AID=689",
  });
});

test("a same-evening end time survives, including one that crosses midnight", () => {
  assert.deepEqual(normalizeInboundEventPresentation({
    title: "Council study session",
    startsAt: "2026-09-17T18:00:00-07:00",
    endsAt: "2026-09-17T20:30:00-07:00",
    sourceUrl: "https://example.gov/agenda",
  }).endTime, "8:30 PM");
  assert.deepEqual(normalizeInboundEventPresentation({
    title: "Late set",
    startsAt: "2026-09-17T22:00:00-07:00",
    endsAt: "2026-09-18T01:00:00-07:00",
    sourceUrl: "https://example.com/show",
  }).endTime, "1:00 AM");
});
