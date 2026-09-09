import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyVerifiedEventFacts,
  copyMentionsEvent,
  eventCopyFactConflict,
  rotationActivityForOccurrence,
} from "./eventSourceFacts.mjs";
import { eventBlurbCacheKey, resolveEventBlurbs } from "./eventBlurbs.mjs";
import { requiresAdvanceRegistration } from "./eventFilters.mjs";

const lost = { id: "tm-Z7r9jZ1A7x78x", date: "2026-09-05", title: "Lost 80s Live", venue: "Mountain Winery", description: "", blurb: "Sing along to a lineup of 80s cover bands." };
const duelo = { id: "sanjosetheaters-eb92ddeb3f824327", date: "2026-09-05", title: "Grupo Duelo – Gravedad Tour 2026", venue: "San Jose Civic" };

test("September 6 library facts survive a sparse refresh and blurb resolution", async () => {
  const events = [
    { id: "sjpl-6a7bc1324cb69d003e203e28", title: "STEM: Balloon Car Derby", venue: "Berryessa Library", date: "2026-09-06", audienceAge: "all", kidFriendly: false },
    { id: "cbdd438d7fbe", title: "Narcan Training at the Library", venue: "Los Gatos Library", date: "2026-09-06", audienceAge: "all" },
  ];
  await resolveEventBlurbs(events, { enabled: false });
  assert.equal(events[0].audienceAge, "kids");
  assert.equal(events[0].kidFriendly, true);
  assert.equal(events[0].time, "2:00 PM");
  assert.match(events[0].attendanceNote, /12 first-come.*confirm pickup timing/);
  assert.equal(events[0].attendanceStatus, "needs-confirmation");
  assert.equal(events[1].audienceAge, "adult");
  for (const event of events) {
    const next = { id: "different", title: event.title, venue: event.venue, date: "2026-09-13" };
    assert.equal(applyVerifiedEventFacts(next), next, "the hold and exact attendance note cannot leak to later occurrences");
  }
});

