// ---------------------------------------------------------------------------
// editorial-voice.test.mjs
//
// Unit tests for the two shared copy rules in content-rules.mjs. Both cases
// below shipped live in src/data/south-bay/city-briefings.json on 2026-08-29:
//
//   - "Palo Alto's weekend leans quiet and communal" — CLAUDE.md forbids
//     calling a day quiet/slow/thin/etc. The only implementation of that rule
//     lived in the newsletter and its day vocabulary had no "weekend", so a
//     weekend claim walked straight past it.
//   - "Montalvo Arts Center stages ... tonight" — written the previous
//     evening about a Friday show, still being served on Saturday.
//
// Run: node --test scripts/social/lib/editorial-voice.test.mjs
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasDownbeatDayLanguage,
  hasRelativeDayReference,
} from "./content-rules.mjs";

// ── hasDownbeatDayLanguage ──

test("weekend and week count as day context", () => {
  // The regression: the newsletter's private list stopped at the weekday names
  // plus "day", and "weekend" does not contain a \bday\b.
  assert.ok(
    hasDownbeatDayLanguage(
      "Palo Alto's weekend leans quiet and communal: a Herbal Tea Party at Gamble Garden.",
    ),
  );
  assert.ok(hasDownbeatDayLanguage("The week is thin on options."));
});

test("the original day vocabulary still trips the rule", () => {
  assert.ok(hasDownbeatDayLanguage("Today looks slow."));
  assert.ok(hasDownbeatDayLanguage("Saturday is sleepy."));
  assert.ok(hasDownbeatDayLanguage("A quiet Sunday in Los Gatos."));
  assert.ok(hasDownbeatDayLanguage("The calendar runs a little light."));
});

test("the banned words are fine when they aren't describing the day", () => {
  // The words themselves are ordinary English — only the claim about a day is
  // banned, so a quiet room and a light jacket have to survive.
  assert.ok(!hasDownbeatDayLanguage("A quiet reading room at the library."));
  assert.ok(
    !hasDownbeatDayLanguage("Bring a light jacket to the evening concert."),
  );
  assert.ok(!hasDownbeatDayLanguage("Sunnyvale hosts three festivals this weekend."));
});

test("empty and missing input is safe", () => {
  assert.ok(!hasDownbeatDayLanguage(""));
  assert.ok(!hasDownbeatDayLanguage(null));
  assert.ok(!hasDownbeatDayLanguage(undefined));
});

// ── hasRelativeDayReference ──

test("relative day words are caught in cached copy", () => {
  assert.ok(
    hasRelativeDayReference(
      'Montalvo Arts Center stages "Ms. Holmes and Ms. Watson" tonight.',
    ),
  );
  assert.ok(hasRelativeDayReference("a Herbal Tea Party at Gamble Garden today"));
  assert.ok(hasRelativeDayReference("The library reopens tomorrow."));
  assert.ok(hasRelativeDayReference("Doors open this evening."));
});

test("named days are what the rule is asking for", () => {
  assert.ok(
    !hasRelativeDayReference(
      "Montalvo Arts Center staged the play Friday, and Saturday brings the Winery show.",
    ),
  );
  assert.ok(!hasRelativeDayReference("Saturday meditation sessions at Mitchell Park."));
});

test("a word merely containing a day token does not trip it", () => {
  assert.ok(!hasRelativeDayReference("The todays-special board is out front."));
  assert.ok(!hasRelativeDayReference(""));
  assert.ok(!hasRelativeDayReference(null));
});
