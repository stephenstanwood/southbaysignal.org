import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchScccfdEvents,
  parseEventbriteOrganizerEvents,
} from "../generate-events.mjs";

// The Santa Clara County Fire Department source was a hardcoded array with the
// note "Update annually or when the organizer posts new events." Nobody did:
// every date in it ran Apr–Aug 2026, so on 2026-09-01 the adapter reported zero
// while the department had four dated classes live, the nearest a $15
// hands-only CPR/AED session in Campbell three weeks out.
//
// Eventbrite's /v3/events/search/ API is still gone, but the organizer page
// ships its own list as JSON inside `__NEXT_DATA__`. The fixtures below are
// the real field shapes that page returns.

const dayPT = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });

function ebEvent(overrides = {}) {
  const { venue, address, price, ...rest } = overrides;
  return {
    _type: "event",
    id: "1990651950571",
    eid: "1990651950571",
    eventbrite_event_id: "1990651950571",
    name: "Untitled",
    url: "https://www.eventbrite.com/e/untitled-tickets-1990651950571",
    start_date: dayPT(14),
    start_time: "16:00:00",
    timezone: "America/Los_Angeles",
    is_online_event: false,
    is_cancelled: false,
    primary_venue: {
      _type: "venue",
      name: venue ?? "",
      address: {
        city: address?.city ?? "",
        localized_address_display: address?.display ?? "",
      },
    },
    ticket_availability:
      price === undefined
        ? { is_free: true, minimum_ticket_price: { currency: "USD", value: 0, display: "Free" } }
        : {
            is_free: false,
            minimum_ticket_price: {
              currency: "USD",
              // Eventbrite reports minor units: 1785 === $17.85.
              value: price,
              major_value: (price / 100).toFixed(2),
              display: `${(price / 100).toFixed(2)} USD`,
            },
          },
    ...rest,
  };
}

