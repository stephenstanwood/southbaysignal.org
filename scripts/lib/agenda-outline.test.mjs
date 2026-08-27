import assert from "node:assert/strict";
import test from "node:test";

import {
  agendaBodyLines,
  looksLikeReadableAgenda,
  parseAgendaOutline,
} from "./agenda-outline.mjs";

// Trimmed from the real Los Altos August 25 2026 agenda, as CivicClerk's
// plainText conversion emits it: a flat "N." outline, description indented
// under each item.
const LOS_ALTOS = `
                          CITY COUNCIL MEETING
                                      AGENDA
                               August 25, 2026 - 7:00 PM

PARTICIPATION: Members of the public are invited to participate by attending the meeting at the
Los Altos Council Chamber. Public comments are accepted in person.
 1.Attending the meeting in person at:
 2.Accessing the meeting through Zoom

CALL MEETING TO ORDER

CONSENT CALENDAR

    1.    Approval of Meeting Minutes - Draft Regular Meeting of July 14, 2026
    2.   Acceptance of Treasurer's Report
         Receive and file the City's Treasurer's Report for the quarter ending June 30, 2026
    3.   Adoption of Resolution - History Museum Roof Replacement
         Adopt a resolution to authorize the City Manager to enter into an agreement with Diablo
         Roofing Incorporated, to replace and repair the roofing at the Los Altos History Museum

PUBLIC HEARING

    8.   Adoption of Resolution - Vesting Tentative Map at 349 First Street
         Adopt a Resolution approving a Vesting Tentative Map for condominium purposes for the
         creation of 19 condominium units at 349 First Street, statutorily exempt from CEQA
         pursuant to Public Resources Code Section 21
080.66 (Attachment 1)

ADJOURN

AMERICANS WITH DISABILITIES ACT: Anyone needing an accommodation should contact the City Clerk.
`;

// Trimmed from the real Saratoga August 19 2026 agenda: a dotted "N.N" outline
// with its recommended actions nested as a "1." / "2." sub-list.
const SARATOGA = `
Saratoga City Council Meeting Agenda – August 19, 2026 - Page 1 of 8
Public Participation Information
1.Attending the meeting in person at:
PLEDGE OF ALLEGIANCE
ROLL CALL
1.CONSENT CALENDAR
The Consent Calendar contains routine items of business.
1.4 Award of Contract Backfill Janitorial Services
Recommended Action:
Approve the proposed contract with YN Maintenance LLC for janitorial services and authorize the
acting City Manager to execute the same.
Staff Report
Attachment A - Check Registers Dated 06-25-2026 P12
Saratoga City Council Meeting Agenda – August 19, 2026 - Page 3 of 8
1.6 City Irrigation Maintenance Service Contracts for FY 2026-27
Recommended Actions:
1. Approve a contract with Dinsmore Landscape Company in the amount of $59,280.
2. Approve a second contract with Dinsmore Landscape Company for lighting districts.
Staff Report
1.14 Santa Clara Law Enforcement Contract
Recommended Action:
Authorize the City Manager to execute a five-year agreement with the Santa Clara County Sheriff's Office.
ADJOURNMENT
CERTIFICATE OF POSTING OF THE AGENDA
`;

test("agendaBodyLines drops the participation boilerplate and the ADA tail", () => {
  const body = agendaBodyLines(LOS_ALTOS);
  assert.ok(!body.some((l) => /Accessing the meeting through Zoom/.test(l)), "Zoom instructions are not agenda content");
  assert.ok(!body.some((l) => /AMERICANS WITH DISABILITIES/.test(l)), "post-adjournment notices are not agenda content");
  assert.ok(body.some((l) => /History Museum Roof Replacement/.test(l)));
});

test("agendaBodyLines falls back to the whole document when no markers are present", () => {
  const body = agendaBodyLines("1. Some item\nSome detail");
  assert.deepEqual(body, ["1. Some item", "Some detail"]);
});

test("a flat outline pairs each item with the prose under it", () => {
  const items = parseAgendaOutline(LOS_ALTOS);
  const roof = items.find((i) => i.title.includes("History Museum"));
  assert.equal(roof.number, "3.");
  assert.match(roof.detail, /^Adopt a resolution to authorize the City Manager/);
  assert.match(roof.detail, /Diablo Roofing Incorporated/);
});

