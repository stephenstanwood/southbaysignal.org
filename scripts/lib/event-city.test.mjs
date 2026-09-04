import assert from "node:assert/strict";
import test from "node:test";

import { rehomeScrapedEvent, resolveEventCity } from "./event-city.mjs";

test("event city follows the venue address, not the sending organization", () => {
  // Campbell Chamber Foundation golf tournament — chamber is in Campbell, the
  // course is at 23600 McKean Rd in south San Jose.
  assert.equal(
    resolveEventCity("campbell", "Cinnabar Hills Golf Club, 23600 McKean Rd, San Jose, CA", "61st Annual Campbell Chamber Foundation Golf Tournament"),
    "san-jose",
  );
  // Same event, other spelling of the same address — still San Jose.
  assert.equal(
    resolveEventCity("campbell", "Cinnabar Hills Golf Club, San Jose, CA", "61st Annual Golf Tournament"),
    "san-jose",
  );
});

test("event city pins landmark venues against a wrong city in the address", () => {
  // The Earthquakes' own list sent "Levi's Stadium, San Jose, CA" for the
  // Sep 19 2026 LAFC match. The stadium is in Santa Clara; the club is branded
  // for San Jose. Without the pin the bad string won and split one game across
  // two city tabs, since every other feed had the same match under santa-clara.
  assert.equal(
    resolveEventCity("san-jose", "Levi's Stadium, San Jose, CA", "San Jose Earthquakes vs. LAFC with USA Scarf Giveaway"),
    "santa-clara",
  );
  // The correctly-addressed copy of the same match is unchanged.
  assert.equal(
    resolveEventCity("santa-clara", "Levi's Stadium, 4900 Marie P. DeBartolo Way, Santa Clara, CA 95054", "San Jose Earthquakes vs. LAFC (Prime Time)"),
    "santa-clara",
  );
  // Pinned venues resolve even when the address names no city at all, which the
  // token count would otherwise pass through to the sender's slug.
  assert.equal(resolveEventCity("santa-clara", "PayPal Park", "Earthquakes vs. Minnesota United FC"), "san-jose");
  assert.equal(resolveEventCity("san-jose", "Shoreline Amphitheatre", "Summer Tour"), "mountain-view");
});

test("event city keeps the extractor's answer when the address is ambiguous", () => {
  // No covered city in the address at all.
  assert.equal(resolveEventCity("campbell", "Cinnabar Hills Golf Club", "61st Annual Golf Tournament"), "campbell");
  assert.equal(resolveEventCity("sunnyvale", "", "Concert in the Park"), "sunnyvale");
  // Two covered cities genuinely named — a joint program across both.
  assert.equal(
    resolveEventCity("campbell", "Sunnyvale Community Center, Sunnyvale — co-hosted with the Cupertino Senior Center", "Joint Senior Social"),
    "campbell",
  );
  // "Santa Clara County" is not a Santa Clara address.
  assert.equal(
    resolveEventCity("campbell", "Santa Clara County Fairgrounds", "County Fair Preview"),
    "campbell",
  );
  // Slugs outside the 11-city map share tokens with their neighbors and can't
  // be reasoned about — monte-sereno vs. los-gatos.
  assert.equal(resolveEventCity("monte-sereno", "Monte Sereno City Hall", "Community Police Academy"), "monte-sereno");
});

test("event city leaves day trips under their departure city", () => {
  assert.equal(
    resolveEventCity("sunnyvale", "San Francisco Zoo & Gardens", "August Day Trip to San Francisco Zoo & Gardens"),
    "sunnyvale",
  );
  assert.equal(
    resolveEventCity("sunnyvale", "Filoli, Woodside, CA", "Senior Center Bus Trip to Filoli"),
    "sunnyvale",
  );
  // A day trip whose destination IS a covered city still stays put.
  assert.equal(
    resolveEventCity("campbell", "Winchester Mystery House, San Jose, CA", "Day Trip to the Winchester Mystery House"),
    "campbell",
  );
});

