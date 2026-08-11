import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmMeeting,
  formatMeetingTime,
  isClosedSessionMeeting,
  legistarMeetingUrl,
  normalizeMeetingTime,
  onlyConfirmedMeetings,
  pickCivicClerkMeeting,
} from "./civic-meetings.mjs";

test("Legistar links use the provider-owned public URL instead of rebuilding API ids", () => {
  const providerUrl = "https://cupertino.legistar.com/MeetingDetail.aspx?LEGID=5295&GID=341&G=74359C04-A5F0-4CB2-A97A-0032996BB90E";
  assert.equal(legistarMeetingUrl("cupertino", "2026-07-21", providerUrl), providerUrl);
  assert.equal(
    legistarMeetingUrl("cupertino", "2026-07-21", "https://evil.example/MeetingDetail.aspx?LEGID=5295"),
    "https://cupertino.legistar.com/Calendar.aspx?From=7%2F21%2F2026&To=7%2F21%2F2026",
  );
});

test("the publication gate rejects projected or date-mismatched meetings", () => {
  const projected = { date: "2026-07-21", bodyName: "City Council" };
  const mismatched = confirmMeeting(projected, {
    provider: "civicclerk",
    sourceUrl: "https://www.milpitas.gov/129/Agendas-Minutes",
    observedDate: "2026-07-22",
  });
  const confirmed = confirmMeeting(projected, {
    provider: "civicclerk",
    sourceUrl: "https://www.milpitas.gov/129/Agendas-Minutes",
  });

  assert.equal(mismatched, null);
  assert.deepEqual(Object.keys(onlyConfirmedMeetings({ projected, mismatched, confirmed })), ["confirmed"]);
});

test("CivicClerk selection publishes only concrete, current, non-cancelled events", () => {
  assert.equal(pickCivicClerkMeeting([], "2026-07-21"), null);
  const selected = pickCivicClerkMeeting([
    { id: 1, categoryName: "City Council", eventName: "City Council Meeting - CANCELLED", eventDate: "2026-07-21T19:00:00Z" },
    { id: 2, categoryName: "Planning Commission", eventName: "Planning Commission", eventDate: "2026-07-22T19:00:00Z" },
    { id: 3, categoryName: "City Council", eventName: "City Council Meeting", eventDate: "2026-08-04T19:00:00Z" },
  ], "2026-07-21");
  assert.equal(selected?.id, 3);
});

test("each portal's start time normalizes to the city's own wall clock", () => {
  // Legistar (San José 2026-08-11) — the meeting the newsletter called "tonight".
  assert.equal(normalizeMeetingTime("1:30 PM"), "13:30");
  assert.equal(normalizeMeetingTime("5:00 PM"), "17:00");
  assert.equal(normalizeMeetingTime("12:15 AM"), "00:15");
  assert.equal(normalizeMeetingTime("12:00 PM"), "12:00");
  // PrimeGov (Palo Alto) and eScribe (Campbell) post naive local timestamps.
  assert.equal(normalizeMeetingTime("2026-08-17T17:30:00"), "17:30");
  assert.equal(normalizeMeetingTime("2026/08/11 19:00:00"), "19:00");
  // Nothing to read: EventDate alone, a blank field, junk.
  assert.equal(normalizeMeetingTime("2026-08-11"), null);
  assert.equal(normalizeMeetingTime(""), null);
  assert.equal(normalizeMeetingTime(null), null);
  assert.equal(normalizeMeetingTime("whenever"), null);
});

test("CivicClerk's trailing Z is the city's clock, not UTC", () => {
  // Milpitas 2026-08-11 posts "…T16:00:00Z" and the agenda PDF says 4:00 PM.
  // Reading the Z as UTC would file a 4 PM special meeting at 9:00 AM.
  assert.equal(normalizeMeetingTime("2026-08-11T16:00:00Z"), "16:00");
  assert.equal(normalizeMeetingTime("2026-08-18T19:00:00Z"), "19:00");
});

test("meeting times render as a reader-facing clock", () => {
  assert.equal(formatMeetingTime("13:30"), "1:30 PM");
  assert.equal(formatMeetingTime("17:00"), "5:00 PM");
  assert.equal(formatMeetingTime("00:15"), "12:15 AM");
  assert.equal(formatMeetingTime("12:00"), "12:00 PM");
  assert.equal(formatMeetingTime(null), null);
  assert.equal(formatMeetingTime("5:00 PM"), null);
});

test("a non-televised closed session is flagged as unattendable", () => {
  // Cupertino 2026-08-11, listed in the issue as a plain council meeting.
  assert.equal(isClosedSessionMeeting({
    bodyName: "City Council",
    comment: "Non-Televised Special Meeting Closed Session",
  }), true);
  assert.equal(isClosedSessionMeeting({ bodyName: "City Council Closed Session" }), true);
  assert.equal(isClosedSessionMeeting({ bodyName: "Special Meeting Executive Session" }), true);
});

test("a public meeting that merely mentions an earlier closed session stays public", () => {
  // San José 2026-08-11: a public 1:30 PM sitting whose comment notes a
  // separate 9:30 AM closed session. Flagging it would hide real civic news.
  assert.equal(isClosedSessionMeeting({
    bodyName: "City Council",
    comment: "https://sanjoseca.zoom.us/j/98221474336   Closed Session at 9:30 a.m.",
  }), false);
  // Milpitas 2026-08-11 runs closed session AND public business at 4:00 PM.
  assert.equal(isClosedSessionMeeting({
    bodyName: "City Council Special Meeting",
    description: "",
  }), false);
  assert.equal(isClosedSessionMeeting({}), false);
  assert.equal(isClosedSessionMeeting(), false);
});
