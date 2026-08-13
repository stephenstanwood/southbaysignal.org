import test from "node:test";
import assert from "node:assert/strict";
import {
  collectCanonicalNames,
  extractCanonicalNames,
  repairCanonicalNames,
} from "./canonicalNames.mjs";

// The real Aug 13 2026 source strings: inbound-events.json:338 and the blurb
// the deterministic event card rendered correctly from.
const SOURCE_TEXTS = [
  "Back 2 The Bay: SOB X RBE Live",
  "The Habbas Law Epicenter at PayPal Park, San Jose, CA",
  "Hip-hop group SOB X RBE returns to the stage with a new song, joined by P-Lo, 310Babii, and Mistah F.A.B. as part of the Epicenter Music Series.",
];

test("a dotted initialism picks up the capitalized word in front of it", () => {
  assert.deepEqual(collectCanonicalNames(SOURCE_TEXTS), ["Mistah F.A.B."]);
});

test("initials with periods but wedged-in spaces are restored", () => {
  const names = collectCanonicalNames(SOURCE_TEXTS);
  assert.equal(
    repairCanonicalNames("Two stadiums switch on at 6 tonight, and Mistah F. A. B. headlines.", names),
    "Two stadiums switch on at 6 tonight, and Mistah F.A.B. headlines.",
  );
  // Wider spacing, and the name closing a sentence, are the same defect.
  assert.equal(
    repairCanonicalNames("Free classes by day, hyphy by night with Mistah F . A . B .", names),
    "Free classes by day, hyphy by night with Mistah F.A.B.",
  );
});

test("initials with no periods at all are restored", () => {
  const names = collectCanonicalNames(SOURCE_TEXTS);
  assert.equal(
    repairCanonicalNames("Hear live hip-hop from P-Lo, Kamaiyah, Mistah FAB, and more.", names),
    "Hear live hip-hop from P-Lo, Kamaiyah, Mistah F.A.B., and more.",
  );
  // A bare form ending a sentence must not end up double-punctuated.
  assert.equal(
    repairCanonicalNames("The lineup runs through Mistah FAB.", names),
    "The lineup runs through Mistah F.A.B.",
  );
  // A dropped final period is the same class of defect.
  assert.equal(
    repairCanonicalNames("Mistah F.A.B and P-Lo share the bill.", names),
    "Mistah F.A.B. and P-Lo share the bill.",
  );
});

test("a genuine sentence boundary after an abbreviation survives untouched", () => {
  // The control: "P.M." must never be mistaken for a name, and the capital that
  // opens the next sentence must never be pulled into one.
  const names = collectCanonicalNames([
    ...SOURCE_TEXTS,
    "Doors at 6 P.M. A new mural goes up next door.",
    "Gates open Saturday P.M. Arrive early for parking.",
  ]);
  assert.deepEqual(names, ["Mistah F.A.B."]);

  const prose = "Mistah F.A.B. headlines. Doors at 6 P.M. A new mural goes up next door.";
  assert.equal(repairCanonicalNames(prose, names), prose);
});

test("prose that already spells the name correctly comes back byte-identical", () => {
  const names = collectCanonicalNames(SOURCE_TEXTS);
  for (const prose of [
    "Mistah F.A.B. closes out the night.",
    "Mistah F.A.B.’s set closes out the night.",
    "Mistah F.A.B., P-Lo, and 310Babii share the bill.",
  ]) {
    assert.equal(repairCanonicalNames(prose, names), prose, prose);
    // Idempotent: a second pass is a no-op.
    assert.equal(repairCanonicalNames(repairCanonicalNames(prose, names), names), prose, prose);
  }
});

test("the repair needs its name anchor, so ordinary words are left alone", () => {
  const names = collectCanonicalNames(SOURCE_TEXTS);
  for (const prose of [
    "The fab new bakery opens Thursday.",
    "A FAB grant funds the mural.",
    "Bring your F. A. Q. list.",
  ]) {
    assert.equal(repairCanonicalNames(prose, names), prose, prose);
  }
});

test("a bare initialism that spells an ordinary word cannot rewrite that word", () => {
  // Case-sensitive initials are what keep "Group its own" out of reach of a
  // canonical "Group I.T.S." — the failure mode the guard exists to prevent.
  const names = collectCanonicalNames(["The Group I.T.S. plays Thursday."]);
  assert.deepEqual(names, ["Group I.T.S."]);
  assert.equal(
    repairCanonicalNames("The Group its own way of doing things.", names),
    "The Group its own way of doing things.",
  );
  assert.equal(
    repairCanonicalNames("The Group ITS plays Thursday.", names),
    "The Group I.T.S. plays Thursday.",
  );
});

test("a lead word capitalized only because it opened a sentence keeps its case", () => {
  const names = collectCanonicalNames(["Also F.A.B. is on the bill."]);
  assert.deepEqual(names, ["Also F.A.B."]);
  // The initials get fixed; "also" is not capitalized mid-sentence to match.
  assert.equal(
    repairCanonicalNames("The lineup also F. A. B. rounds out.", names),
    "The lineup also F.A.B. rounds out.",
  );
});

test("abbreviations and unanchored initialisms never become canonical names", () => {
  assert.deepEqual(extractCanonicalNames("Doors at 6 P.M. and gates at 5 A.M."), []);
  assert.deepEqual(extractCanonicalNames("Saturday P.M. showers taper off."), []);
  assert.deepEqual(extractCanonicalNames("Tickets via the U.S. Open box office."), []);
  // A standalone initialism has no capitalized anchor in front of it.
  assert.deepEqual(extractCanonicalNames("T.I. plays the Ritz."), []);
  // A capitalized word that ends a sentence is not an anchor for what follows.
  assert.deepEqual(extractCanonicalNames("The show is at PayPal Park. R.E.M. covers follow."), []);
});

test("empty and missing inputs are handled without throwing", () => {
  assert.deepEqual(collectCanonicalNames(null), []);
  assert.deepEqual(collectCanonicalNames([]), []);
  assert.deepEqual(extractCanonicalNames(null), []);
  assert.equal(repairCanonicalNames("", ["Mistah F.A.B."]), "");
  assert.equal(repairCanonicalNames(null, ["Mistah F.A.B."]), "");
  assert.equal(repairCanonicalNames("Mistah F. A. B.", null), "Mistah F. A. B.");
  assert.equal(repairCanonicalNames("Mistah F. A. B.", []), "Mistah F. A. B.");
});
