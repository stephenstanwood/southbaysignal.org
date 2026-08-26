import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractAnthropicText,
  eventBlurbCacheKey,
  parseFpKey,
  isSameSeriesKey,
  migrateLegacyFingerprintKeys,
  eventStartHour,
  blurbTimeOfDayConflict,
  timeLabelForOccurrences,
  sweepTimeOfDayConflicts,
  isTruncatedDescription,
  blurbInventsTruncatedDetail,
  blurbSequencePositionConflict,
  runLabelForOccurrences,
  sweepSequencePositionClaims,
  blurbDayOfWeekConflict,
  dayLabelForOccurrences,
  sweepDayOfWeekConflicts,
} from "./eventBlurbs.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

// ── Time-of-day agreement ──────────────────────────────────────────────────
//
// Shipped 2026-08-10: the 7:00 PM "Monday Meditation & Mindfulness" at
// Woodland Library went out telling subscribers to come "on Monday mornings".
// Its 10:30 AM sibling at Los Altos Library is the same SCCL series with a
// byte-identical description, so the two sat in one 30-event batch — and the
// prompt carried no start time for either, leaving the sibling's title as the
// only time signal in scope. Cache keys were never the problem: the two events
// differ in both title and venue, so they had separate entries all along.

const WOODLAND = {
  title: "Monday Meditation & Mindfulness",
  venue: "Woodland Library",
  time: "7:00 PM",
};
const LOS_ALTOS = {
  title: "Monday Morning Meditation & Mindfulness",
  venue: "Los Altos Library",
  time: "10:30 AM",
};

test("the shipped defect is caught", () => {
  assert.equal(
    blurbTimeOfDayConflict(
      "Sit for a guided 20-minute meditation with instructor Manisha, then ask questions on Monday mornings.",
      [WOODLAND],
    ),
    "mornings",
  );
});

test("the morning sibling keeps its accurate copy", () => {
  assert.equal(
    blurbTimeOfDayConflict(
      "Practice a guided meditation and pose questions to instructor Manisha at Los Altos Library on Monday mornings.",
      [LOS_ALTOS],
    ),
    null,
  );
});

test("the corrected Woodland copy passes", () => {
  assert.equal(
    blurbTimeOfDayConflict(
      "Sit for a guided 20-minute meditation with instructor Manisha, then ask questions for the last ten.",
      [WOODLAND],
    ),
    null,
  );
});

test("each time-of-day word is checked against the start hour", () => {
  const at = (time) => [{ title: "X", venue: "Y", time }];
  assert.equal(blurbTimeOfDayConflict("Dance the afternoon away.", at("7:00 PM")), "afternoon");
  assert.equal(blurbTimeOfDayConflict("Dance the night away.", at("4:00 PM")), "night");
  assert.equal(blurbTimeOfDayConflict("Walk with a naturalist Wednesday morning.", at("12:00 PM")), "morning");
  assert.equal(blurbTimeOfDayConflict("Sip coffee at brunch.", at("6:00 PM")), "brunch");
  assert.equal(blurbTimeOfDayConflict("Watch the sunrise over the bay.", at("8:00 PM")), "sunrise");
  assert.equal(blurbTimeOfDayConflict("Hear a midday concert.", at("8:00 PM")), "midday");
});

test("boundary hours read either way rather than failing a good blurb", () => {
  const at = (time) => [{ title: "X", venue: "Y", time }];
  assert.equal(blurbTimeOfDayConflict("Hear jazz in the afternoon.", at("5:00 PM")), null);
  assert.equal(blurbTimeOfDayConflict("Hear jazz in the evening.", at("5:00 PM")), null);
  assert.equal(blurbTimeOfDayConflict("Practice Qi Gong on Friday afternoons.", at("1:00 PM")), null);
  assert.equal(blurbTimeOfDayConflict("Sit for a morning meditation.", at("11:30 AM")), null);
});

