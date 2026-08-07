import assert from "node:assert/strict";
import test from "node:test";

import { eventToSchema, isPastEventDate } from "./eventSchema";

test("isPastEventDate compares ISO dates in Pacific time", () => {
  const ref = new Date("2026-08-07T20:00:00Z"); // Aug 7 afternoon PT
  assert.equal(isPastEventDate("2026-08-06", ref), true);
  assert.equal(isPastEventDate("2026-08-07", ref), false);
  assert.equal(isPastEventDate("2026-08-08", ref), false);
  assert.equal(isPastEventDate("not-a-date", ref), false);
});

test("eventToSchema identifies the canonical leaf page and preserves the primary source", () => {
  const pageUrl = "https://southbaytoday.org/event/2026-07-18-summer-concert";
  const sourceUrl = "https://example.org/events/summer-concert";
  const schema = eventToSchema({
    title: "Summer Concert",
    date: "2026-07-18",
    time: "7:00 PM",
    venue: "Town Plaza",
    address: "1 Main St",
    cityName: "Los Gatos",
    organizerUrl: "https://townplaza.example.org",
    url: sourceUrl,
    pageUrl,
    cost: "free",
  });

  assert.ok(schema);
  assert.equal(schema["@id"], `${pageUrl}#event`);
  assert.equal(schema.url, pageUrl);
  assert.equal(schema.sameAs, sourceUrl);
  assert.equal(schema.eventStatus, "https://schema.org/EventScheduled");
  assert.equal(schema.eventAttendanceMode, "https://schema.org/OfflineEventAttendanceMode");
  assert.deepEqual(schema.location, {
    "@type": "Place",
    name: "Town Plaza",
    address: {
      "@type": "PostalAddress",
      addressRegion: "CA",
      addressCountry: "US",
      streetAddress: "1 Main St",
      addressLocality: "Los Gatos",
    },
  });
  assert.deepEqual(schema.offers, {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    url: sourceUrl,
  });
  assert.deepEqual(schema.organizer, {
    "@type": "Organization",
    name: "Town Plaza",
    url: "https://townplaza.example.org/",
  });
});

test("eventToSchema falls back to the primary source when no leaf page is known", () => {
  const sourceUrl = "https://example.org/events/open-house";
  const schema = eventToSchema({
    title: "Open House",
    date: "2026-07-19",
    cityName: "Sunnyvale",
    url: sourceUrl,
  });

  assert.ok(schema);
  assert.equal(schema.url, sourceUrl);
  assert.equal(schema.sameAs, undefined);
});

test("eventToSchema describes explicitly online events as virtual", () => {
  const sourceUrl = "https://example.org/register/author-talk";
  const schema = eventToSchema({
    title: "Online Author Talk",
    date: "2026-07-20",
    venue: "Zoom",
    cityName: "Los Gatos",
    url: sourceUrl,
  });

  assert.ok(schema);
  assert.equal(schema.eventAttendanceMode, "https://schema.org/OnlineEventAttendanceMode");
  assert.deepEqual(schema.location, {
    "@type": "VirtualLocation",
    name: "Zoom",
    url: sourceUrl,
  });
});

test("a source-flagged virtual event emits no physical Place, whatever its venue says", () => {
  // The 2026-08-05 defect in structured-data form: SJSU's RSS gives every
  // event a "San Jose State University" venue, so text matching alone emitted
  // an OfflineEventAttendanceMode Place with a San Jose address for an
  // online-only meeting.
  const sourceUrl = "https://events.sjsu.edu/event/collegiate-recovery-community-crc-all-recovery-meeting";
  const schema = eventToSchema({
    title: "Collegiate Recovery Community (CRC) All Recovery Meeting",
    date: "2026-08-05",
    time: "3:30 PM",
    venue: "San Jose State University",
    cityName: "San Jose",
    virtual: true,
    url: sourceUrl,
  });

  assert.ok(schema);
  assert.equal(schema.eventAttendanceMode, "https://schema.org/OnlineEventAttendanceMode");
  assert.deepEqual(schema.location, {
    "@type": "VirtualLocation",
    // Not "San Jose State University" — that would move the false geography
    // into the structured data instead of removing it.
    name: "Online",
    url: sourceUrl,
  });
});

