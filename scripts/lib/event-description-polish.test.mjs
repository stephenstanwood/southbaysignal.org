import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanTitle,
  cleanVenue,
  inferCategory,
  looksLikeEmbedCode,
  polishDescription,
} from "../generate-events.mjs";
import { canonicalHistorySjUrl, inferHistorySjCost } from "./history-sj.mjs";

test("preserves the official BentPeter performer spelling", () => {
  assert.equal(
    polishDescription("Free outdoor concert featuring The BentPeter Band."),
    "Free outdoor concert featuring The BentPeter Band.",
  );
});

test("classifies one-on-one technology help as education", () => {
  assert.equal(
    inferCategory(
      "Digital Skills: One-On-One Tech Help for Seniors",
      "Get help using Libby to read ebooks.",
      "",
      "Almaden Library",
    ),
    "education",
  );
});

test("strips a complete inline address from a display venue", () => {
  assert.equal(
    cleanVenue("History Park, 635 Phelan Ave, San Jose, CA 95112"),
    "History Park",
  );
});

test("History San Jose costs come only from explicit listing evidence", () => {
  assert.equal(inferHistorySjCost("Cost: Free, Register Online"), "free");
  assert.equal(inferHistorySjCost("Cost: $5 – $10"), "paid");
  assert.equal(inferHistorySjCost("Pumpkin supplies included in ticket price"), "paid");
  assert.equal(inferHistorySjCost("Stay tuned for ticket information!"), null);
  assert.equal(
    inferHistorySjCost("", "https://www.chcp.org/event-6795488"),
    "free",
  );
});

test("History San Jose generic listings resolve to first-party event pages", () => {
  assert.equal(
    canonicalHistorySjUrl("San José Roots", "https://historysanjose.org/programs-events/"),
    "https://historysanjose.org/event/san-jose-roots/",
  );
  assert.equal(
    canonicalHistorySjUrl("Children’s Halloween Haunt 2026", "https://historysanjose.org/programs-events/"),
    "https://historysanjose.org/event/childrens-halloween-haunt/",
  );
});

test("restores missing-apostrophe possessives in titles", () => {
  assert.equal(
    cleanTitle("Stanford Cardinal Womens Volleyball vs. Marquette Golden Eagles Womens Volleyball"),
    "Stanford Cardinal Women's Volleyball vs. Marquette Golden Eagles Women's Volleyball",
  );
  assert.equal(cleanTitle("Mens Basketball vs. Cal"), "Men's Basketball vs. Cal");
  assert.equal(cleanTitle("Childrens Storytime"), "Children's Storytime");
});

test("leaves apostrophe-free proper nouns and already-correct copy alone", () => {
  // "Veterans Day" takes no apostrophe by convention.
  assert.equal(cleanTitle("Veterans Day Ceremony"), "Veterans Day Ceremony");
  assert.equal(cleanTitle("Women's March"), "Women's March");
  // Intentional repetition in a stage name, not a duplicated-word typo.
  assert.equal(cleanTitle("Gimme Gimme Disco"), "Gimme Gimme Disco");
});

test("restores missing-apostrophe contractions in body copy", () => {
  assert.equal(
    polishDescription("We dont have tickets yet, but youre welcome to join."),
    "We don't have tickets yet, but you're welcome to join.",
  );
});

test("does not touch words that are valid without an apostrophe", () => {
  // "lets" (permits) and "wont" (accustomed) are real words — never rewritten.
  assert.equal(
    polishDescription("The venue lets us in early and he wont mind."),
    "The venue lets us in early and he wont mind.",
  );
});

test("restores the official RuPaul's Drag Race spelling", () => {
  // Ticketmaster ships "Ru Pauls"; the fix must survive the camel-case splitter.
  const polished = polishDescription("Jane Dont, breakout star of Ru Pauls Drag Race.");
  assert.equal(polished, "Jane Don't, breakout star of RuPaul's Drag Race.");
  // Idempotent: re-polishing generated output must not drift.
  assert.equal(polishDescription(polished), polished);
});

test("flags a ticketing widget snippet scraped in place of a description", () => {
  assert.equal(
    looksLikeEmbedCode(
      "Var example Callback = function { console. Log('Order complete!'); }; " +
        "window. EB Widgets. Create Widget({ // Required widget Type: 'checkout', " +
        "event Id: '1993870955702', iframe Container Id:…",
    ),
    true,
  );
});

test("leaves ordinary event prose alone", () => {
  assert.equal(
    looksLikeEmbedCode(
      "Taste chile, mole, and pozole dishes while celebrating regional Mexican " +
        "cuisine at the School of Arts and Culture. Tickets at the door.",
    ),
    false,
  );
  assert.equal(
    looksLikeEmbedCode(
      "A talk on how a public library actually functions as a civic institution.",
    ),
    false,
  );
});

test("drops a dangling separator left by an empty concatenated field", () => {
  assert.equal(cleanTitle("Bolly EDM Dance Night |"), "Bolly EDM Dance Night");
  assert.equal(
    cleanTitle("Into the Body: A Drum, Voice & Gong Sound Experience |"),
    "Into the Body: A Drum, Voice & Gong Sound Experience",
  );
  // Separators inside a title, and hyphenated words, stay put.
  assert.equal(
    cleanTitle("Tech Mentor / Computer & iPad Assistance"),
    "Tech Mentor / Computer & iPad Assistance",
  );
  assert.equal(cleanTitle("Movie Night: Spider-Man"), "Movie Night: Spider-Man");
  // A trailing "+" is an age/grade range, not a dangling separator.
  assert.equal(
    cleanTitle("Lego Spike Robotics & Engineering for Grades 6+"),
    "Lego Spike Robotics & Engineering for Grades 6+",
  );
});

test("promotes a billing line mis-joined as a support act", () => {
  assert.equal(
    cleanTitle("Peter Hook & The Light with Performing 'Get Ready' live and in full"),
    "Peter Hook & The Light — Performing 'Get Ready' live and in full",
  );
  // A real opener keeps "with".
  assert.equal(
    cleanTitle("Pat Benatar & Neil Giraldo with Lee DeWyze"),
    "Pat Benatar & Neil Giraldo with Lee DeWyze",
  );
});