// "…Public Resources Code Section 21" / "080.66 (Attachment 1)" — agenda prose
// wraps mid-number constantly, and a looser item pattern read the remainder as
// a brand new item numbered 21.
test("a line that merely starts with digits is not a new item", () => {
  const items = parseAgendaOutline(LOS_ALTOS);
  assert.ok(!items.some((i) => i.number === "21"), `stray item: ${JSON.stringify(items.map((i) => i.number))}`);
  const map = items.find((i) => i.title.includes("349 First Street"));
  assert.match(map.detail, /080\.66/, "the wrapped remainder stays with its own item");
});

test("a dotted outline keeps its nested recommended actions as detail", () => {
  const items = parseAgendaOutline(SARATOGA);
  assert.deepEqual(items.map((i) => i.number), ["1.4", "1.6", "1.14"]);
  const irrigation = items.find((i) => i.number === "1.6");
  assert.match(irrigation.detail, /Approve a contract with Dinsmore Landscape Company/);
  assert.match(irrigation.detail, /lighting districts/, "the second nested action is kept too");
});

// The consent-calendar banner is numbered ("1.CONSENT CALENDAR"). Letting it
// set the style locked Saratoga to a flat outline, which then rejected every
// real 1.N item and promoted the nested actions in their place.
test("a numbered section banner does not become an item or set the outline style", () => {
  const items = parseAgendaOutline(SARATOGA);
  assert.ok(!items.some((i) => /CONSENT CALENDAR/i.test(i.title)));
  assert.ok(!items.some((i) => /^Approve a contract with Dinsmore/.test(i.title)));
});

test("attachments, staff reports and the running page header stay out of the detail", () => {
  const janitorial = parseAgendaOutline(SARATOGA).find((i) => i.number === "1.4");
  assert.equal(
    janitorial.detail,
    "Approve the proposed contract with YN Maintenance LLC for janitorial services and authorize the acting City Manager to execute the same.",
  );
});

test("both 'Recommended Action' and 'Recommended Actions' are dropped as labels", () => {
  for (const item of parseAgendaOutline(SARATOGA)) {
    assert.ok(!/Recommended Actions?:/i.test(item.detail), `label leaked into ${item.number}`);
  }
});

test("detail is truncated on a word boundary", () => {
  const [item] = parseAgendaOutline("CALL TO ORDER\n1. Title of the item\n" + "word ".repeat(200), { maxDetailChars: 40 });
  assert.ok(item.detail.length <= 41, item.detail.length);
  assert.ok(item.detail.endsWith("…"));
  assert.ok(!item.detail.includes("wor…"), "cuts between words, not inside one");
});

test("an agenda with no numbered items yields nothing rather than throwing", () => {
  assert.deepEqual(parseAgendaOutline("ROLL CALL\nNothing was scheduled.\nADJOURN"), []);
  assert.deepEqual(parseAgendaOutline(""), []);
  assert.deepEqual(parseAgendaOutline(null), []);
});

// Saratoga posts a Chinese translation of every agenda. Its PDF text layer is a
// font subset that decodes to mojibake — structurally parseable, semantically
// garbage, and the summarizer cannot tell the difference.
test("looksLikeReadableAgenda rejects a mojibake text layer", () => {
  const mojibake = `!"#$%&%'(')*+,-./0123$456'(')*+,-7/689%$:;<=56'(')*+,-7/6>?@-A-BC:;<=`.repeat(20);
  assert.equal(looksLikeReadableAgenda(mojibake), false);
  assert.equal(looksLikeReadableAgenda(LOS_ALTOS), true);
  assert.equal(looksLikeReadableAgenda(SARATOGA), true);
});

test("looksLikeReadableAgenda rejects an empty or near-empty extraction", () => {
  assert.equal(looksLikeReadableAgenda(""), false);
  assert.equal(looksLikeReadableAgenda("Agenda"), false, "a scanned PDF yields almost no text");
  assert.equal(looksLikeReadableAgenda(null), false);
});
