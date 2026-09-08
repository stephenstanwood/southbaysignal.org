import assert from "node:assert/strict";
import test from "node:test";

import { parsePage } from "./audit.mjs";

test("metadata extraction keeps greater-than signs inside quoted attributes", () => {
  const description =
    "2026-27 Taemin World Tour <LiMiNaL> in San Jose on Monday, October 12, 2026.";
  const html = `<!doctype html>
    <html lang="en">
      <head>
        <title>Taemin &lt;LiMiNaL&gt; — South Bay Today</title>
        <meta name="description" content="${description}">
        <meta property="og:title" content="Taemin <LiMiNaL> — South Bay Today">
        <meta property="og:image" content="https://southbaytoday.org/images/taemin.jpg">
        <link rel="canonical" href="https://southbaytoday.org/event/taemin">
      </head>
      <body><h1>Taemin &lt;LiMiNaL&gt;</h1></body>
    </html>`;

  const page = parsePage(html, "https://southbaytoday.org/event/taemin");

  assert.equal(page.description, description);
  assert.equal(page.ogTitle, "Taemin <LiMiNaL> — South Bay Today");
  assert.equal(page.canonical, "https://southbaytoday.org/event/taemin");
});
