import assert from "node:assert/strict";
import test from "node:test";

import {
  extractAnthropicText,
  eventBlurbCacheKey,
  parseFpKey,
  isSameSeriesKey,
  migrateLegacyFingerprintKeys,
} from "./eventBlurbs.mjs";

test("extracts the text block when adaptive thinking comes first", () => {
  const response = {
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: '[{"i":1,"blurb":"Hear live jazz downtown."}]' },
    ],
  };

  assert.equal(
    extractAnthropicText(response),
    '[{"i":1,"blurb":"Hear live jazz downtown."}]',
  );
});

test("returns an empty string when a response has no text block", () => {
  assert.equal(extractAnthropicText({ content: [{ type: "thinking", thinking: "" }] }), "");
  assert.equal(extractAnthropicText(null), "");
});

// ── Cache key: recurring series must not inherit a stale month's facts ──────
//
// Kepler's Books runs "Story Is the Thing" monthly with a different author
// lineup each time. Under the old `fp:<title>|<venue>` key the blurb generated
// 2026-04-26 ("Ellen Barker, Portia Elan, Andrew Lam, and Victoria Tatum") was
// served for every later month, so the 2026-08-06 issue published four real
// people as appearing at an event they were not at.

const APRIL = {
  title: "Story Is the Thing",
  venue: "Kepler's Books",
  description:
    "Free! Meet and hear from local authors Ellen Barker, Portia Elan, Andrew Lam, and Victoria Tatum",
};
const AUGUST = {
  title: "Story Is the Thing",
  venue: "Kepler's Books",
  description:
    "Free! Meet and hear from local authors Grant Faulkner, Gordon Jack, Lindsay Kent, and J. P. Lacrampe",
};

test("same title+venue, changed description → cache miss", () => {
  assert.notEqual(
    eventBlurbCacheKey(APRIL),
    eventBlurbCacheKey(AUGUST),
    "a new author lineup must not reuse April's cached blurb",
  );
});

test("same title+venue, same description → cache hit", () => {
  assert.equal(eventBlurbCacheKey(AUGUST), eventBlurbCacheKey({ ...AUGUST }));
});

test("description differences that aren't real differences still hit", () => {
  assert.equal(
    eventBlurbCacheKey(AUGUST),
    eventBlurbCacheKey({ ...AUGUST, description: `  ${AUGUST.description.toUpperCase()}\n\n ` }),
  );
});

test("events with no description share one stable key", () => {
  const a = { title: "Storytime", venue: "Los Gatos Library" };
  assert.equal(eventBlurbCacheKey(a), eventBlurbCacheKey({ ...a, description: "" }));
  assert.equal(eventBlurbCacheKey(a), eventBlurbCacheKey({ ...a, description: null }));
});

test("title+venue still separate events that share a URL", () => {
  const base = { description: "MLS home game" };
  assert.notEqual(
    eventBlurbCacheKey({ ...base, title: "Quakes vs LA Galaxy", venue: "PayPal Park" }),
    eventBlurbCacheKey({ ...base, title: "Quakes vs Portland Timbers", venue: "PayPal Park" }),
  );
});

// ── Key parsing ────────────────────────────────────────────────────────────

test("parseFpKey round-trips title, venue and description fingerprint", () => {
  const parsed = parseFpKey(eventBlurbCacheKey(AUGUST));
  assert.equal(parsed.title, "story is the thing");
  assert.equal(parsed.venue, "kepler's books");
  assert.match(parsed.descFp, /^[0-9a-f]{12}$/);
});

test("parseFpKey survives a title containing a pipe", () => {
  const parsed = parseFpKey(eventBlurbCacheKey({ title: "Jazz | Blues Night", venue: "Cafe Stritch", description: "d" }));
  assert.equal(parsed.title, "jazz | blues night");
  assert.equal(parsed.venue, "cafe stritch");
});

test("parseFpKey still reads legacy two-component keys", () => {
  assert.deepEqual(parseFpKey("fp:story is the thing|kepler's books"), {
    title: "story is the thing",
    venue: "kepler's books",
    descFp: "",
  });
});

test("parseFpKey ignores non-fingerprint keys", () => {
  assert.deepEqual(parseFpKey("url:https://example.com"), { title: "", venue: "", descFp: "" });
  assert.deepEqual(parseFpKey(null), { title: "", venue: "", descFp: "" });
});

// ── Same-series detection ──────────────────────────────────────────────────

test("two occurrences of one series are not a boilerplate collision", () => {
  assert.equal(isSameSeriesKey(eventBlurbCacheKey(APRIL), eventBlurbCacheKey(AUGUST)), true);
});

test("different events at different venues are still a collision", () => {
  const a = eventBlurbCacheKey({ title: "Farmers Market", venue: "Campbell", description: "x" });
  const b = eventBlurbCacheKey({ title: "Farmers Market", venue: "Saratoga", description: "y" });
  assert.equal(isSameSeriesKey(a, b), false);
});

test("a key is not its own series conflict", () => {
  const k = eventBlurbCacheKey(AUGUST);
  assert.equal(isSameSeriesKey(k, k), false);
});

// ── Legacy migration ───────────────────────────────────────────────────────

test("legacy entries are dropped for events that have a description", () => {
  const cache = { byKey: { "fp:story is the thing|kepler's books": { blurb: "April's lineup." } } };
  const stats = migrateLegacyFingerprintKeys(cache, [AUGUST]);

  assert.deepEqual(stats, { migrated: 0, dropped: 1 });
  assert.equal(cache.byKey["fp:story is the thing|kepler's books"], undefined);
  assert.equal(cache.byKey[eventBlurbCacheKey(AUGUST)], undefined, "must regenerate, not adopt");
});

test("legacy entries carry forward when the event has no description", () => {
  const event = { title: "Storytime", venue: "Los Gatos Library" };
  const cache = { byKey: { "fp:storytime|los gatos library": { blurb: "Hear picture books read aloud." } } };
  const stats = migrateLegacyFingerprintKeys(cache, [event]);

  assert.deepEqual(stats, { migrated: 1, dropped: 0 });
  assert.equal(cache.byKey["fp:storytime|los gatos library"], undefined);
  assert.equal(cache.byKey[eventBlurbCacheKey(event)].blurb, "Hear picture books read aloud.");
});

test("legacy entries for events outside this run are left alone", () => {
  // Pruning off the live event list would delete blurbs for anything outside
  // the current window — the partial-regen data-loss shape.
  const cache = { byKey: { "fp:some old event|some venue": { blurb: "Kept." } } };
  const stats = migrateLegacyFingerprintKeys(cache, [AUGUST]);

  assert.deepEqual(stats, { migrated: 0, dropped: 0 });
  assert.equal(cache.byKey["fp:some old event|some venue"].blurb, "Kept.");
});

test("migration does not clobber an already-current entry", () => {
  const event = { title: "Storytime", venue: "Los Gatos Library" };
  const cache = {
    byKey: {
      "fp:storytime|los gatos library": { blurb: "Stale." },
      [eventBlurbCacheKey(event)]: { blurb: "Current." },
    },
  };
  migrateLegacyFingerprintKeys(cache, [event]);
  assert.equal(cache.byKey[eventBlurbCacheKey(event)].blurb, "Current.");
});
