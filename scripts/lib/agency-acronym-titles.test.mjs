import test from "node:test";
import assert from "node:assert/strict";

import { cleanTitle, polishDescription } from "../generate-events.mjs";

// ---------------------------------------------------------------------------
// Local agency acronyms in event titles
// ---------------------------------------------------------------------------
// cleanTitle downcases ALL-CAPS runs so shouted source titles don't scream on a
// card. Anything not in its KEEP_UPPER allowlist gets title-cased, which is
// wrong for the initialisms South Bay agencies actually publish under. The Town
// of Los Gatos newsletter ships "LGMSPD Community Police Academy" (Los
// Gatos-Monte Sereno Police Department) and it published as "Lgmspd Community
// Police Academy" until LGMSPD was added to the list.

test("keeps South Bay public-safety agency acronyms uppercase in titles", () => {
  assert.equal(
    cleanTitle("LGMSPD Community Police Academy"),
    "LGMSPD Community Police Academy",
  );
  // The rest of the local public-safety family, so a KEEP_UPPER edit that drops
  // one of them fails here rather than on a live card.
  assert.equal(cleanTitle("SJPD Open House"), "SJPD Open House");
  assert.equal(cleanTitle("SJFD Station Tour"), "SJFD Station Tour");
  assert.equal(cleanTitle("SCCFD Pancake Breakfast"), "SCCFD Pancake Breakfast");
  assert.equal(cleanTitle("LGPNS Big Truck Day"), "LGPNS Big Truck Day");
});

test("still downcases shouted words that are not known acronyms", () => {
  // The guard on the rule above: preserving LGMSPD must not amount to keeping
  // every all-caps run, which is the whole point of the downcasing pass.
  assert.equal(
    cleanTitle("AWESOME Community Police Academy"),
    "Awesome Community Police Academy",
  );
  assert.equal(cleanTitle("ANNUAL Pancake Breakfast"), "Annual Pancake Breakfast");
});

test("keeps agency acronyms uppercase in body copy too", () => {
  assert.match(
    polishDescription("The LGMSPD hosts an eight-week academy each fall."),
    /\bLGMSPD\b/,
  );
});

// ---------------------------------------------------------------------------
// Institution and clinical acronyms (added 2026-09-06)
// ---------------------------------------------------------------------------
// All five shipped downcased in upcoming-events.json, where a title-cased
// initialism reads as a misspelled proper noun: JMZ is Palo Alto's Junior
// Museum & Zoo, UNAFF the United Nations Association Film Festival whose
// screenings Rinconada Library hosts, and MRI/PD/MD come off Stanford
// Medicine's Localist feed.

test("keeps institution acronyms uppercase in titles", () => {
  assert.equal(
    cleanTitle("Family Storytime: Meet a JMZ Animal Ambassador!"),
    "Family Storytime: Meet a JMZ Animal Ambassador!",
  );
  assert.equal(
    cleanTitle("Documentary: UNAFF presents Lessons in Fear"),
    "Documentary: UNAFF presents Lessons in Fear",
  );
});

test("keeps clinical and post-nominal acronyms uppercase in titles", () => {
  assert.equal(
    cleanTitle("MRI: Clinical Updates and Practical Physics"),
    "MRI: Clinical Updates and Practical Physics",
  );
  assert.equal(
    cleanTitle("PD Bootcamp | How to Give a Great Presentation"),
    "PD Bootcamp | How to Give a Great Presentation",
  );
  assert.equal(
    cleanTitle("Fireside Chat with Tara Narula Cangello, MD"),
    "Fireside Chat with Tara Narula Cangello, MD",
  );
});

test("keeps UNAFF uppercase in description body copy", () => {
  assert.match(
    polishDescription("Introduced by UNAFF founder Jasmina Bojic at the library."),
    /\bUNAFF\b/,
  );
});

// ---------------------------------------------------------------------------
// cleanTitle is order-sensitive, so the pipeline runs it again after the
// venue-suffix strip (generate-events.mjs). Its end-anchored rules only see
// what is last in the string, so a CMS bookkeeping marker parked behind the
// venue tail survived the first pass: "Levitt San Jose concert series (Copy)
// at <Venue>" cleaned to "… concert series (Copy)" and shipped that way for
// three days. Guard the idempotence the second pass depends on.
// ---------------------------------------------------------------------------

test("cleanTitle is idempotent, so a second pass is safe and strips exposed markers", () => {
  assert.equal(
    cleanTitle("Levitt San Jose concert series (Copy)"),
    "Levitt San Jose concert series",
  );
  for (const title of [
    "Levitt San Jose concert series",
    "MRI: Clinical Updates and Practical Physics",
    "LGMSPD Community Police Academy",
    "Documentary: UNAFF presents Lessons in Fear",
  ]) {
    assert.equal(cleanTitle(cleanTitle(title)), cleanTitle(title), title);
  }
});
