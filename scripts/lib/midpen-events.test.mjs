import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MIDPEN_PRESERVE_CITY,
  midpenClockTime,
  midpenIsoDate,
  midpenPreserveCity,
  midpenText,
  midpenTrailhead,
  parseMidpenDetail,
  parseMidpenListPage,
} from "./midpen-events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Trimmed from the live https://www.openspace.org/get-involved/events-activities
// response, 2026-09-04: one volunteer project, one guided activity, one Board
// meeting row.
const LIST = readFileSync(join(HERE, "fixtures", "midpen-activity-list.html"), "utf8");
const DETAIL = readFileSync(join(HERE, "fixtures", "midpen-event-detail.html"), "utf8");
// "History on Two Wheels" — the page whose turn-by-turn directions run longer
// than its write-up, which shipped as the event description on the first live
// run before the DIRECTIONS filter existed.
const DETAIL_LONG_DIRECTIONS = readFileSync(
  join(HERE, "fixtures", "midpen-event-detail-directions.html"),
  "utf8",
);

test("midpenClockTime normalizes both punctuations the same table uses", () => {
  assert.equal(midpenClockTime("9:00 a.m."), "9:00 AM");
  assert.equal(midpenClockTime("6:00 pm"), "6:00 PM");
  assert.equal(midpenClockTime("12:00 pm"), "12:00 PM");
  assert.equal(midpenClockTime("9 a.m."), "9:00 AM");
  assert.equal(midpenClockTime(""), null);
  assert.equal(midpenClockTime("all day"), null);
  // Out-of-range values are rejected rather than wrapped into a wrong hour.
  assert.equal(midpenClockTime("13:00 pm"), null);
  assert.equal(midpenClockTime("9:75 am"), null);
});

test("midpenIsoDate accepts abbreviated and full month names", () => {
  assert.equal(midpenIsoDate("Saturday, Sep 12, 2026"), "2026-09-12");
  assert.equal(midpenIsoDate("Sunday, September 6, 2026"), "2026-09-06");
  assert.equal(midpenIsoDate("Tuesday, Sept. 8, 2026"), "2026-09-08");
  assert.equal(midpenIsoDate("no date here"), null);
});

test("preserve map covers only Santa Clara County, keyed on the district's own directions", () => {
  // Sierra Azul reads as a Los Gatos preserve but its public trailhead is the
  // Mt. Umunhum summit lot off Hwy 85 at Camden Ave, which is San Jose.
  assert.equal(midpenPreserveCity("Sierra Azul Preserve"), "san-jose");
  assert.equal(midpenPreserveCity("Fremont Older Preserve"), "cupertino");
  assert.equal(midpenPreserveCity("Bear Creek Redwoods Preserve"), "los-gatos");
  // San Mateo County and the straddling Skyline preserves stay out.
  assert.equal(midpenPreserveCity("Windy Hill Preserve"), null);
  assert.equal(midpenPreserveCity("El Corte de Madera Creek Preserve"), null);
  assert.equal(midpenPreserveCity("Skyline Ridge Preserve"), null);
  assert.equal(midpenPreserveCity(""), null);
  assert.equal(midpenPreserveCity(undefined), null);
  // Every mapped city must be a slug the rest of the pipeline knows.
  const CITIES = new Set([
    "san-jose", "palo-alto", "mountain-view", "los-gatos", "saratoga",
    "cupertino", "los-altos", "santa-clara", "milpitas", "campbell",
    "sunnyvale", "santa-cruz", "monte-sereno",
  ]);
  for (const city of Object.values(MIDPEN_PRESERVE_CITY)) {
    assert.ok(CITIES.has(city), `unknown city slug: ${city}`);
  }
});

