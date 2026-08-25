import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmMeeting,
  formatMeetingTime,
  isClosedSessionMeeting,
  legistarMeetingUrl,
  primeGovAgendaUrl,
  normalizeMeetingTime,
  onlyConfirmedMeetings,
  parseSessionSchedule,
  pickCivicClerkMeeting,
  resolvePublicStart,
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

// ---------------------------------------------------------------------------
// resolvePublicStart — a posted start that is really the closed session
// ---------------------------------------------------------------------------

// Sunnyvale's own EventComment for 2026-08-25, verbatim from Legistar. The row
// is named plainly "City Council" and EventTime is 4:30 PM, so nothing in the
// name-based closed-session vocabulary can see that 4:30 is the shut hour.
const SUNNYVALE_AUG_25_COMMENT =
  "Special Meeting: Closed Session - 4:30 PM | Special Meeting: Presentation - 6 PM"
  + " | Regular Meeting - 7 PM\r\n\r\nMeeting online link:  https://sunnyvale-ca-gov.zoom.us/j/96111580540";

test("Sunnyvale's posted start is its closed session; the public start is the block after", () => {
  // The 2026-08-25 issue opened "Sunnyvale at 4:30 … this is the afternoon to
  // scratch [a civic itch]" — a locked room. 6 PM is the first block a reader
  // can walk into; the regular meeting follows at 7.
  assert.deepEqual(
    resolvePublicStart({ startTime: "16:30", comment: SUNNYVALE_AUG_25_COMMENT }),
    { startTime: "18:00", closedSessionStart: "16:30" },
  );
  assert.deepEqual(
    parseSessionSchedule(SUNNYVALE_AUG_25_COMMENT).map((b) => [b.startTime, b.closed]),
    [["16:30", true], ["18:00", false], ["19:00", false]],
  );
});

test("the rule holds across Sunnyvale's other 2026 postings, including the unspaced dash", () => {
  // Nine 2026 entries carry this shape; these cover both punctuations and the
  // two-block form where the regular meeting is the only public block.
  assert.deepEqual(
    resolvePublicStart({
      startTime: "16:30",
      comment: "Special Meeting: Closed Session - 4:30 PM | Special Meeting: Study Session - 5 PM | Regular Meeting - 7 PM",
    }),
    { startTime: "17:00", closedSessionStart: "16:30" },
  );
  assert.deepEqual(
    resolvePublicStart({
      startTime: "17:30",
      comment: "Special Meeting: Closed Session-5:30 PM | Special Meeting: Special Order of the Day-6:30 PM"
        + " | Regular Meeting-7 PM |  Joint Meeting City Council & Sunnyvale Financing Authority-7 PM",
    }),
    { startTime: "18:30", closedSessionStart: "17:30" },
  );
  assert.deepEqual(
    resolvePublicStart({
      startTime: "17:30",
      comment: "Special Meeting: Closed Session - 5:30 PM | Regular Meeting - 7 PM",
    }),
    { startTime: "19:00", closedSessionStart: "17:30" },
  );
});

test("a closed session at some other hour never moves the posted start", () => {
  // San José 2026-08-25: a public 1:30 PM sitting whose comment notes a
  // separate 9:30 a.m. closed session, posted as its own Legistar row. Reading
  // the colon inside "9:30" as a label separator would invent a block and hand
  // readers the wrong hour for the meeting they can actually attend.
  assert.deepEqual(parseSessionSchedule("Closed Session at 9:30 a.m."), []);
  assert.deepEqual(
    resolvePublicStart({ startTime: "13:30", comment: "Closed Session at 9:30 a.m." }),
    { startTime: "13:30", closedSessionStart: null },
  );
  assert.deepEqual(
    resolvePublicStart({
      startTime: "13:30",
      comment: "https://sanjoseca.zoom.us/j/98221474336   Closed Session at 9:30 a.m.",
    }),
    { startTime: "13:30", closedSessionStart: null },
  );
  // Mountain View 2026-08-25, and every provider that posts no schedule at all.
  assert.deepEqual(
    resolvePublicStart({ startTime: "17:00", comment: "REGULAR MEETING" }),
    { startTime: "17:00", closedSessionStart: null },
  );
  assert.deepEqual(
    resolvePublicStart({ startTime: "19:00" }),
    { startTime: "19:00", closedSessionStart: null },
  );
  assert.deepEqual(resolvePublicStart({}), { startTime: null, closedSessionStart: null });
  assert.deepEqual(
    resolvePublicStart({ startTime: null, comment: SUNNYVALE_AUG_25_COMMENT }),
    { startTime: null, closedSessionStart: null },
    "no posted start means nothing to correct",
  );
});

