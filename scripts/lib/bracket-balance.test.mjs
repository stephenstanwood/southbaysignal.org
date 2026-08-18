import test from "node:test";
import assert from "node:assert/strict";

import { dropUnmatchedClosers } from "./bracket-balance.mjs";
import { cleanTitle } from "../generate-events.mjs";

// ---------------------------------------------------------------------------
// dropUnmatchedClosers
// ---------------------------------------------------------------------------

test("dropUnmatchedClosers removes a closer with no opener", () => {
  assert.equal(dropUnmatchedClosers("Chinese Orchestra)"), "Chinese Orchestra");
});

test("dropUnmatchedClosers leaves balanced brackets alone", () => {
  assert.equal(
    dropUnmatchedClosers("Concert (Chinese Orchestra)"),
    "Concert (Chinese Orchestra)",
  );
  assert.equal(dropUnmatchedClosers("Book Club [Ages 8-12]"), "Book Club [Ages 8-12]");
  assert.equal(dropUnmatchedClosers("Nested ((Deep)) Title"), "Nested ((Deep)) Title");
});

test("dropUnmatchedClosers drops only the orphaned closer, keeping matched pairs", () => {
  assert.equal(dropUnmatchedClosers("Foo (Bar) Baz)"), "Foo (Bar) Baz");
});

test("dropUnmatchedClosers covers square, curly, fullwidth, and lenticular brackets", () => {
  assert.equal(dropUnmatchedClosers("Storytime]"), "Storytime");
  assert.equal(dropUnmatchedClosers("Storytime}"), "Storytime");
  assert.equal(dropUnmatchedClosers("Storytime）"), "Storytime");
  assert.equal(dropUnmatchedClosers("Storytime】"), "Storytime");
});

test("dropUnmatchedClosers counts bracket types independently", () => {
  // The stray ")" must not consume the "[" that opened a different type.
  assert.equal(dropUnmatchedClosers("Talk) [Free]"), "Talk [Free]");
});

test("dropUnmatchedClosers keeps openers and handles empty input", () => {
  assert.equal(dropUnmatchedClosers("Series (part one"), "Series (part one");
  assert.equal(dropUnmatchedClosers(""), "");
  assert.equal(dropUnmatchedClosers(null), null);
});

// ---------------------------------------------------------------------------
// cleanTitle — the shipped regression
// ---------------------------------------------------------------------------

// SJPL BiblioCommons event sjpl-6a7e0a15d4b10d0030064526, a recurring series.
// The CJK-prefix strip cut to the first Latin letter, eating the "(" and
// leaving "Chinese Orchestra)" — which shipped in the 2026-08-18 newsletter.
test("cleanTitle keeps a bilingual parenthesized title from losing its bracket", () => {
  assert.equal(
    cleanTitle("大朋友(50+)社區团体活动 ( Chinese Orchestra)"),
    "Chinese Orchestra",
  );
});

test("cleanTitle still strips a plain CJK prefix", () => {
  assert.equal(
    cleanTitle("中/英文雙語說故事時間 Mandarin/English Storytime"),
    "Mandarin/English Storytime",
  );
  assert.equal(cleanTitle("四姐 Special Noodle"), "Special Noodle");
});

test("cleanTitle leaves an all-Latin parenthetical untouched", () => {
  // The guard TITLE_FIXES could not provide: a replaceAll entry for
  // "Chinese Orchestra)" would have corrupted this title too.
  assert.equal(cleanTitle("Concert (Chinese Orchestra)"), "Concert (Chinese Orchestra)");
});
