import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  hasRequiredOccurrenceEvidence,
  isEventExplicitlyInactive,
  isEventPublishable,
} from "./eventOccurrence.mjs";
import { isEventEditoriallySuppressed } from "./eventAvailability.mjs";

const grpgEvent = {
  source: "Guadalupe River Park Conservancy",
  title: "Yoga and Zumba in the River Park",
  date: "2026-07-25",
  venue: "Arena Green West",
};

test("GRPG dates require exact first-party occurrence-page evidence", () => {
  assert.equal(hasRequiredOccurrenceEvidence(grpgEvent), false);
  assert.equal(hasRequiredOccurrenceEvidence({
    ...grpgEvent,
    occurrenceEvidence: {
      kind: "first-party-occurrence-page",
      sourceUrl: "https://grpg.org/calendar/events/",
      date: "2026-07-25",
    },
  }), true);
  assert.equal(hasRequiredOccurrenceEvidence({
    ...grpgEvent,
    occurrenceEvidence: {
      kind: "first-party-occurrence-page",
      sourceUrl: "https://grpg.org/calendar/events/",
      date: "2026-08-29",
    },
  }), false);
});

test("an aggregator or tracking link cannot stand in for first-party evidence", () => {
  assert.equal(hasRequiredOccurrenceEvidence({
    source: "Linden Tree Books",
    title: "Teen Writing Workshop",
    date: "2026-07-16",
    occurrenceEvidence: {
      kind: "first-party-occurrence-page",
      sourceUrl: "https://m4e9g4bab.cc.rs6.net/tn.jsp",
      date: "2026-07-16",
    },
  }), false);
});

test("projected farmers markets require a live, date-matched first-party schedule check", () => {
  const market = {
    source: "South Bay Signal",
    title: "Cupertino Farmers Market",
    date: "2026-07-17",
    url: "https://www.cafarmersmkts.com/cupertino-market",
  };

  assert.equal(hasRequiredOccurrenceEvidence(market), false);
  assert.equal(hasRequiredOccurrenceEvidence({
    ...market,
    occurrenceEvidence: {
      kind: "first-party-market-schedule",
      sourceUrl: "https://www.cafarmersmkts.com/cupertino-market",
      date: "2026-07-24",
      checkedAt: "2026-07-17T10:00:00.000Z",
    },
  }), false);
  assert.equal(hasRequiredOccurrenceEvidence({
    ...market,
    occurrenceEvidence: {
      kind: "first-party-market-schedule",
      sourceUrl: "https://events.example.com/cupertino-market",
      date: "2026-07-17",
      checkedAt: "2026-07-17T10:00:00.000Z",
    },
  }), false);
  assert.equal(hasRequiredOccurrenceEvidence({
    ...market,
    occurrenceEvidence: {
      kind: "first-party-market-schedule",
      sourceUrl: "https://cafarmersmkts.com/cupertino-market",
      date: "2026-07-17",
      checkedAt: "2026-07-17T10:00:00.000Z",
    },
  }), true);
});

test("structured inactive statuses and explicit cancellation titles are rejected", () => {
  assert.equal(isEventExplicitlyInactive({ eventStatus: "https://schema.org/EventCancelled" }), true);
  assert.equal(isEventExplicitlyInactive({ sourceStatus: "postponed" }), true);
  assert.equal(isEventExplicitlyInactive({ title: "CANCELLED: Garden Workday" }), true);
  assert.equal(isEventExplicitlyInactive({
    eventStatus: "https://schema.org/EventScheduled",
    description: "Refunds are available if the event is canceled.",
  }), false);
});

test("publishability combines occurrence evidence with editorial place availability", () => {
  assert.equal(isEventPublishable({
    ...grpgEvent,
    occurrenceEvidence: {
      kind: "first-party-occurrence-page",
      sourceUrl: "https://www.grpg.org/events",
      date: "2026-07-25",
    },
  }), true);
  assert.equal(isEventPublishable({
    source: "Santa Clara University",
    title: "Museum Open House",
    date: "2026-09-05",
    venue: "de Saisset Museum",
    eventStatus: "https://schema.org/EventScheduled",
  }), false);
});

