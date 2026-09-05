import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyVerifiedEventFacts, eventCopyFactConflict } from "./eventSourceFacts.mjs";
import { eventBlurbCacheKey, resolveEventBlurbs } from "./eventBlurbs.mjs";
import { requiresAdvanceRegistration } from "./eventFilters.mjs";

const lost = { id: "tm-Z7r9jZ1A7x78x", date: "2026-09-05", title: "Lost 80s Live", venue: "Mountain Winery", description: "", blurb: "Sing along to a lineup of 80s cover bands." };
const duelo = { id: "sanjosetheaters-eb92ddeb3f824327", date: "2026-09-05", title: "Grupo Duelo – Gravedad Tour 2026", venue: "San Jose Civic" };

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
  for (const id of [lost.id, duelo.id, "sjpl-6a5280ebe564853d00fd6ea4"]) {
    const event = feed.events.find((e) => e.id === id);
    if (!event) continue; // The occurrence legitimately ages out of the live feed.
    assert.equal(event.blurb, applyVerifiedEventFacts(event).blurb);
    assert.equal(cache.byKey[eventBlurbCacheKey(event)]?.blurb, event.blurb);
    assert.equal(eventCopyFactConflict(event.blurb, event), null);
    if (id.startsWith("sjpl-")) {
      assert.equal(requiresAdvanceRegistration(event), false);
      assert.match(event.blurb, /Information Desk.*1 PM/);
    }
  }
  assert.doesNotMatch(cache.byKey["fp:lost 80s live|mountain winery|d:"]?.blurb || "", /cover bands/i);
  assert.doesNotMatch(cache.byKey["fp:grupo duelo – gravedad tour 2026|san jose civic|d:af517bd503d6"]?.blurb || "", /banda/i);
});