test("source corrections survive fresh sparse ingest without leaking into other occurrences", async () => {
  const events = [{ ...lost }, { ...duelo }];
  await resolveEventBlurbs(events, { enabled: false });
  assert.match(events[0].description, /original vocalists or members/);
  assert.match(events[0].url, /^https:\/\/lost80slive.com\/event\/mwc09052026\//);
  assert.equal(events[0].time, "6:00 PM");
  assert.doesNotMatch(events[0].blurb, /cover bands/);
  assert.match(events[1].blurb, /norteño/);
  const nextYear = { ...lost, date: "2027-09-05" };
  assert.equal(applyVerifiedEventFacts(nextYear), nextYear);
  const unrelated = { id: "other", date: lost.date, title: "Other concert", venue: lost.venue };
  assert.equal(applyVerifiedEventFacts(unrelated), unrelated);
});

test("missing descriptions never support invented band identity; sourced tribute shows remain valid", () => {
  assert.ok(eventCopyFactConflict(lost.blurb, lost));
  assert.ok(eventCopyFactConflict("Hear the original members perform.", lost));
  assert.equal(eventCopyFactConflict("Hear Lost 80s Live at Mountain Winery.", lost), null);
  assert.equal(eventCopyFactConflict("Hear a tribute band.", { title: "ABBA tribute", description: "" }), null);
  assert.ok(eventCopyFactConflict("Hear Grupo Duelo play banda hits.", applyVerifiedEventFacts(duelo)));
  assert.equal(eventCopyFactConflict("Hear Banda MS.", { title: "Banda MS" }), null);
});

test("corrected feed/cache copies agree and Town Cats keeps in-person ticket pickup ungated", () => {
  const feed = JSON.parse(readFileSync(new URL("../../data/south-bay/upcoming-events.json", import.meta.url)));
  const cache = JSON.parse(readFileSync(new URL("../../data/south-bay/event-blurb-cache.json", import.meta.url)));
  for (const id of [lost.id, duelo.id, "sjpl-6a5280ebe564853d00fd6ea4", "sjpl-6a7bc1324cb69d003e203e28", "cbdd438d7fbe"]) {
    const event = feed.events.find((e) => e.id === id);
    if (!event) continue; // The occurrence legitimately ages out of the live feed.
    assert.equal(event.blurb, applyVerifiedEventFacts(event).blurb);
    assert.equal(cache.byKey[eventBlurbCacheKey(event)]?.blurb, event.blurb);
    assert.equal(eventCopyFactConflict(event.blurb, event), null);
    if (id === "sjpl-6a5280ebe564853d00fd6ea4") {
      assert.equal(requiresAdvanceRegistration(event), false);
      assert.match(event.blurb, /Information Desk.*1 PM/);
    }
  }
  assert.doesNotMatch(cache.byKey["fp:lost 80s live|mountain winery|d:"]?.blurb || "", /cover bands/i);
  assert.doesNotMatch(cache.byKey["fp:grupo duelo – gravedad tour 2026|san jose civic|d:af517bd503d6"]?.blurb || "", /banda/i);
});

test("every LibCal appointment occurrence is gated, not just the corrected one", () => {
  // The Sept 8 defect was systemic: only `d610aa488850` got a hand correction,
  // while its seven sibling occurrences — same service, same appointment-only
  // page — stayed walk-ups because nothing on the LibCal ingest path set
  // `registration`. registrationFromLibCal now derives it for all of them, so
  // the correction is a floor and the feed is the mechanism.
  const feed = JSON.parse(readFileSync(new URL("../../data/south-bay/upcoming-events.json", import.meta.url)));
  const byId = new Map(feed.events.map((e) => [e.id, e]));

  const scanning = [
    "d610aa488850", "beafbf0a38b7", "b7c1ea7f055a", "22a65f59e0b7",
    "a0b6ae3454e6", "dbf05ae12f85", "c5f16f14946d", "f61d141f208b",
  ];
  let checked = 0;
  for (const id of scanning) {
    const event = byId.get(id);
    if (!event) continue; // The occurrence legitimately ages out of the live feed.
    checked++;
    assert.equal(event.registration, "appointment-only", id);
    assert.equal(requiresAdvanceRegistration(event), true, id);
  }
  assert.ok(checked > 0, "no Community Preservation Lab occurrence is in the feed at all");

  // Mountain View's "Landscape Design for Beginners" opens "Registration is
  // required. Seats and materials are limited." — a seat, not a slot.
  const landscape = byId.get("ecadbadee33e");
  if (landscape) assert.equal(landscape.registration, "required");

  // And the guard did not swing the other way. Every LibCal event whose own
  // copy promises walk-up access must stay ungated, or a false positive
  // silently removes a good event from the plan.
  const libcalWalkUps = feed.events.filter(
    (e) => /libcal\.com/.test(e.url || "") && /\bno registration required\b|\bfirst come\b/i.test(e.description || ""),
  );
  for (const event of libcalWalkUps) {
    assert.equal(requiresAdvanceRegistration(event), false, `${event.id} ${event.title}`);
  }
});

// ---------------------------------------------------------------------------
// 2026-09-09 issue. The "Also on the calendar" intro referred to the Seven
// Trees playdate by venue and head noun rather than by its registration title
// ("Playdates for Children and Their Caregivers"), so no title path matched
// and repairNewsletterEventFacts' unsupported() closure skipped the event
// entirely — with it, every guard that hangs off copyMentionsEvent.
//
// The sentence itself was CORRECT and must survive: SJPL publishes the whole
// rotation on every occurrence ("2nd Wednesday: Superhero Obstacle Course
// (ages 3-8)"), September 2026's Wednesdays are 2/9/16/23/30, and Sept 9 is
// the 2nd. A guard that blanks a true sentence is the more expensive bug.
// ---------------------------------------------------------------------------
const playdate = {
  id: "sjpl-6a347d087550c8bf9f5e649a",
  date: "2026-09-09",
  title: "Playdates for Children and Their Caregivers",
  venue: "Seven Trees Library",
  sourceAudiences: ["Young Children, ages 0-5"],
  description: "Join us every Wednesday for weekly playdates. Kids get to practice early social skills like sharing, taking turns, imitation of play, and joint attention while caregivers get a chance to connect. 1st Wednesday: Cars 2nd Wednesday: Superhero Obstacle Course (ages 3-8) 3rd Wednesday: LEGO Duplo Blocks 4th Wednesday: Cars 5th Wednesday: LEGO Duplo Blocks Recommended for children ages 2 – 6 years old.",
};
const SHIPPED_INTRO = "Only the Palo Alto opera preview asks for advance registration; the downtown market and the Seven Trees playdate run every Wednesday, and this week's playdate is the superhero obstacle course for ages 3 to 8.";

test("a venue-plus-head-noun reference binds to the event the title match misses", () => {
  assert.equal(copyMentionsEvent(SHIPPED_INTRO, playdate), true);
  assert.equal(copyMentionsEvent("Bring the kids to the Seven Trees playdates.", playdate), true);
  // Both halves are required. A venue alone sweeps in every event at that
  // address; a head noun alone sweeps in every playdate in the county.
  assert.equal(copyMentionsEvent("Seven Trees Library also runs a bilingual storytime.", playdate), false);
  assert.equal(copyMentionsEvent("There is a playdate at Berryessa Library.", playdate), false);
  assert.equal(copyMentionsEvent("The downtown farmers market runs every Wednesday.", playdate), false);
});

test("the shipped Sept 9 intro is source-grounded and must not be blanked", () => {
  assert.equal(rotationActivityForOccurrence(playdate), "Superhero Obstacle Course");
  assert.equal(eventCopyFactConflict(SHIPPED_INTRO, playdate), null);
  // The age gate is the rotation entry's own parenthetical, wider than the
  // BiblioCommons audience tag; quoting it is not an invention.
  assert.equal(eventCopyFactConflict("This week's playdate is the superhero obstacle course for ages 3 to 8.", playdate), null);
  assert.equal(eventCopyFactConflict("Head to the Seven Trees playdate for the Superhero Obstacle Course.", playdate), null);
  // Listing the whole published rotation is not a wrong-week claim either.
  assert.equal(eventCopyFactConflict("The Seven Trees playdate rotates: Cars, Superhero Obstacle Course, LEGO Duplo Blocks.", playdate), null);
});

test("an invented age range is caught; a sourced one is not", () => {
  assert.ok(eventCopyFactConflict(SHIPPED_INTRO.replace("ages 3 to 8", "ages 9 to 14"), playdate));
  assert.ok(eventCopyFactConflict("This week's playdate is the superhero obstacle course for ages 3 and up.", playdate));
  // Sourced spans, in any of the shapes SJPL publishes them.
  assert.equal(eventCopyFactConflict("A playdate at Seven Trees for ages 0-5.", playdate), null);
  assert.equal(eventCopyFactConflict("A playdate at Seven Trees for ages 2 – 6.", playdate), null);
  // No age data anywhere in the source is not permission to assert one.
  const bare = { title: "Open Play", venue: "Rose Garden Library", description: "Drop by and play." };
  assert.ok(eventCopyFactConflict("Open Play at the Rose Garden is for ages 3 to 8.", bare));
});

test("naming another session's rotation activity is caught in both schedule shapes", () => {
  // Ordinal-weekday shape: LEGO Duplo Blocks is the 3rd and 5th Wednesday.
  assert.ok(eventCopyFactConflict("The Seven Trees playdate runs every Wednesday; this week it is LEGO Duplo Blocks.", playdate));
  assert.ok(eventCopyFactConflict("Head to the Seven Trees playdate for LEGO Duplo Blocks.", playdate));
  assert.ok(eventCopyFactConflict(SHIPPED_INTRO.replace("the superhero obstacle course for ages 3 to 8", "a puppet parade"), playdate));

  // Calendar-date shape. This is the Craft Tuesdays & Thursdays failure the
  // CORRECTIONS table carries by hand: washi tape bookmarks were Sept 8, bug
  // headbands Sept 10. The guard now derives that from the source, so the
  // wrong-week class no longer needs a hand-entry per occurrence.
  const craft = {
    id: "sjpl-6a945a62be148200298b2cfc",
    date: "2026-09-10",
    title: "Craft Tuesdays & Thursdays",
    venue: "Educational Park Library",
    description: "Join us for a limited series of crafts on Tuesdays and Thursdays! Tuesday, September 1: Cactus characters Thursday, September 3: beaded insects Tuesday September 8: Washi tape bookmarks Thursday, September 10: Bug headbands Tuesday, September 15: Decorated masks Thursday, September 17: Acorn craft Free. Supplies are limited, first come, first serve.",
  };
  assert.equal(rotationActivityForOccurrence(craft), "Bug headbands");
  assert.equal(eventCopyFactConflict("Make bug headbands at this week's drop-in craft session; supplies are limited.", craft), null);
  assert.ok(eventCopyFactConflict("Make washi tape bookmarks at this week's drop-in craft session.", craft));
  assert.ok(eventCopyFactConflict("This week's craft is decorated masks.", craft));

  // A rotation keyed to a weekday the occurrence is not on is not guessed at.
  assert.equal(rotationActivityForOccurrence({ ...playdate, date: "2026-09-10" }), "");
});

test("editorial voice is not mistaken for a session-activity claim", () => {
  // "this week's <subject> is …" only asserts a fact when the subject is the
  // event's own head noun. Otherwise it is the editor talking.
  assert.equal(eventCopyFactConflict("This week's plan is a quiet one near Seven Trees playdates.", playdate), null);
  assert.equal(eventCopyFactConflict("This week's highlight is a trip to the coast.", playdate), null);
});

test("no blurb in the live feed trips the new guards", () => {
  // A false positive blanks legitimate copy, so the whole feed is the fixture.
  const feed = JSON.parse(readFileSync(new URL("../../data/south-bay/upcoming-events.json", import.meta.url)));
  const flagged = feed.events
    .filter((event) => event.blurb && eventCopyFactConflict(event.blurb, event))
    .map((event) => `${event.id} ${event.title}: ${eventCopyFactConflict(event.blurb, event)}`);
  assert.deepEqual(flagged, []);
});