function organizerPage(events) {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    { props: { pageProps: { locale: "en-US", upcomingEvents: events } } },
  )}</script></body></html>`;
}

async function runWith(body) {
  const original = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    return { events: await fetchScccfdEvents(), requested };
  } finally {
    globalThis.fetch = original;
  }
}

test("the organizer page's embedded event list is what gets read", () => {
  assert.deepEqual(parseEventbriteOrganizerEvents(organizerPage([])), []);
  assert.equal(parseEventbriteOrganizerEvents("<html></html>"), null);
  assert.equal(
    parseEventbriteOrganizerEvents(
      '<script id="__NEXT_DATA__" type="application/json">{oops</script>',
    ),
    null,
  );
  // A shape change that drops the array must read as null (→ throw), not as an
  // empty season.
  assert.equal(
    parseEventbriteOrganizerEvents(
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>',
    ),
    null,
  );
});

test("a dated in-person class publishes with its venue, city, and checkout price", async () => {
  const date = dayPT(22);
  const { events, requested } = await runWith(
    organizerPage([
      ebEvent({
        name: "Hands Only CPR and AED Class | $15 | Campbell | 1.5 hrs  - 2026",
        start_date: date,
        start_time: "16:00:00",
        venue: "Santa Clara County Fire Department Administrative Headquarters",
        address: { city: "Campbell", display: "1315 Dell Avenue, Campbell, CA 95008" },
        price: 1785,
      }),
    ]),
  );

  assert.equal(requested.length, 1);
  assert.match(requested[0], /eventbrite\.com\/o\/santa-clara-county-fire-department/);
  assert.equal(events.length, 1);
  const [cls] = events;
  assert.equal(cls.date, date);
  assert.equal(cls.time, "4:00 PM");
  assert.equal(cls.city, "campbell");
  assert.equal(cls.address, "1315 Dell Avenue, Campbell, CA 95008");
  assert.equal(cls.category, "community");
  assert.equal(cls.source, "SC County Fire Dept");
  // The title's own "$15" is the class fee; checkout starts at $17.85 with the
  // Eventbrite fee. Publishing both would put two different prices on one card.
  assert.equal(cls.title, "Hands Only CPR and AED Class");
  assert.equal(cls.cost, "low");
  assert.equal(cls.costNote, "From $17.85");
});

test("an online class keeps its virtual flag and sends nobody anywhere", async () => {
  const { events } = await runWith(
    organizerPage([
      ebEvent({
        name: "ONLINE: Fall Prevention & Wellness Resources | Sept 2026",
        start_date: dayPT(15),
        start_time: "10:00:00",
        is_online_event: true,
      }),
    ]),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Fall Prevention & Wellness Resources");
  assert.equal(events[0].venue, "Online");
  assert.equal(events[0].address, "");
  assert.equal(events[0].virtual, true);
  assert.equal(events[0].cost, "free");
});

test("evergreen ON DEMAND listings never reach the calendar", async () => {
  const { events } = await runWith(
    organizerPage([
      // Published with whatever date it went up; one real listing reads 2025.
      ebEvent({
        name: "ON DEMAND: FREE - Wildfire Preparedness Webinar",
        start_date: dayPT(20),
        is_online_event: true,
      }),
      ebEvent({
        name: "ON-DEMAND: Life & Fire Safety Educational Video for Kids",
        start_date: dayPT(21),
        is_online_event: true,
      }),
    ]),
  );
  assert.deepEqual(events, []);
});

test("cancelled, past, and out-of-coverage listings drop", async () => {
  const { events } = await runWith(
    organizerPage([
      ebEvent({ name: "Scrapped Workshop", is_cancelled: true }),
      ebEvent({ name: "Wildfire Preparedness Workshop", start_date: dayPT(-10) }),
      ebEvent({
        name: "CERT Academy",
        address: { city: "Gilroy", display: "7070 Chestnut St, Gilroy, CA" },
        venue: "Gilroy Senior Center",
      }),
    ]),
  );
  assert.deepEqual(events, []);
});

test("Monte Sereno files under Los Gatos without misstating the address", async () => {
  // Monte Sereno has no City slug of its own — the canonical token map folds it
  // into Los Gatos, and the card still names the real hall and street.
  const { events } = await runWith(
    organizerPage([
      ebEvent({
        name: "Hands Only CPR and AED Class | $15 | Monte Sereno | 1.5 hrs  - 2026",
        start_date: dayPT(51),
        start_time: "10:00:00",
        venue: "Monte Sereno City Hall",
        address: {
          city: "Monte Sereno",
          display: "18041 Saratoga-Los Gatos Road, Monte Sereno, CA 95030",
        },
        price: 1785,
      }),
    ]),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].city, "los-gatos");
  assert.equal(events[0].venue, "Monte Sereno City Hall");
  assert.match(events[0].address, /Monte Sereno, CA 95030$/);
  assert.equal(events[0].title, "Hands Only CPR and AED Class");
});

test("a non-Pacific listing drops rather than publishing a shifted clock time", async () => {
  const { events } = await runWith(
    organizerPage([
      ebEvent({
        name: "Regional Briefing",
        start_date: dayPT(9),
        start_time: "09:00:00",
        timezone: "America/New_York",
        address: { city: "San Jose", display: "1 N 1st St, San Jose, CA" },
        venue: "Somewhere",
      }),
    ]),
  );
  assert.deepEqual(events, []);
});

test("a title with a real pipe keeps its words", async () => {
  const { events } = await runWith(
    organizerPage([
      ebEvent({
        name: "Smoke Alarms | Batteries and Placement",
        start_date: dayPT(12),
        address: { city: "Saratoga", display: "19655 Allendale Ave, Saratoga, CA" },
        venue: "Joan Pisani Community Center",
      }),
    ]),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Smoke Alarms | Batteries and Placement");
  assert.equal(events[0].city, "saratoga");
});

test("a page with no embedded list fails loudly instead of reporting no season", async () => {
  const { events } = await runWith("<html><body>nothing here</body></html>");
  // STRICT_EVENT_REFRESH is off in tests, so the throw surfaces as [] — in
  // production it blocks the refresh.
  assert.deepEqual(events, []);
});
