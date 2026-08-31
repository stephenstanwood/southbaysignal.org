import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchStanfordEvents } from "../generate-events.mjs";

// Stanford's Localist API returns ONE ROW PER OCCURRENCE. `first_date` and
// `last_date` bound the series; `event_instances[].event_instance.start` is the
// occurrence, and it is the only field with a Pacific offset and a clock time.
//
// The adapter read the occurrence off `first_date`, a bare calendar date, so
// `new Date()` resolved it to midnight UTC — the prior Pacific afternoon. Every
// timed Stanford event published a day early with a fabricated "5:00 PM" start
// (4:00 PM in winter) that no Stanford listing had ever claimed. Verified
// against events.stanford.edu on 2026-08-31: the Anne Wojcicki fireside chat is
// listed "Wednesday, September 2, 2026 / 12pm to 1pm PT" and was being
// published as Sep 1, 5:00 PM.

const PT = "America/Los_Angeles";
const dayPT = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toLocaleDateString("en-CA", { timeZone: PT });
};

function localistEvent(overrides = {}) {
  const { instances = [], ...rest } = overrides;
  return {
    event: {
      id: 1,
      title: "Untitled",
      description_text: "",
      location_name: "Cantor Arts Center",
      address: "328 Lomita Dr",
      free: false,
      experience: "inperson",
      localist_url: "https://events.stanford.edu/event/untitled",
      first_date: dayPT(1),
      last_date: dayPT(1),
      event_instances: instances.map((i) => ({ event_instance: i })),
      ...rest,
    },
  };
}

async function runWith(events) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ events }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    return await fetchStanfordEvents();
  } finally {
    globalThis.fetch = original;
  }
}

test("a dated event takes its day and clock from the occurrence, not first_date", async () => {
  const tomorrow = dayPT(1);
  const [event] = await runWith([
    localistEvent({
      id: 53809380678267,
      title: "Fireside Chat with Anne Wojcicki",
      first_date: tomorrow,
      last_date: tomorrow,
      instances: [{ start: `${tomorrow}T12:00:00-07:00`, end: `${tomorrow}T13:00:00-07:00` }],
    }),
  ]);
  assert.equal(event.date, tomorrow, "must not land a day early");
  assert.equal(event.time, "12:00 PM");
  assert.equal(event.endTime, "1:00 PM");
  assert.equal(event.ongoing, false);
});

test("an all-day occurrence keeps a null time instead of inventing one", async () => {
  // The old bug's signature was a wall of identical "5:00 PM" starts — the
  // Pacific rendering of midnight UTC. No time is the honest answer here, and
  // the publish gate drops timeless non-ongoing rows on purpose.
  const tomorrow = dayPT(1);
  const [event] = await runWith([
    localistEvent({
      id: 7,
      title: "Labor Day Facility Hours",
      first_date: tomorrow,
      last_date: tomorrow,
      instances: [{ start: `${tomorrow}T00:00:00-07:00`, end: null }],
    }),
  ]);
  assert.equal(event.date, tomorrow);
  assert.equal(event.time, null);
});

test("each occurrence of a series gets its own dated card", async () => {
  // One Localist id covers every session, so an unscoped id collapsed Tuesday's
  // counseling slot and Wednesday's into a single card.
  const events = await runWith([
    localistEvent({
      id: 42,
      title: "Financial Counseling with Fidelity",
      first_date: dayPT(1),
      last_date: dayPT(2),
      instances: [{ start: `${dayPT(1)}T08:00:00-07:00`, end: `${dayPT(1)}T17:00:00-07:00` }],
    }),
    localistEvent({
      id: 42,
      title: "Financial Counseling with Fidelity",
      first_date: dayPT(1),
      last_date: dayPT(2),
      instances: [{ start: `${dayPT(2)}T08:00:00-07:00`, end: `${dayPT(2)}T17:00:00-07:00` }],
    }),
  ]);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.date), [dayPT(1), dayPT(2)]);
  assert.equal(new Set(events.map((e) => e.id)).size, 2, "ids must not collide across days");
});

test("an exhibit open today anchors to today, clock-free, once", async () => {
  // Localist lists an open run once per day it is open. All of those rows
  // collapse to the same card, and Stanford is capped at 30 events off a
  // date-sorted list — leaving the duplicates in spends the whole budget on
  // one exhibit before a single dated event is read.
  const events = await runWith([
    localistEvent({
      id: 99,
      title: "In Focus: Asian American Art from the Collection",
      description_text: "An exhibition drawn from the Cantor collection.",
      first_date: dayPT(-30),
      last_date: dayPT(30),
      instances: [{ start: `${dayPT(0)}T11:00:00-07:00`, end: `${dayPT(0)}T18:00:00-07:00` }],
    }),
    localistEvent({
      id: 99,
      title: "In Focus: Asian American Art from the Collection",
      description_text: "An exhibition drawn from the Cantor collection.",
      first_date: dayPT(-30),
      last_date: dayPT(30),
      instances: [{ start: `${dayPT(1)}T11:00:00-07:00`, end: `${dayPT(1)}T18:00:00-07:00` }],
    }),
  ]);
  assert.equal(events.length, 1, "an open run is one card, not one per open day");
  assert.equal(events[0].ongoing, true);
  assert.equal(events[0].date, dayPT(0));
  assert.equal(events[0].time, null, "an exhibition does not start at a clock time");
  assert.equal(events[0].id, "stanford-99", "a run keeps a stable id as it re-anchors each day");
});

test("a multi-day series that is not an exhibit stays a set of dated sessions", async () => {
  const events = await runWith([
    localistEvent({
      id: 5,
      title: "Empowered Relief Instructor Certification",
      description_text: "A certification course for clinicians.",
      first_date: dayPT(-3),
      last_date: dayPT(3),
      instances: [{ start: `${dayPT(1)}T08:30:00-07:00`, end: `${dayPT(1)}T16:30:00-07:00` }],
    }),
  ]);
  assert.equal(events[0].ongoing, false);
  assert.equal(events[0].date, dayPT(1));
  assert.equal(events[0].time, "8:30 AM");
});

test("an occurrence that has already happened is dropped", async () => {
  const events = await runWith([
    localistEvent({
      id: 6,
      title: "Department Meeting",
      first_date: dayPT(-2),
      last_date: dayPT(-2),
      instances: [{ start: `${dayPT(-2)}T07:00:00-07:00`, end: `${dayPT(-2)}T08:00:00-07:00` }],
    }),
  ]);
  assert.deepEqual(events, []);
});

test("a closed exhibit does not linger as ongoing", async () => {
  const events = await runWith([
    localistEvent({
      id: 8,
      title: "Summer Group Exhibition",
      description_text: "Works by regional artists.",
      first_date: dayPT(-60),
      last_date: dayPT(-2),
      instances: [{ start: `${dayPT(-2)}T10:00:00-07:00`, end: `${dayPT(-2)}T17:00:00-07:00` }],
    }),
  ]);
  assert.deepEqual(events, []);
});