test("a virtual event drops the venue place-photo but keeps its own art", () => {
  const photoRef = "places/ChIJvaE_uF7Nj4ARJF49qlouHK8/photos/AWCwydiDJG";
  const venuePhoto = eventToSchema({
    title: "CRC All Recovery Meeting",
    date: "2026-08-05",
    venue: "San Jose State University",
    photoRef,
    virtual: true,
  });
  assert.equal(venuePhoto?.image, undefined, "a Places photo of the campus is not this event");

  const ownArt = eventToSchema({
    title: "CRC All Recovery Meeting",
    date: "2026-08-05",
    image: "https://events.sjsu.edu/photos/crc.jpg",
    photoRef,
    virtual: true,
  });
  assert.equal(ownArt?.image, "https://events.sjsu.edu/photos/crc.jpg");

  const inPerson = eventToSchema({
    title: "Jazz on the Plazz",
    date: "2026-08-05",
    venue: "Los Gatos Town Plaza Park",
    photoRef,
  });
  assert.match(String(inPerson?.image), /\/api\/place-photo\?ref=/);
});

test("a virtual-flagged event is never MixedEventAttendanceMode", () => {
  // "in-person" appearing in a venue string can't promote a flagged
  // online-only event to hybrid.
  const schema = eventToSchema({
    title: "Team Sync",
    date: "2026-08-05",
    venue: "Virtual (formerly in-person)",
    cityName: "San Jose",
    virtual: true,
  });
  assert.equal(schema?.eventAttendanceMode, "https://schema.org/OnlineEventAttendanceMode");
});

test("an unflagged in-person event is unaffected by the virtual field", () => {
  const schema = eventToSchema({
    title: "Jazz on the Plazz",
    date: "2026-08-05",
    venue: "Los Gatos Town Plaza Park",
    cityName: "Los Gatos",
    virtual: false,
  });
  assert.equal(schema?.eventAttendanceMode, "https://schema.org/OfflineEventAttendanceMode");
  assert.equal((schema?.location as Record<string, unknown>)["@type"], "Place");
});

test("eventToSchema rejects records without a real title and ISO date", () => {
  assert.equal(eventToSchema({ title: "", date: "2026-07-19" }), null);
  assert.equal(eventToSchema({ title: "Open House", date: "July 19" }), null);
});

test("eventToSchema omits a name-only or invalid organizer", () => {
  const withoutUrl = eventToSchema({
    title: "Community Night",
    date: "2026-07-21",
    venue: "Community Center",
  });
  const invalidUrl = eventToSchema({
    title: "Community Night",
    date: "2026-07-21",
    venue: "Community Center",
    organizerUrl: "javascript:alert(1)",
  });

  assert.ok(withoutUrl);
  assert.ok(invalidUrl);
  assert.equal(withoutUrl.organizer, undefined);
  assert.equal(invalidUrl.organizer, undefined);
});

test("eventToSchema rejects concatenated image origins and falls back safely", () => {
  const malformed = "https://volunteer.openspace.orghttps//s3.amazonaws.com/files.galaxydigital.com/banner.jpg";
  const withFallback = eventToSchema({
    title: "Habitat Restoration",
    date: "2026-08-01",
    image: malformed,
    photoRef: "places/rancho/photo",
  });
  const withoutFallback = eventToSchema({
    title: "Habitat Restoration",
    date: "2026-08-01",
    image: malformed,
  });

  assert.ok(withFallback);
  assert.ok(withoutFallback);
  assert.equal(withFallback.image, "https://southbaytoday.org/api/place-photo?ref=places%2Francho%2Fphoto&w=640&h=480");
  assert.equal(withoutFallback.image, undefined);
});
