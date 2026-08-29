import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeHicklebeesText,
  hicklebeesClockTime,
  hicklebeesMonthPaths,
  parseHicklebeesListPage,
} from "./hicklebees-events.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Trimmed from the live https://hicklebees.com/events response, 2026-08-29.
const LIST_ROW = `
<div class="views-row">
<article id="event-1171" class="event-list">
  <div class="event-list__first">
    <div class="event-list__date">
      <span class="event-list__date--month">Aug</span>
      <span class="event-list__date--day">22</span>
    </div>
  </div>
  <div class="event-list__second">
    <div class="event-list__details">
      <h3 class="event-list__title">
        <a href="/event/2026-08-22/storytime-beauty-and-beast" hreflang="en">Storytime and Sing Along with Broadway San Jose: Disney&#039;s Beauty and the Beast</a>
      </h3>
      <div class="event-list__details--item">
        <span class="event-list__details--label">Date: </span>
                    Sat, 8/22/2026
      </div>
      <div class="event-list__details--item">
        <span class="event-list__details--label">Time: </span>
                    11:00am
      </div>
    </div>
  </div>
</article>
</div>`;

// The footer "Upcoming Event" widget. The original adapter split on
// `class="event-block__first` and therefore read THIS instead of the list.
const FOOTER_WIDGET = `
<div class="views-row">
<article class="event-block">
  <div class="event-block__first">
    <div class="event-block__date">
      <span class="event__month event__month--start">Sep</span>
      <span class="event__day event__day--start">24</span>
    </div>
    <h3 class="event-block__title">Educator Night 2026</h3>
  </div>
  <div class="event-block__cta">
    <a class="button--transparent" href="/event/2026-09-24/educator-night-2026">View event</a>
  </div>
</article>
</div>`;

test("parses title, ISO date, and clock time from a live list row", () => {
  const { rows, articleCount } = parseHicklebeesListPage(LIST_ROW);
  assert.equal(articleCount, 1);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    title: "Storytime and Sing Along with Broadway San Jose: Disney's Beauty and the Beast",
    date: "2026-08-22",
    time: "11:00 AM",
    endTime: null,
    url: "https://hicklebees.com/event/2026-08-22/storytime-beauty-and-beast",
  });
});

test("the footer Upcoming Event widget is not mistaken for the event list", () => {
  // Regression: the pre-2026-08-29 parser targeted event-block__first, so it
  // could only ever surface this one footer entry.
  const { rows, articleCount } = parseHicklebeesListPage(FOOTER_WIDGET);
  assert.equal(articleCount, 0);
  assert.equal(rows.length, 0);
});

test("a quiet month reports no articles, which is not parser drift", () => {
  const { rows, articleCount } = parseHicklebeesListPage("<div class='view-empty'>No events</div>");
  assert.equal(articleCount, 0);
  assert.equal(rows.length, 0);
});

test("renamed markup shows up as articles present but nothing parsed", () => {
  // This is the signal the adapter turns into a thrown "parser drift" error.
  const drifted = LIST_ROW.replace('class="event-list__title"', 'class="event-list__headline"');
  const { rows, articleCount } = parseHicklebeesListPage(drifted);
  assert.equal(articleCount, 1);
  assert.equal(rows.length, 0);
});

test("a time range yields both start and end", () => {
  const ranged = LIST_ROW.replace("11:00am", "11:00am - 1:30pm");
  const { rows } = parseHicklebeesListPage(ranged);
  assert.equal(rows[0].time, "11:00 AM");
  assert.equal(rows[0].endTime, "1:30 PM");
});

test("clock times normalize to the repo-wide format", () => {
  assert.equal(hicklebeesClockTime("11:00am"), "11:00 AM");
  assert.equal(hicklebeesClockTime("5:00pm"), "5:00 PM");
  assert.equal(hicklebeesClockTime("7 p.m."), "7:00 PM");
  assert.equal(hicklebeesClockTime("12:30pm"), "12:30 PM");
  assert.equal(hicklebeesClockTime("12:00am"), null);
  assert.equal(hicklebeesClockTime(""), null);
});

test("entities decode instead of leaking into titles", () => {
  assert.equal(decodeHicklebeesText("Hicklebee&#039;s &amp; Co"), "Hicklebee's & Co");
});

test("month paths walk forward across a year boundary", () => {
  assert.deepEqual(hicklebeesMonthPaths("2026-11-15", 3), [
    "/events/2026/11",
    "/events/2026/12",
    "/events/2027/01",
    "/events/2027/02",
  ]);
});

// ---------------------------------------------------------------------------
// The bug that paged #tasks for three weeks was a spoofed User-Agent, not a
// parsing mistake. Cloudflare 403s a Node client claiming to be Safari because
// the TLS/HTTP2 fingerprint contradicts the header; the default headers get a
// 200. Keep the next well-meaning "add a browser UA" edit from re-breaking it.
// ---------------------------------------------------------------------------
test("the Hicklebee's adapter sends no spoofed browser User-Agent", () => {
  const src = readFileSync(join(ROOT, "scripts", "generate-events.mjs"), "utf8");
  const start = src.indexOf("// Hicklebee's (IndieCommerce");
  const end = src.indexOf("// ── Time backfill");
  assert.ok(start > 0 && end > start, "could not locate the Hicklebee's adapter");
  const section = src.slice(start, end);

  const fetchCalls = section.match(/fetch\([\s\S]*?\}\);/g) || [];
  assert.ok(fetchCalls.length > 0, "expected the adapter to fetch something");
  for (const call of fetchCalls) {
    assert.ok(
      !/user-agent/i.test(call),
      "hicklebees.com 403s a spoofed browser User-Agent — send Node's default headers",
    );
  }
});