test("the start only moves when the posted hour is closed and something public follows", () => {
  // Posted start already public — the closed block runs earlier and is not the
  // hour on the row, so leave the row alone.
  assert.deepEqual(
    resolvePublicStart({
      startTime: "19:00",
      comment: "Special Meeting: Closed Session - 5:30 PM | Regular Meeting - 7 PM",
    }),
    { startTime: "19:00", closedSessionStart: null },
  );
  // Public business convenes at the same hour as the closed session (Milpitas's
  // shape). The posted time is attendable; don't push readers later.
  assert.deepEqual(
    resolvePublicStart({
      startTime: "16:00",
      comment: "Closed Session - 4 PM | Regular Meeting - 4 PM | Study Session - 6 PM",
    }),
    { startTime: "16:00", closedSessionStart: null },
  );
  // Nothing public follows: an entirely closed sitting stays as posted rather
  // than being handed an invented public hour.
  assert.deepEqual(
    resolvePublicStart({
      startTime: "16:30",
      comment: "Special Meeting: Closed Session - 4:30 PM | Closed Session - 6 PM",
    }),
    { startTime: "16:30", closedSessionStart: null },
  );
  // A lone block is a restatement of the posted time, not a running order.
  assert.deepEqual(
    resolvePublicStart({ startTime: "16:30", comment: "Special Meeting: Closed Session - 4:30 PM" }),
    { startTime: "16:30", closedSessionStart: null },
  );
});

test("the schedule is read from a description when the provider has no comment field", () => {
  // eScribe and CivicClerk carry their free text in Description /
  // eventDescription; the same rule has to reach those providers.
  assert.deepEqual(
    resolvePublicStart({
      startTime: "17:00",
      description: "City Council Closed Session - 5 PM | City Council Regular Session - 7 PM",
    }),
    { startTime: "19:00", closedSessionStart: "17:00" },
  );
});

// ---------------------------------------------------------------------------
// primeGovAgendaUrl
// ---------------------------------------------------------------------------

// Shape of a PrimeGov ListArchivedMeetings record: the HTML agenda is
// compileOutputType 3; the PDF agenda and packet are compileOutputType 1.
const PALO_ALTO_ARB_AUG_6 = {
  id: 3055,
  title: "Architectural Review Board Regular Meeting",
  dateTime: "2026-08-06T08:30:00",
  documentList: [
    { id: 21163, compileOutputType: 3, publishStatus: 1, templateName: "HTML Agenda" },
    { id: 21128, compileOutputType: 1, publishStatus: 1, templateName: "Agenda" },
    { id: 21127, compileOutputType: 1, publishStatus: 1, templateName: "Packet" },
  ],
};

test("primeGovAgendaUrl links the meeting's own HTML agenda", () => {
  assert.equal(
    primeGovAgendaUrl("cityofpaloalto.primegov.com", PALO_ALTO_ARB_AUG_6),
    "https://cityofpaloalto.primegov.com/Portal/Meeting?compiledMeetingDocumentFileId=21163",
  );
});

test("primeGovAgendaUrl refuses hosts outside primegov.com", () => {
  assert.equal(primeGovAgendaUrl("evil.example", PALO_ALTO_ARB_AUG_6), null);
  assert.equal(primeGovAgendaUrl("primegov.com.evil.example", PALO_ALTO_ARB_AUG_6), null);
  assert.equal(primeGovAgendaUrl("", PALO_ALTO_ARB_AUG_6), null);
});

test("primeGovAgendaUrl returns null when no HTML agenda is published", () => {
  assert.equal(primeGovAgendaUrl("cityofpaloalto.primegov.com", { documentList: [] }), null);
  assert.equal(primeGovAgendaUrl("cityofpaloalto.primegov.com", {}), null);
  assert.equal(
    primeGovAgendaUrl("cityofpaloalto.primegov.com", {
      documentList: [{ id: 1, compileOutputType: 3, publishStatus: 0 }],
    }),
    null,
    "unpublished agendas are not linkable",
  );
});
