import assert from "node:assert/strict";
import test from "node:test";

import { extractTimeFromHtml } from "../generate-events.mjs";

const page = (body) => `<html><body>${body}</body></html>`;

test("JSON-LD start time wins over anything in the body copy", () => {
  const html = page(`
    <script type="application/ld+json">
      {"@type":"Event","name":"Recital","startDate":"2026-09-17T19:30:00-07:00"}
    </script>
    <p>City Hall hours: Open 9 am-12 pm</p>
  `);
  assert.equal(extractTimeFromHtml(html, "2026-09-17"), "7:30 PM");
});

test("city hall footer hours do not become an event start time", () => {
  // The real shape of Monte Sereno's CivicPlus page, which turned an eight-week
  // police academy into a 9:00 AM event.
  const html = page(`
    <h1>Community Police Academy</h1>
    <p>The Los Gatos-Monte Sereno Police Department is proud to offer a
       Community Police Academy to residents and businesses.</p>
    <footer>Monte Sereno, CA 95030 Phone: (408) 354-7635
      Monday, Wednesday, Friday: Open 9 am-12 pm; Closed for lunch 12 pm-1 pm;
      Open 1 pm-4 pm</footer>
  `);
  assert.equal(extractTimeFromHtml(html, "2026-09-17"), null);
});

test("a real doors time still comes through", () => {
  const html = page("<p>Doors open at 7 PM, music at 8.</p>");
  assert.equal(extractTimeFromHtml(html, "2026-09-17"), "7:00 PM");
});

test("an hours block is skipped in favor of the event time further down", () => {
  const html = page(`
    <p>Gallery hours: 10 am-5 pm daily.</p>
    <p>The lecture begins at 6:30 pm in the courtyard.</p>
  `);
  assert.equal(extractTimeFromHtml(html, "2026-09-17"), "6:30 PM");
});

test("a page with nothing but opening hours yields no time", () => {
  const html = page("<p>Front counter hours: 10 am-12 pm. Walk-ins welcome.</p>");
  assert.equal(extractTimeFromHtml(html, "2026-09-17"), null);
});
