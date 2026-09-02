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
