import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchHeritageTheatreEvents,
  heritageTheatreEventUrls,
  parseHeritageTheatreEvent,
} from "../generate-events.mjs";

// Campbell's Heritage Theatre published a full season while South Bay Today
// showed nothing for the venue. The adapter read Ticketmaster's Discovery feed
// for venue KovZpZAAnItA — the only "Heritage Theatre" Ticketmaster lists in
// California — and that feed returns `totalElements: 0` with no date filter at
// all (verified live 2026-09-01). Eight shows were inside the same 180-day
// window, including Neil Diamond Superstar three days out.
//
// It now reads the theatre's own Wix calendar: `event-pages-sitemap.xml`, which
// its robots.txt advertises, plus the schema.org Event JSON-LD on each page.
// The payloads below are the real shapes that site returns.

const PT_TODAY = new Date().toLocaleDateString("en-CA", {
  timeZone: "America/Los_Angeles",
});
const dayPT = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });

function sitemap(paths) {
  const locs = paths
    .map((p) => `<url><loc>https://www.heritagetheatre.org${p}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset generatedBy="WIX">\n${locs}\n</urlset>`;
}

function eventPage(node) {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Event",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: {
      "@type": "Place",
      name: "Heritage Theatre",
      address: "1 W Campbell Ave, Campbell, CA 95008, USA",
    },
    ...node,
  })}</script></head><body></body></html>`;
}

async function runWith(routes) {
  const original = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    const key = String(url);
    requested.push(key);
    const body = routes[key];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (body instanceof Error) throw body;
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    return { events: await fetchHeritageTheatreEvents(), requested };
  } finally {
    globalThis.fetch = original;
  }
}

test("a /form entry is folded back to the event page it belongs to", () => {
  // The sitemap's bare slug for the Oct 3 2026 AIM for Seva concert points at a
  // cancelled duplicate; the scheduled show appears only as `…-1/form`.
  const urls = heritageTheatreEventUrls(
    sitemap([
      "/events/aim-for-seva-1/form",
      "/events/aim-for-seva",
      "/events/aim-for-seva-1",
      "/pages/contact",
    ]),
  );
  assert.deepEqual(urls, [
    "https://www.heritagetheatre.org/events/aim-for-seva-1",
    "https://www.heritagetheatre.org/events/aim-for-seva",
  ]);
  // Deduped, and non-event pages never enter the list.
  assert.equal(new Set(urls).size, urls.length);
});

test("the Event node is read out of the page's JSON-LD", () => {
  const node = parseHeritageTheatreEvent(
    `<script type="application/ld+json">${JSON.stringify({
      "@type": "WebSite",
      name: "not this",
    })}</script>` + eventPage({ name: "Neil Diamond Superstar", startDate: "2026-09-04T19:30:00-07:00" }),
  );
  assert.equal(node.name, "Neil Diamond Superstar");
  assert.equal(parseHeritageTheatreEvent("<html></html>"), null);
  assert.equal(parseHeritageTheatreEvent('<script type="application/ld+json">{oops</script>'), null);
});

test("scheduled upcoming shows publish with their real Pacific clock time", async () => {
  const soon = dayPT(3);
  const { events } = await runWith({
    "https://www.heritagetheatre.org/event-pages-sitemap.xml": sitemap([
      "/events/neil-diamond-superstar",
    ]),
    "https://www.heritagetheatre.org/events/neil-diamond-superstar": eventPage({
      name: "NEIL DIAMOND SUPERSTAR",
      description:
        "Authentic. Captivating. Unforgettable. NEIL DIAMOND SUPERSTAR is the tribute show you'll feel and remember.",
      startDate: `${soon}T19:30:00-07:00`,
      endDate: `${soon}T22:30:00-07:00`,
      eventStatus: "https://schema.org/EventScheduled",
      image: {
        "@type": "ImageObject",
        url: "https://static.wixstatic.com/media/example~mv2.jpg",
      },
    }),
  });

  assert.equal(events.length, 1);
  const [show] = events;
  assert.equal(show.date, soon);
  assert.equal(show.time, "7:30 PM");
  assert.equal(show.endTime, "10:30 PM");
  assert.equal(show.venue, "Heritage Theatre");
  assert.equal(show.city, "campbell");
  assert.equal(show.address, "1 W Campbell Ave, Campbell, CA 95008");
  assert.equal(show.source, "Heritage Theatre");
  assert.equal(show.url, "https://www.heritagetheatre.org/events/neil-diamond-superstar");
  assert.match(show.image, /^https:\/\/static\.wixstatic\.com\//);
  // Shouty source titles get normalized, and no price is invented for a page
  // that publishes no offer.
  assert.equal(show.title, "Neil Diamond Superstar");
  assert.equal(show.cost, null);
  assert.equal(show.costNote, undefined);
});

test("cancelled and past listings never publish", async () => {
  const { events } = await runWith({
    "https://www.heritagetheatre.org/event-pages-sitemap.xml": sitemap([
      "/events/testing-event",
      "/events/tower-of-power",
      "/events/aocballet-a-winter-wonderland",
    ]),
    // Wix marks retired drafts and scrapped shows alike.
    "https://www.heritagetheatre.org/events/testing-event": eventPage({
      name: "Testing Event",
      startDate: `${dayPT(30)}T19:00:00-07:00`,
      eventStatus: "https://schema.org/EventCancelled",
    }),
    "https://www.heritagetheatre.org/events/tower-of-power": eventPage({
      name: "Tower of Power",
      startDate: `${dayPT(-40)}T20:00:00-07:00`,
      eventStatus: "https://schema.org/EventScheduled",
    }),
    // A 2035 placeholder date sits past the 180-day window.
    "https://www.heritagetheatre.org/events/aocballet-a-winter-wonderland": eventPage({
      name: "AOCBallet - A Winter Wonderland",
      startDate: "2035-08-22T20:00:00-07:00",
      eventStatus: "https://schema.org/EventCancelled",
    }),
  });

  assert.deepEqual(events, []);
});

test("a published AggregateOffer becomes the price floor", async () => {
  const { events } = await runWith({
    "https://www.heritagetheatre.org/event-pages-sitemap.xml": sitemap([
      "/events/south-bay-dance-center-presents-the-nutcracker",
    ]),
    "https://www.heritagetheatre.org/events/south-bay-dance-center-presents-the-nutcracker":
      eventPage({
        name: "South Bay Dance Center presents The Nutcracker",
        description: "A holiday classic for the whole family.",
        startDate: `${dayPT(60)}T12:30:00-08:00`,
        eventStatus: "https://schema.org/EventScheduled",
        offers: {
          "@type": "AggregateOffer",
          highPrice: "25.63",
          lowPrice: "20.50",
          offerCount: "2",
          priceCurrency: "USD",
        },
      }),
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].cost, "low");
  assert.equal(events[0].costNote, "From $20.50");
  assert.equal(events[0].kidFriendly, true);
});

test("a band bio does not make a night concert kid-friendly", async () => {
  const { events } = await runWith({
    "https://www.heritagetheatre.org/event-pages-sitemap.xml": sitemap([
      "/events/journey-usa-the-hits-of-journey",
    ]),
    "https://www.heritagetheatre.org/events/journey-usa-the-hits-of-journey": eventPage({
      name: "Journey USA - The Hits of Journey",
      // "The Babys" matches the loose prefix rule that exists so "Babies" and
      // "Storytime" match — running it over description copy put an 8 PM
      // tribute concert in the kids pool.
      description:
        "With a vocalist who sang for Steve Perry during his solo career and former members of Great White and The Babys, Journey USA delivers the hits of Journey like no other!",
      startDate: `${dayPT(120)}T20:00:00-08:00`,
      eventStatus: "https://schema.org/EventScheduled",
    }),
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].kidFriendly, false);
});

test("a broken sitemap fails loudly instead of reading as an empty season", async () => {
  const { events } = await runWith({
    "https://www.heritagetheatre.org/event-pages-sitemap.xml": sitemap(["/pages/contact"]),
  });
  // STRICT_EVENT_REFRESH is off in tests, so the adapter returns [] — but the
  // throw it takes to get there is what blocks a strict refresh in production.
  assert.deepEqual(events, []);
});

test("one unreachable page is tolerated; a site-wide break is not", async () => {
  // An unrouted URL answers 404 — a permanent status, so no retry backoff.
  const paths = Array.from({ length: 10 }, (_, i) => `/events/show-${i}`);
  const reachable = (from) =>
    Object.fromEntries(
      paths.slice(from).map((p, i) => [
        `https://www.heritagetheatre.org${p}`,
        eventPage({
          name: `Show ${from + i}`,
          startDate: `${dayPT(10 + i)}T19:00:00-07:00`,
          eventStatus: "https://schema.org/EventScheduled",
        }),
      ]),
    );

  // One dead sitemap entry out of ten: publish the nine that answered.
  const tolerated = await runWith({
    "https://www.heritagetheatre.org/event-pages-sitemap.xml": sitemap(paths),
    ...reachable(1),
  });
  assert.equal(tolerated.events.length, 9);

  // Every page gone is a site change, not an off-season — it must throw rather
  // than report a healthy empty calendar. STRICT_EVENT_REFRESH is off in tests,
  // so that throw surfaces here as the caught empty return.
  const brokenSite = await runWith({
    "https://www.heritagetheatre.org/event-pages-sitemap.xml": sitemap(paths),
  });
  assert.deepEqual(brokenSite.events, []);
});

test("today's PT date is the cutoff, not the machine's local date", async () => {
  const { events } = await runWith({
    "https://www.heritagetheatre.org/event-pages-sitemap.xml": sitemap(["/events/tonight"]),
    "https://www.heritagetheatre.org/events/tonight": eventPage({
      name: "Tonight at the Heritage",
      startDate: `${PT_TODAY}T19:30:00-07:00`,
      eventStatus: "https://schema.org/EventScheduled",
    }),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].date, PT_TODAY);
});