test("a time-of-day word from the event's own name is not a claim about when", () => {
  // "Good Morning Vietnam" at 7:00 PM is a title being quoted, not an
  // instruction to show up in the morning.
  assert.equal(
    blurbTimeOfDayConflict("Watch Good Morning Vietnam on the big screen.", [
      { title: "Good Morning Vietnam screening", venue: "The Retro Dome", time: "7:00 PM" },
    ]),
    null,
  );
});

test("word boundaries keep 'noon' out of 'afternoon' and 'night' out of 'tonight'", () => {
  const at = (time) => [{ title: "X", venue: "Y", time }];
  assert.equal(blurbTimeOfDayConflict("Tour the gardens in the afternoon.", at("2:00 PM")), null);
  // "tonight" belongs to the date-leak filter, not this one.
  assert.equal(blurbTimeOfDayConflict("Catch the band tonight downtown.", at("10:00 AM")), null);
});

test("an event with no usable time can't contradict anything", () => {
  assert.equal(blurbTimeOfDayConflict("Sit for a morning meditation.", [{ title: "X", time: "" }]), null);
  assert.equal(blurbTimeOfDayConflict("Sit for a morning meditation.", [{ title: "X" }]), null);
  assert.equal(blurbTimeOfDayConflict("Sit for a morning meditation.", []), null);
  assert.equal(blurbTimeOfDayConflict("", [WOODLAND]), null);
});

test("one entry serving several start times must hold for all of them", () => {
  // Monster Jam runs 12:00 PM, 1:00 PM and 7:00 PM off a single cache key.
  const showtimes = ["12:00 PM", "1:00 PM", "7:00 PM"].map((time) => ({
    title: "Monster Jam",
    venue: "SAP Center",
    time,
  }));
  assert.equal(blurbTimeOfDayConflict("Watch trucks race in the evening.", showtimes), "evening");
  assert.equal(blurbTimeOfDayConflict("Watch trucks race over crushed cars.", showtimes), null);
});

test("start hours parse the formats the event data actually uses", () => {
  assert.equal(eventStartHour("7:00 PM"), 19);
  assert.equal(eventStartHour("10:30 AM"), 10.5);
  assert.equal(eventStartHour("12:00 PM"), 12);
  assert.equal(eventStartHour("12:00 AM"), 0);
  assert.equal(eventStartHour("9 am"), 9);
  assert.equal(eventStartHour(""), null);
  assert.equal(eventStartHour(null), null);
  assert.equal(eventStartHour("all day"), null);
});

test("a key spanning several times tells the model to name no time of day", () => {
  assert.equal(timeLabelForOccurrences([{ time: "7:00 PM" }, { time: "7:00 PM" }]), "7:00 PM");
  assert.match(timeLabelForOccurrences([{ time: "12:00 PM" }, { time: "7:00 PM" }]), /do not name a time of day/);
  assert.equal(timeLabelForOccurrences([{ time: "" }]), null);
  assert.equal(timeLabelForOccurrences([]), null);
});

test("the cache sweep drops contradicted entries and keeps the rest", () => {
  const cache = {
    byKey: {
      [eventBlurbCacheKey(WOODLAND)]: { blurb: "Sit for a meditation, then ask questions on Monday mornings." },
      [eventBlurbCacheKey(LOS_ALTOS)]: { blurb: "Practice a guided meditation on Monday mornings." },
      "fp:not in this run|somewhere|d:": { blurb: "Kept — nothing here proves it wrong." },
    },
  };

  assert.equal(sweepTimeOfDayConflicts(cache, [WOODLAND, LOS_ALTOS]), 1);
  assert.equal(cache.byKey[eventBlurbCacheKey(WOODLAND)], undefined);
  assert.equal(cache.byKey[eventBlurbCacheKey(LOS_ALTOS)].blurb, "Practice a guided meditation on Monday mornings.");
  assert.equal(cache.byKey["fp:not in this run|somewhere|d:"].blurb, "Kept — nothing here proves it wrong.");
});

