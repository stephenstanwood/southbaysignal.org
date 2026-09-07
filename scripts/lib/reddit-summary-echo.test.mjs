import test from "node:test";
import assert from "node:assert/strict";
import { novelWordCount, summaryEchoesTitle } from "./reddit-summary-echo.mjs";

// The two "Around town" rows from the 2026-09-07 issue, verbatim.
const VTA_TITLE = "VTA defends its plan to extend BART to downtown San Jose";
const VTA_SUMMARY = "VTA defends its plan to extend BART service to downtown San Jose.";
const LOWRIDER_TITLE = "San Jose Lowrider Day 2026";
const LOWRIDER_SUMMARY = "Annual San Jose Lowrider Day showcased custom cars in downtown San Jose.";

test("a summary that only re-says its headline is an echo", () => {
  // One novel word ("service") across a whole sentence.
  assert.equal(novelWordCount(VTA_TITLE, VTA_SUMMARY), 1);
  assert.equal(summaryEchoesTitle(VTA_TITLE, VTA_SUMMARY), true);
});

test("a milder summary that adds real detail is kept", () => {
  // The issue's other flagged row. It restates the name but adds what
  // happened, so the reader gets something from the second line.
  assert.equal(summaryEchoesTitle(LOWRIDER_TITLE, LOWRIDER_SUMMARY), false);
});

test("summaries that add framing survive", () => {
  // Every post in the live feed on 2026-09-07. None may be dropped.
  const live = [
    ["Bars with Dodger games",
      "A Dodgers fan asks for San Jose bars that show Dodgers games and other fans to watch with."],
    ["transit app routes question",
      "A first-time public transit rider shares mixed experiences using the Transit app for bus routes."],
    ["I'm dying of suspense: Any word on the Eastridge Rave?",
      "Someone asks if anyone has details or attended the Eastridge Rave."],
  ];
  for (const [title, summary] of live) {
    assert.equal(summaryEchoesTitle(title, summary), false, title);
  }
});

test("the verbatim-title fallback is caught", () => {
  // generate-reddit-pulse sets `summary: c.title` for any post the classifier
  // did not return.
  assert.equal(summaryEchoesTitle(VTA_TITLE, VTA_TITLE), true);
  assert.equal(summaryEchoesTitle(VTA_TITLE, `${VTA_TITLE}.`), true);
  assert.equal(summaryEchoesTitle("Bars with Dodger games", "bars with dodger games"), true);
});

test("a missing summary is an echo, and a missing title decides nothing", () => {
  assert.equal(summaryEchoesTitle(VTA_TITLE, ""), true);
  assert.equal(summaryEchoesTitle(VTA_TITLE, null), true);
  assert.equal(summaryEchoesTitle(VTA_TITLE, "   "), true);
  // With no headline to compare against there is no echo to detect.
  assert.equal(summaryEchoesTitle("", "A Dodgers fan asks for San Jose bars."), false);
});

test("plurals do not count as novel words", () => {
  assert.equal(novelWordCount("Bars with Dodger games", "Bar with Dodger game"), 0);
  assert.equal(summaryEchoesTitle("Bars with Dodger games", "Bar with Dodger game"), true);
});