test("canonical evidence-required rows contain exact occurrence evidence", () => {
  const upcoming = JSON.parse(readFileSync(
    new URL("../../data/south-bay/upcoming-events.json", import.meta.url),
    "utf8",
  ));
  const evidenceRequiredEvents = (upcoming.events || []).filter(
    (event) => ["Guadalupe River Park Conservancy", "Linden Tree Books"].includes(event.source),
  );

  assert.equal(evidenceRequiredEvents.every((event) => hasRequiredOccurrenceEvidence(event)), true);
  assert.equal(evidenceRequiredEvents.every((event) => isEventPublishable(event)), true);
});

test("unconfirmed 2026-08-19 library rows stay unpublished until first-party confirm", () => {
  const lotus = {
    id: "sccl-6a5a7fe7fa641fe01af3cb52",
    title: "Lotus Lantern Craft",
    date: "2026-08-19",
    time: "4:00 PM",
    venue: "Cupertino Library",
    source: "Santa Clara County Library",
  };
  const weeExplore = {
    id: "sjpl-69d5759be2a2952aed0d5074",
    title: "Wee Explore Outdoors: Sand and Water Play",
    date: "2026-08-19",
    time: "10:30 AM",
    venue: "Educational Park Library",
    source: "San Jose Public Library",
  };
  const knitting = {
    id: "sjpl-6a7e0ae8d4b10d0030064691",
    title: "Knitting/Crocheting/Tatting/Bobbin Lace Club",
    date: "2026-08-19",
    time: "5:00 PM",
    venue: "East SJ Carnegie Library",
    source: "San Jose Public Library",
  };

  assert.equal(isEventEditoriallySuppressed(lotus), true);
  assert.equal(isEventEditoriallySuppressed(weeExplore), true);
  assert.equal(isEventEditoriallySuppressed(knitting), true);
  assert.equal(isEventPublishable(lotus), false);
  assert.equal(isEventPublishable({
    ...lotus,
    id: "sccl-other",
  }), false);
  assert.equal(isEventEditoriallySuppressed({
    ...knitting,
    date: "2026-08-26",
    id: "sjpl-next-week",
  }), false);
});

test("suppresses Ticketmaster-only Dru Hill at Mountain Winery", () => {
  const druHill = {
    id: "tm-Z7r9jZ1A7x78p",
    title: "Dru Hill w/ Ginuwine & Troop",
    date: "2026-08-22",
    time: "7:30 PM",
    venue: "Mountain Winery",
    source: "Ticketmaster",
  };
  assert.equal(isEventEditoriallySuppressed(druHill), true);
  assert.equal(isEventPublishable(druHill), false);
  assert.equal(isEventEditoriallySuppressed({
    ...druHill,
    date: "2026-08-29",
    id: "tm-other-dru",
  }), false);
});

test("canonical events suppress the unconfirmed Cupertino market projection", () => {
  const upcoming = JSON.parse(readFileSync(
    new URL("../../data/south-bay/upcoming-events.json", import.meta.url),
    "utf8",
  ));
  const cupertinoMarkets = (upcoming.events || []).filter(
    (event) => event.title === "Cupertino Farmers Market",
  );
  assert.deepEqual(cupertinoMarkets, []);
});

test("canonical projected markets all carry current first-party schedule evidence", () => {
  const upcoming = JSON.parse(readFileSync(
    new URL("../../data/south-bay/upcoming-events.json", import.meta.url),
    "utf8",
  ));
  const projectedMarkets = (upcoming.events || []).filter(
    (event) => event.projectedRecurrence === true,
  );

  assert.ok(projectedMarkets.length > 0);
  assert.equal(projectedMarkets.every((event) => hasRequiredOccurrenceEvidence(event)), true);
  assert.equal(projectedMarkets.every((event) => isEventPublishable(event)), true);
});