// ── Guard on the committed data ────────────────────────────────────────────
//
// The unit tests above only prove the detector works. This one is what would
// actually have caught the 2026-08-10 issue: it reads the materialized blurbs
// that the newsletter and the Events tab render and fails if any of them
// asserts a time of day its own event contradicts.

test("no committed event blurb contradicts its own time", () => {
  const path = join(REPO_ROOT, "src", "data", "south-bay", "upcoming-events.json");
  const events = JSON.parse(readFileSync(path, "utf8")).events || [];

  // Group by cache key: one blurb serves every occurrence sharing it, so it
  // has to be true of all their start times.
  const byKey = new Map();
  for (const e of events) {
    const k = eventBlurbCacheKey(e);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }

  const offenders = [];
  for (const group of byKey.values()) {
    for (const e of group) {
      if (!e.blurb) continue;
      const conflict = blurbTimeOfDayConflict(e.blurb, group);
      if (conflict) {
        offenders.push(`${e.title} (${e.venue}, ${e.time}) says "${conflict}": ${e.blurb}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `blurbs contradict their event time:\n${offenders.join("\n")}`);
});

test("no cached blurb contradicts the events it is keyed to", () => {
  const cache = JSON.parse(
    readFileSync(join(REPO_ROOT, "src", "data", "south-bay", "event-blurb-cache.json"), "utf8"),
  );
  const events = JSON.parse(
    readFileSync(join(REPO_ROOT, "src", "data", "south-bay", "upcoming-events.json"), "utf8"),
  ).events || [];

  const probe = { byKey: { ...cache.byKey } };
  const dropped = sweepTimeOfDayConflicts(probe, events);
  assert.equal(dropped, 0, "event-blurb-cache.json holds blurbs contradicting their events' times");
});

// --- Truncated-description invention (2026-08-17 "bring your own mat") --------

test("detects descriptions the upstream scraper cut mid-sentence", () => {
  assert.equal(isTruncatedDescription("No registration required. Bring your own\u2026"), true);
  assert.equal(isTruncatedDescription("Bring your own..."), true);
  assert.equal(isTruncatedDescription("Mats are provided."), false);
  assert.equal(isTruncatedDescription(""), false);
  assert.equal(isTruncatedDescription(null), false);
});

test("drops a blurb that inverts a truncated bring-your-own instruction", () => {
  const event = {
    title: "Gentle Yoga / Yoga Relajante",
    venue: "Hillview Library",
    description:
      "Discover a soothing practice designed for all bodies and all levels. Gentle Yoga invites you to relax, restore, and feel better from the inside out. Free. No registration required. Bring your own\u2026",
  };

  // The blurb that actually shipped in the 2026-08-17 newsletter.
  assert.equal(
    blurbInventsTruncatedDetail(
      "Stretch through a slow-paced practice with poses adapted for every body, mat included from home.",
      event,
    ),
    "contradicts bring-your-own",
  );

  // The correction reads the truncation the right way round.
  assert.equal(
    blurbInventsTruncatedDetail(
      "Stretch through a slow-paced practice with poses adapted for every body; bring your own mat.",
      event,
    ),
    null,
  );
});

test("drops a provision claim invented past the cut", () => {
  const event = {
    title: "Kids Craft Hour",
    venue: "Saratoga Library",
    description: "Join us for an afternoon of open-ended crafting for all ages. Space is\u2026",
  };
  assert.equal(
    blurbInventsTruncatedDetail("Craft freely with all materials provided at this drop-in hour.", event),
    "unsupported provision claim",
  );
});

test("leaves provision claims alone when the description supports them", () => {
  // Truncated, but the visible half already says supplies are provided.
  const supported = {
    title: "Craftapalooza",
    venue: "Saratoga Library",
    description: "A wide variety of materials will be supplied in this free form activity where you can\u2026",
  };
  assert.equal(
    blurbInventsTruncatedDetail("Kids craft freely with supplies provided in an open-ended session.", supported),
    null,
  );

  // A complete description is authoritative — the guard must not second-guess it.
  const complete = {
    title: "Sewing Studio",
    venue: "Mitchell Park Library",
    description: "Machines and thread are provided; drop in any time.",
  };
  assert.equal(
    blurbInventsTruncatedDetail("Sew a project with machines and thread provided.", complete),
    null,
  );
});

test("does not flag content enumeration as a logistics claim", () => {
  // "including" enumerates songs, not supplies — flagging it would kill correct
  // concert blurbs.
  const event = {
    title: "Jorge Medina",
    venue: "San Jose Civic",
    description: 'Jorge Medina presents his solo album, featuring songs like "Lo M\u00e1s Seguro" and "Espero Que\u2026',
  };
  assert.equal(
    blurbInventsTruncatedDetail(
      "Hear Jorge Medina play songs from his solo catalog, including 'Lo M\u00e1s Seguro'.",
      event,
    ),
    null,
  );
});

test("no shipped blurb invents detail past a truncated description", () => {
  const events = JSON.parse(
    readFileSync(join(REPO_ROOT, "src", "data", "south-bay", "upcoming-events.json"), "utf8"),
  ).events || [];

  const offenders = [];
  for (const e of events) {
    if (!e.blurb) continue;
    const reason = blurbInventsTruncatedDetail(e.blurb, e);
    if (reason) offenders.push(`${e.title} (${e.venue}) ${reason}: ${e.blurb}`);
  }

  assert.deepEqual(offenders, [], `blurbs invent detail past a truncated description:\n${offenders.join("\n")}`);
});

// ── Series-position claims (2026-08-26 "wrap up their series") ──────────────
//
// The 2026-08-26 issue told readers to "Cheer for the San Jose Giants as they
// wrap up their series against the Visalia Rawhide at Excite Ballpark." Aug 26
// was game 2 of a six-game series (Aug 25–30, verified against milb.com); the
// finale was Aug 30. All six games share a byte-identical title, venue and
// description, so one cache entry served all six — the copy was wrong on five
// of them, and it drove the issue's field-guide intro line too.
//
// Nothing in the model's input stated series position. Note that the cache key
// is NOT the defect: splitting these six onto six keys would fragment every
// legitimately-identical recurring listing into separate model calls for
// identical text.

const GIANTS_RUN = ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30"]
  .map((date) => ({
    title: "San Jose Giants vs. Visalia Rawhide",
    venue: "Excite Ballpark",
    date,
    description: "San Jose Giants home game vs. Visalia Rawhide at Excite Ballpark.",
  }));

test("the shipped series-position defect is caught", () => {
  assert.equal(
    blurbSequencePositionConflict(
      "Cheer for the San Jose Giants as they wrap up their series against the Visalia Rawhide at Excite Ballpark.",
      GIANTS_RUN,
    ),
    "wrap up their series",
  );
});

test("the corrected Giants copy passes", () => {
  assert.equal(
    blurbSequencePositionConflict(
      "Cheer on the San Jose Giants against the Visalia Rawhide at Excite Ballpark.",
      GIANTS_RUN,
    ),
    null,
  );
});

test("the shapes the same invention takes are all caught", () => {
  const claims = {
    "Watch the Giants play their final game of the series at Excite Ballpark.": "final game",
    "Catch the last game of the Giants' homestand downtown.": "last game",
    "See the Giants in the series finale against Visalia.": "series finale",
    "Watch the opening game of the Giants series at Excite Ballpark.": "opening game",
    "Cheer the Giants in their first game against the Rawhide.": "first game",
    "Watch the Giants close out the series under the lights.": "close out the series",
    "See the Giants in their final home game of the season.": "final home game",
    "Catch game 2 of 6 as the Giants host Visalia.": "game 2 of 6",
  };
  for (const [blurb, expected] of Object.entries(claims)) {
    assert.equal(blurbSequencePositionConflict(blurb, GIANTS_RUN), expected, blurb);
  }
});

test("a single-date event can legitimately be a finale", () => {
  // Only the prompt rules keep the model from inventing one here — with one
  // date there is nothing to disprove, and flagging it would burn good copy.
  assert.equal(
    blurbSequencePositionConflict(
      "Cheer for the San Jose Giants as they wrap up their series against the Visalia Rawhide.",
      [GIANTS_RUN[0]],
    ),
    null,
  );
});

test("a position the source itself states is quoted, not guessed", () => {
  const twice = (extra) => [{ date: "2026-06-06", ...extra }, { date: "2026-06-07", ...extra }];

  assert.equal(
    blurbSequencePositionConflict(
      "Enjoy the San Jose Youth Symphony's final concert of the season with student performers.",
      twice({ title: "SJYS Philharmonic Orchestra Season Finale Concert", venue: "California Theatre" }),
    ),
    null,
    "'Season Finale' in the title supports 'final concert of the season'",
  );

  assert.equal(
    blurbSequencePositionConflict(
      "Watch Stanford field hockey open its season against UMass Lowell with free admission at Varsity Turf.",
      twice({
        title: "Stanford Field Hockey vs. UMass Lowell (Season Opener)",
        venue: "Varsity Turf",
        description: "Stanford field hockey opens its 2026 season against UMass Lowell.",
      }),
    ),
    null,
    "the description says it opens the season",
  );
});

test("positional-sounding copy that isn't a position claim survives", () => {
  const twice = (extra) => [{ date: "2026-09-30", ...extra }, { date: "2026-10-05", ...extra }];

  // A support act opens the show; it does not make this date the run's opener.
  assert.equal(
    blurbSequencePositionConflict(
      "Hear The Who's Roger Daltrey perform live with Amy Helm opening the show.",
      twice({ title: "Roger Daltrey with Amy Helm", venue: "The Mountain Winery" }),
    ),
    null,
  );
  // "one final show" is the musical's plot, and no run is named.
  assert.equal(
    blurbSequencePositionConflict(
      "Experience Sondheim's epic musical about aging Broadway performers reuniting for one final show.",
      twice({ title: "Follies 2026", venue: "Los Altos Stage Company" }),
    ),
    null,
  );
  // "the season" as a period to stock up for, not a run this date closes.
  assert.equal(
    blurbSequencePositionConflict(
      "Browse tables of discounted books and stock up on reads for the season.",
      twice({ title: "Friends of the Library Book Sale", venue: "Mountain View Public Library" }),
    ),
    null,
  );
  // "the last ten" minutes of a meditation session.
  assert.equal(
    blurbSequencePositionConflict(
      "Sit for a guided 20-minute meditation with instructor Manisha, then ask questions for the last ten.",
      twice({ title: "Monday Meditation & Mindfulness", venue: "Woodland Library" }),
    ),
    null,
  );
});

test("a run tells the model how many dates the copy has to hold for", () => {
  const label = runLabelForOccurrences(GIANTS_RUN);
  assert.match(label, /all 6 dates/);
  assert.match(label, /Aug 25–Aug 30/);
  assert.equal(runLabelForOccurrences([GIANTS_RUN[0]]), null, "one date needs no run context");
  assert.equal(runLabelForOccurrences([]), null);
});

test("the series-position sweep drops contradicted entries and keeps the rest", () => {
  const key = eventBlurbCacheKey(GIANTS_RUN[0]);
  const cache = {
    byKey: {
      [key]: { blurb: "Cheer for the San Jose Giants as they wrap up their series against the Visalia Rawhide." },
      "fp:not in this run|somewhere|d:": { blurb: "Watch the final game of the series." },
    },
  };

  assert.equal(sweepSequencePositionClaims(cache, GIANTS_RUN), 1);
  assert.equal(cache.byKey[key], undefined);
  assert.equal(
    cache.byKey["fp:not in this run|somewhere|d:"].blurb,
    "Watch the final game of the series.",
    "an entry with no live event is not an entry we've shown to be wrong",
  );
});

// ── Guard on the committed data ────────────────────────────────────────────
//
// The unit tests prove the detector works. These are what would have caught
// the 2026-08-26 issue: they read the blurbs the newsletter and Events tab
// actually render.

test("no committed event blurb claims a position its own run disproves", () => {
  const events = JSON.parse(
    readFileSync(join(REPO_ROOT, "src", "data", "south-bay", "upcoming-events.json"), "utf8"),
  ).events || [];

  const byKey = new Map();
  for (const e of events) {
    const k = eventBlurbCacheKey(e);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }

  const offenders = [];
  for (const group of byKey.values()) {
    for (const e of group) {
      if (!e.blurb) continue;
      const claim = blurbSequencePositionConflict(e.blurb, group);
      if (claim) offenders.push(`${e.title} (${e.venue}) says "${claim}": ${e.blurb}`);
    }
  }

  assert.deepEqual(offenders, [], `blurbs claim a series position:\n${offenders.join("\n")}`);
});

test("no cached blurb claims a position the events it is keyed to disprove", () => {
  const cache = JSON.parse(
    readFileSync(join(REPO_ROOT, "src", "data", "south-bay", "event-blurb-cache.json"), "utf8"),
  );
  const events = JSON.parse(
    readFileSync(join(REPO_ROOT, "src", "data", "south-bay", "upcoming-events.json"), "utf8"),
  ).events || [];

  const probe = { byKey: { ...cache.byKey } };
  assert.equal(
    sweepSequencePositionClaims(probe, events),
    0,
    "event-blurb-cache.json holds blurbs claiming a position across several dates",
  );
});

// ── Day-of-week agreement (2026-08-26) ─────────────────────────────────────
//
// Found alongside the series-position bug and the same shape: buildUserPrompt
// stated `day:` from the one event it was iterating, but the blurb it produced
// is served on every date sharing that key. A Wed/Thu pair at Tully Library
// shipped "every Thursday" and a Sat/Sun Barracuda pair shipped "Sunday
// afternoon" — each wrong on one of its two dates.

const TULLY = ["2026-08-26", "2026-08-27"].map((date) => ({
  title: "Peer Support for MyConnectSV",
  venue: "Tully Library",
  date,
  time: "10:00 AM",
  description: "Meet with peer support workers who can help you log in and use My Connect SV.",
}));

test("the shipped day-of-week defects are caught", () => {
  assert.equal(
    blurbDayOfWeekConflict(
      "Get hands-on help logging into MyConnectSV from peer support workers at Tully Library every Thursday.",
      TULLY,
    ),
    "thursday",
  );
  assert.equal(
    blurbDayOfWeekConflict(
      "Watch the San Jose Barracuda face the San Diego Gulls again at Tech CU Arena Sunday afternoon.",
      ["2026-10-03", "2026-10-04"].map((date) => ({
        title: "San Jose Barracuda vs. San Diego Gulls", venue: "Tech CU Arena", date, time: "3:00 PM",
      })),
    ),
    "sunday",
  );
});

test("the corrected copy passes", () => {
  assert.equal(
    blurbDayOfWeekConflict(
      "Get hands-on help logging into MyConnectSV from peer support workers at Tully Library.",
      TULLY,
    ),
    null,
  );
});

test("a weekly series still gets to name its day", () => {
  const everyTuesday = ["2026-09-01", "2026-09-08", "2026-09-15"].map((date) => ({
    title: "Toddler Storytime", venue: "Rinconada Library", date,
  }));
  assert.equal(
    blurbDayOfWeekConflict("Sing and clap through rhymes with toddlers on Tuesday mornings.", everyTuesday),
    null,
  );
  assert.equal(dayLabelForOccurrences(everyTuesday), "Tuesday");
  assert.match(dayLabelForOccurrences(TULLY), /do not name a day of the week/);
  assert.equal(dayLabelForOccurrences([]), null);
});

test("weekday and weekend read as the sets they are", () => {
  // Wednesday and Thursday are both weekdays, so "weekday afternoons" holds.
  assert.equal(
    blurbDayOfWeekConflict(
      "Reserve Group Study Room C on weekday afternoons for quiet adult work sessions at Berryessa Library.",
      [{ title: "Adult Work Space", venue: "Berryessa Library", date: "2026-08-26" },
       { title: "Adult Work Space", venue: "Berryessa Library", date: "2026-08-27" }],
    ),
    null,
  );
  const satSun = [{ title: "Market", venue: "Plaza", date: "2026-10-03" },
                  { title: "Market", venue: "Plaza", date: "2026-10-04" }];
  assert.equal(blurbDayOfWeekConflict("Shop produce over the weekend.", satSun), null);
  assert.equal(blurbDayOfWeekConflict("Shop produce on a weekday.", satSun), "weekday");
});

test("a day in the event's own name is quoted, not claimed", () => {
  // The 7:00 PM Woodland series is named for its day; both its dates are
  // Mondays anyway, but the suppression is what keeps title-derived copy safe.
  const mondayMeditation = ["2026-08-26", "2026-08-27"].map((date) => ({
    title: "Monday Meditation & Mindfulness", venue: "Woodland Library", date,
  }));
  assert.equal(
    blurbDayOfWeekConflict("Sit for a guided meditation with instructor Manisha on Monday evenings.", mondayMeditation),
    null,
  );
});

test("the day-of-week sweep drops contradicted entries and keeps the rest", () => {
  const key = eventBlurbCacheKey(TULLY[0]);
  const cache = {
    byKey: {
      [key]: { blurb: "Get hands-on help logging into MyConnectSV at Tully Library every Thursday." },
      "fp:not in this run|somewhere|d:": { blurb: "Drop in every Thursday." },
    },
  };
  assert.equal(sweepDayOfWeekConflicts(cache, TULLY), 1);
  assert.equal(cache.byKey[key], undefined);
  assert.equal(cache.byKey["fp:not in this run|somewhere|d:"].blurb, "Drop in every Thursday.");
});

test("no committed event blurb names a day its own run contradicts", () => {
  const events = JSON.parse(
    readFileSync(join(REPO_ROOT, "src", "data", "south-bay", "upcoming-events.json"), "utf8"),
  ).events || [];

  const byKey = new Map();
  for (const e of events) {
    const k = eventBlurbCacheKey(e);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }

  const offenders = [];
  for (const group of byKey.values()) {
    for (const e of group) {
      if (!e.blurb) continue;
      const conflict = blurbDayOfWeekConflict(e.blurb, group);
      if (conflict) offenders.push(`${e.title} (${e.venue}) says "${conflict}": ${e.blurb}`);
    }
  }

  assert.deepEqual(offenders, [], `blurbs name a contradicted weekday:\n${offenders.join("\n")}`);
});

test("no cached blurb names a day the events it is keyed to contradict", () => {
  const cache = JSON.parse(
    readFileSync(join(REPO_ROOT, "src", "data", "south-bay", "event-blurb-cache.json"), "utf8"),
  );
  const events = JSON.parse(
    readFileSync(join(REPO_ROOT, "src", "data", "south-bay", "upcoming-events.json"), "utf8"),
  ).events || [];

  const probe = { byKey: { ...cache.byKey } };
  assert.equal(
    sweepDayOfWeekConflicts(probe, events),
    0,
    "event-blurb-cache.json holds blurbs naming a weekday their events contradict",
  );
});
