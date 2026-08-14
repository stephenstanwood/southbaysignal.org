import assert from "node:assert/strict";
import test from "node:test";

import {
  inboundClock,
  JEREMY_FREY_EXHIBITION_URL,
  PAPAHUGS_OCCURRENCE_URL,
  SJ_GIANTS_JAPANESE_HERITAGE_2026_07_26_URL,
  normalizeInboundEventPresentation,
  resolveInboundCity,
} from "./inbound-event-normalize.mjs";

test("inbound city follows the venue address, not the sending organization", () => {
  // Campbell Chamber Foundation golf tournament — chamber is in Campbell, the
  // course is at 23600 McKean Rd in south San Jose.
  assert.equal(
    resolveInboundCity("campbell", "Cinnabar Hills Golf Club, 23600 McKean Rd, San Jose, CA", "61st Annual Campbell Chamber Foundation Golf Tournament"),
    "san-jose",
  );
  // Same event, other spelling of the same address — still San Jose.
  assert.equal(
    resolveInboundCity("campbell", "Cinnabar Hills Golf Club, San Jose, CA", "61st Annual Golf Tournament"),
    "san-jose",
  );
});

test("inbound city pins landmark venues against a wrong city in the address", () => {
  // The Earthquakes' own list sent "Levi's Stadium, San Jose, CA" for the
  // Sep 19 2026 LAFC match. The stadium is in Santa Clara; the club is branded
  // for San Jose. Without the pin the bad string won and split one game across
  // two city tabs, since every other feed had the same match under santa-clara.
  assert.equal(
    resolveInboundCity("san-jose", "Levi's Stadium, San Jose, CA", "San Jose Earthquakes vs. LAFC with USA Scarf Giveaway"),
    "santa-clara",
  );
  // The correctly-addressed copy of the same match is unchanged.
  assert.equal(
    resolveInboundCity("santa-clara", "Levi's Stadium, 4900 Marie P. DeBartolo Way, Santa Clara, CA 95054", "San Jose Earthquakes vs. LAFC (Prime Time)"),
    "santa-clara",
  );
  // Pinned venues resolve even when the address names no city at all, which the
  // token count would otherwise pass through to the sender's slug.
  assert.equal(resolveInboundCity("santa-clara", "PayPal Park", "Earthquakes vs. Minnesota United FC"), "san-jose");
  assert.equal(resolveInboundCity("san-jose", "Shoreline Amphitheatre", "Summer Tour"), "mountain-view");
});

test("inbound city keeps the extractor's answer when the address is ambiguous", () => {
  // No covered city in the address at all.
  assert.equal(resolveInboundCity("campbell", "Cinnabar Hills Golf Club", "61st Annual Golf Tournament"), "campbell");
  assert.equal(resolveInboundCity("sunnyvale", "", "Concert in the Park"), "sunnyvale");
  // Two covered cities genuinely named — a joint program across both.
  assert.equal(
    resolveInboundCity("campbell", "Sunnyvale Community Center, Sunnyvale — co-hosted with the Cupertino Senior Center", "Joint Senior Social"),
    "campbell",
  );
  // "Santa Clara County" is not a Santa Clara address.
  assert.equal(
    resolveInboundCity("campbell", "Santa Clara County Fairgrounds", "County Fair Preview"),
    "campbell",
  );
  // Slugs outside the 11-city map share tokens with their neighbors and can't
  // be reasoned about — monte-sereno vs. los-gatos.
  assert.equal(resolveInboundCity("monte-sereno", "Monte Sereno City Hall", "Community Police Academy"), "monte-sereno");
});

test("inbound city leaves day trips under their departure city", () => {
  assert.equal(
    resolveInboundCity("sunnyvale", "San Francisco Zoo & Gardens", "August Day Trip to San Francisco Zoo & Gardens"),
    "sunnyvale",
  );
  assert.equal(
    resolveInboundCity("sunnyvale", "Filoli, Woodside, CA", "Senior Center Bus Trip to Filoli"),
    "sunnyvale",
  );
  // A day trip whose destination IS a covered city still stays put.
  assert.equal(
    resolveInboundCity("campbell", "Winchester Mystery House, San Jose, CA", "Day Trip to the Winchester Mystery House"),
    "campbell",
  );
});

test("inbound city ignores streets named after other cities", () => {
  // San José City Hall is on E. Santa Clara St. — the street is not the city,
  // and the accented spelling still has to resolve.
  assert.equal(
    resolveInboundCity("san-jose", "San José City Hall, Wing Rooms, 200 E. Santa Clara St., San José", "Community Listening Session"),
    "san-jose",
  );
  assert.equal(
    resolveInboundCity("campbell", "The Pruneyard, 1875 S Bascom Ave, Campbell, CA", "Sidewalk Sale"),
    "campbell",
  );
  // A Campbell storefront with a Los Gatos Blvd address stays in Campbell.
  assert.equal(
    resolveInboundCity("campbell", "1250 Los Gatos Blvd, Campbell, CA", "Grand Opening"),
    "campbell",
  );
});

test("inbound city passes through an already-correct address", () => {
  assert.equal(
    resolveInboundCity("mountain-view", "Castro Street, Mountain View, CA", "Music on Castro"),
    "mountain-view",
  );
  assert.equal(
    resolveInboundCity("palo-alto", "Stanford Shopping Center, Palo Alto, CA", "Sidewalk Sale"),
    "palo-alto",
  );
});

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