test("parseMidpenListPage reads columns by class and drops Board meetings", () => {
  const rows = parseMidpenListPage(LIST);
  // The fixture holds three rows; the Meeting one belongs to the civic
  // pipeline, not the events corpus.
  assert.equal(rows.length, 2);
  assert.ok(!rows.some((row) => row.type === "Meeting"));

  for (const row of rows) {
    assert.match(row.path, /^\/events\//);
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(row.title.length > 0);
    assert.ok(row.preserve.length > 0);
  }

  const guided = rows.find((row) => row.type === "Guided Activity");
  assert.ok(guided, "guided activity row parsed");
  assert.equal(typeof guided.time, "string");
  // Miles is a real number or null — never the empty cell string.
  for (const row of rows) {
    assert.ok(row.miles === null || /^\d+(\.\d+)?$/.test(row.miles));
  }
});

test("parseMidpenListPage tolerates junk without throwing", () => {
  assert.deepEqual(parseMidpenListPage(""), []);
  assert.deepEqual(parseMidpenListPage("<table><tr><td>nope</td></tr></table>"), []);
  assert.deepEqual(parseMidpenListPage(undefined), []);
});

test("parseMidpenDetail pulls the write-up, trailhead and end time", () => {
  const detail = parseMidpenDetail(DETAIL);
  assert.match(detail.description, /San Andreas Fault/);
  // The footer boilerplate is longer than some write-ups; it must not win.
  assert.doesNotMatch(detail.description, /^To ensure your experience/);
  assert.match(detail.meetingPlace, /^Meet at Los Trancos Parking Area/);
  assert.doesNotMatch(detail.meetingPlace, /Link to Google Map/);
  assert.equal(detail.startTime, "9:30 AM");
  assert.equal(detail.endTime, "12:30 PM");
});

test("parseMidpenDetail returns nulls rather than throwing on an empty page", () => {
  const detail = parseMidpenDetail("<html><body></body></html>");
  assert.equal(detail.description, null);
  assert.equal(detail.meetingPlace, null);
  assert.equal(detail.endTime, null);
});

test("midpenText decodes the entities the district's titles actually carry", () => {
  assert.equal(midpenText("St. Joseph&#039;s Hill Preserve"), "St. Joseph's Hill Preserve");
  assert.equal(midpenText("<div> Guided  Activity </div>"), "Guided Activity");
});

test("parseMidpenDetail never returns driving directions as the description", () => {
  const detail = parseMidpenDetail(DETAIL_LONG_DIRECTIONS);
  assert.match(detail.description, /mountain bike/);
  assert.doesNotMatch(detail.description, /Exit Highway 85/);
  assert.doesNotMatch(detail.description, /turn (left|right)/i);
  assert.doesNotMatch(detail.description, /Prospect Parking Area/);
  // The directions are still available where they belong.
  assert.match(detail.meetingPlace, /Prospect Road in Cupertino/);
});

test("midpenTrailhead keeps the meeting point and drops the route", () => {
  assert.equal(
    midpenTrailhead("Meet at the Prospect Parking Area on Prospect Road in Cupertino. Exit Highway 85 at De Anza Boulevard."),
    "Prospect Parking Area on Prospect Road in Cupertino",
  );
  // "Mt." must not be read as a sentence end.
  assert.equal(
    midpenTrailhead("Meet at the Mt. Umunhum Summit Parking Area at the top of Mt. Umunhum Road. Exit Highway 85 at Camden Avenue."),
    "Mt. Umunhum Summit Parking Area at the top of Mt. Umunhum Road",
  );
  // A parenthetical that helps a reader find the right lot is preserved.
  assert.match(
    midpenTrailhead("Meet at Los Trancos Parking Area on Page Mill Road (across from Monte Bello Preserve), 7 miles west of I-280. Those traveling from I-280 on Page Mill Rd. should allow 35 minutes."),
    /^Los Trancos Parking Area on Page Mill Road \(across from Monte Bello Preserve\)/,
  );
  assert.doesNotMatch(
    midpenTrailhead("Meet at Los Trancos Parking Area on Page Mill Road. Those traveling from I-280 on Page Mill Rd. should allow 35 minutes."),
    /Those traveling/,
  );
  // A single-sentence block survives whole.
  assert.match(
    midpenTrailhead("Meet at Caltran's Saratoga Gap Vista Point Parking Area on the southeast corner of the Skyline Boulevard (Highway 35) and Highway 9 intersection."),
    /^Caltran's Saratoga Gap Vista Point Parking Area/,
  );
  assert.equal(midpenTrailhead(""), null);
  assert.equal(midpenTrailhead(null), null);
});