test("event city ignores streets named after other cities", () => {
  // San José City Hall is on E. Santa Clara St. — the street is not the city,
  // and the accented spelling still has to resolve.
  assert.equal(
    resolveEventCity("san-jose", "San José City Hall, Wing Rooms, 200 E. Santa Clara St., San José", "Community Listening Session"),
    "san-jose",
  );
  assert.equal(
    resolveEventCity("campbell", "The Pruneyard, 1875 S Bascom Ave, Campbell, CA", "Sidewalk Sale"),
    "campbell",
  );
  // A Campbell storefront with a Los Gatos Blvd address stays in Campbell.
  assert.equal(
    resolveEventCity("campbell", "1250 Los Gatos Blvd, Campbell, CA", "Grand Opening"),
    "campbell",
  );
});

test("event city passes through an already-correct address", () => {
  assert.equal(
    resolveEventCity("mountain-view", "Castro Street, Mountain View, CA", "Music on Castro"),
    "mountain-view",
  );
  assert.equal(
    resolveEventCity("palo-alto", "Stanford Shopping Center, Palo Alto, CA", "Sidewalk Sale"),
    "palo-alto",
  );
});
test("event city ignores a city-named street with the suffix truncated off", () => {
  // Ticketmaster publishes SAP Center as "525 W Santa Clara" — no "St". Seven
  // Sharks games and concerts read as santa-clara on that string alone.
  assert.equal(
    resolveEventCity("san-jose", "525 W Santa Clara", "San Jose Sharks vs. Florida Panthers"),
    "san-jose",
  );
  // The trailing city in a full address has no house number in front of it, so
  // it still counts.
  assert.equal(
    resolveEventCity("san-jose", "200 E. Santa Clara St., San José", "Community Listening Session"),
    "san-jose",
  );
  assert.equal(
    resolveEventCity("san-jose", "1600 N Santa Clara St, Santa Clara, CA", "Something in Santa Clara"),
    "santa-clara",
  );
});

test("a scraped event re-homes to the city its own listing names", () => {
  // Hammer Theatre's box office sells SJSU productions staged elsewhere. Both
  // shipped tagged san-jose until 2026-09-04.
  assert.deepEqual(
    rehomeScrapedEvent({
      title: "SJSU Music presents SJSU Choirs: Fall Debut Choral Concert",
      city: "san-jose",
      venue: "Campbell United Methodist Church",
      address: "1675 Winchester Blvd, Campbell, California 95008",
    }).city,
    "campbell",
  );
  assert.equal(
    rehomeScrapedEvent({
      title: "SJSU Music presents SJSU Choirs: Home for the Holidays",
      city: "san-jose",
      venue: "Mission Santa Clara de Asis",
      address: "500 El Camino Real, Santa Clara, CA 95053",
    }).city,
    "santa-clara",
  );
  // Mountain View Public Library program held at Rancho San Antonio.
  assert.equal(
    rehomeScrapedEvent({
      title: "Deer Hollow Spooky Storytime",
      city: "mountain-view",
      venue: "Deer Hollow Farm",
      address: "22500 Cristo Rey Dr, Cupertino, CA",
    }).city,
    "cupertino",
  );
});

test("a scraped event at its publisher's own address is returned untouched", () => {
  const event = {
    title: "Ballet San Jose",
    city: "san-jose",
    venue: "Hammer Theatre Center",
    address: "101 Paseo De San Antonio, San Jose, CA 95113",
  };
  assert.equal(rehomeScrapedEvent(event), event);
  // The venue name is part of the location, so FIXED_VENUE_CITY still applies.
  assert.equal(
    rehomeScrapedEvent({
      title: "San Jose Sharks vs. Edmonton Oilers",
      city: "san-jose",
      venue: "SAP Center at San Jose",
      address: "525 W Santa Clara",
    }).city,
    "san-jose",
  );
  // Nothing to go on, nothing moves.
  assert.equal(rehomeScrapedEvent({ title: "x", city: "sunnyvale" }).city, "sunnyvale");
  assert.equal(rehomeScrapedEvent({ title: "x" }).city, undefined);
});
