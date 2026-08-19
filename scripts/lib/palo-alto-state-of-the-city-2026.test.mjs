import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PALO_ALTO_STATE_OF_THE_CITY_2026,
  PALO_ALTO_STATE_OF_THE_CITY_URL,
  getPaloAltoStateOfTheCityEvent,
  mergePaloAltoStateOfTheCity,
  overlayPaloAltoStateOfTheCity,
} from "./palo-alto-state-of-the-city-2026.mjs";

const PRIME_GOV_ROW = {
  title: "City Council Special Meeting - State of the City 2026",
  dateTime: "2026-08-19T17:30:00",
  location: "Council Chamber",
};

test("PrimeGov State of the City overlay uses the official public event facts", () => {
  const overlaid = overlayPaloAltoStateOfTheCity({
    date: "2026-08-19",
    displayDate: "Wed, Aug 19",
    startTime: "17:30",
    bodyName: PRIME_GOV_ROW.title,
    location: null,
    closedSession: false,
    url: "https://cityofpaloalto.primegov.com/Portal/Meeting?meetingId=3136",
    agendaItems: [],
  }, PRIME_GOV_ROW);

  assert.equal(overlaid.bodyName, "Mayor's State of the City");
  assert.equal(overlaid.startTime, "18:00");
  assert.equal(overlaid.location, "Paly PAC · doors 5:30 PM");
  assert.equal(overlaid.url, PALO_ALTO_STATE_OF_THE_CITY_URL);
  assert.equal(overlaid.closedSession, false);
});

test("the overlay does not rewrite a different day's council sitting", () => {
  const meeting = {
    date: "2026-08-24",
    startTime: "17:30",
    bodyName: "City Council Special Meeting",
    url: "https://cityofpaloalto.primegov.com/Portal/Meeting?meetingId=2847",
  };
  assert.equal(overlayPaloAltoStateOfTheCity(meeting, meeting), meeting);
});

test("canonical event carries first-party occurrence evidence", () => {
  const event = getPaloAltoStateOfTheCityEvent();
  assert.equal(event.date, PALO_ALTO_STATE_OF_THE_CITY_2026.date);
  assert.equal(event.time, "6:00 PM");
  assert.equal(event.endTime, "8:00 PM");
  assert.equal(event.venue, "Paly PAC");
  assert.equal(event.url, PALO_ALTO_STATE_OF_THE_CITY_URL);
  assert.equal(event.occurrenceEvidence.kind, "first-party-occurrence-page");
  assert.equal(event.occurrenceEvidence.sourceUrl, PALO_ALTO_STATE_OF_THE_CITY_URL);
  assert.equal(getPaloAltoStateOfTheCityEvent({ fromDate: "2026-08-20" }), null);
});

test("merge replaces a PrimeGov-shaped State of the City row", () => {
  const merged = mergePaloAltoStateOfTheCity([
    {
      id: "noise",
      title: "Jazz on the Plazz",
      date: "2026-08-19",
      city: "los-gatos",
    },
    {
      id: "pa-sotc-wrong",
      title: "City Council Special Meeting - State of the City 2026",
      date: "2026-08-19",
      time: "5:30 PM",
      venue: "Council Chamber",
      city: "palo-alto",
      url: "https://cityofpaloalto.primegov.com/Portal/Meeting?meetingId=3136",
    },
  ], { fromDate: "2026-08-19" });

  assert.equal(merged.addedCount, 1);
  assert.equal(merged.replacedCount, 1);
  assert.equal(merged.events.length, 2);
  const sotc = merged.events.find((event) => event.city === "palo-alto");
  assert.equal(sotc.title, "Mayor's State of the City");
  assert.equal(sotc.time, "6:00 PM");
  assert.equal(sotc.venue, "Paly PAC");
});

test("if today's civic artifact still has Aug 19, it carries the official Paly PAC facts", () => {
  const upcoming = JSON.parse(readFileSync(
    new URL("../../src/data/south-bay/upcoming-meetings.json", import.meta.url),
    "utf8",
  ));
  const meeting = upcoming.meetings?.["palo-alto"];
  if (meeting?.date !== "2026-08-19") return;

  assert.equal(meeting.bodyName, "Mayor's State of the City");
  assert.equal(meeting.startTime, "18:00");
  assert.equal(meeting.location, "Paly PAC · doors 5:30 PM");
  assert.equal(meeting.url, PALO_ALTO_STATE_OF_THE_CITY_URL);
});

test("canonical upcoming data does not keep the unconfirmed library rows", () => {
  const upcoming = JSON.parse(readFileSync(
    new URL("../../src/data/south-bay/upcoming-events.json", import.meta.url),
    "utf8",
  ));
  const blocked = new Set([
    "sccl-6a5a7fe7fa641fe01af3cb52",
    "sjpl-69d5759be2a2952aed0d5074",
    "sjpl-6a7e0ae8d4b10d0030064691",
  ]);
  const hits = (upcoming.events || []).filter((event) => blocked.has(event.id));
  assert.deepEqual(hits, []);
});
