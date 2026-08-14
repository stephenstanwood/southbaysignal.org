import test from "node:test";
import assert from "node:assert/strict";

import {
  parseRecordBlock,
  shouldSkipWikipedia,
  auditLogoProvenance,
  FORCE_WIKI_IDS,
  SKIP_WIKI_IDS,
} from "./logo-audit.mjs";

// ---------------------------------------------------------------------------
// parseRecordBlock — the manifest now holds two record exports, and folding
// them together would let a provenance label masquerade as a logo path.
// ---------------------------------------------------------------------------

const TWO_BLOCK_MANIFEST = `// AUTO-GENERATED
export const TECH_LOGO_MANIFEST: Record<string, string> = {
  "nile": "/logos/nile.png",
  "kai": "/logos/kai.png",
};

export const TECH_LOGO_SOURCES: Record<string, string> = {
  "nile": "website",
  "kai": "icon-horse",
};
`;

test("each record export parses independently", () => {
  assert.deepEqual(parseRecordBlock(TWO_BLOCK_MANIFEST, "TECH_LOGO_MANIFEST"), {
    nile: "/logos/nile.png",
    kai: "/logos/kai.png",
  });
  assert.deepEqual(parseRecordBlock(TWO_BLOCK_MANIFEST, "TECH_LOGO_SOURCES"), {
    nile: "website",
    kai: "icon-horse",
  });
});

test("the path map never absorbs provenance labels from the second block", () => {
  const paths = parseRecordBlock(TWO_BLOCK_MANIFEST, "TECH_LOGO_MANIFEST");
  for (const v of Object.values(paths)) assert.match(v, /^\/logos\//);
});

test("a missing block is an empty record, not a throw", () => {
  assert.deepEqual(parseRecordBlock(TWO_BLOCK_MANIFEST, "NOPE_NOT_HERE"), {});
  assert.deepEqual(parseRecordBlock("", "TECH_LOGO_MANIFEST"), {});
});

// ---------------------------------------------------------------------------
// shouldSkipWikipedia
// ---------------------------------------------------------------------------

test("public spotlight companies may use Wikipedia", () => {
  assert.equal(
    shouldSkipWikipedia({ id: "intuit", group: "SCC_SPOTLIGHT", stage: "public" }),
    false,
  );
});

test("private spotlight companies may not — this is the Kai/Nile rule", () => {
  assert.equal(
    shouldSkipWikipedia({ id: "kai", group: "SCC_SPOTLIGHT", stage: "startup" }),
    true,
  );
  assert.equal(
    shouldSkipWikipedia({ id: "nile", group: "SCC_SPOTLIGHT", stage: "growth" }),
    true,
  );
});

test("a spotlight entry with no stage is treated as private", () => {
  assert.equal(shouldSkipWikipedia({ id: "mystery", group: "SCC_SPOTLIGHT", stage: "" }), true);
});

test("every recently-funded round skips Wikipedia regardless of stage", () => {
  assert.equal(
    shouldSkipWikipedia({ id: "simile-seed", group: "RECENTLY_FUNDED", stage: "public" }),
    true,
  );
});

test("FORCE_WIKI_IDS wins over the private rule", () => {
  for (const id of FORCE_WIKI_IDS) {
    assert.equal(shouldSkipWikipedia({ id, group: "SCC_SPOTLIGHT", stage: "growth" }), false);
  }
});

test("SKIP_WIKI_IDS applies even inside TECH_COMPANIES", () => {
  for (const id of SKIP_WIKI_IDS) {
    assert.equal(shouldSkipWikipedia({ id, group: "TECH_COMPANIES", stage: "public" }), true);
  }
});

test("ordinary public companies and milestones are unaffected", () => {
  assert.equal(shouldSkipWikipedia({ id: "cisco", group: "TECH_COMPANIES", stage: "public" }), false);
  assert.equal(shouldSkipWikipedia({ id: "apple-ipo", group: "TECH_MILESTONES", stage: "" }), false);
  assert.equal(shouldSkipWikipedia(null), false);
});

// ---------------------------------------------------------------------------
// auditLogoProvenance
// ---------------------------------------------------------------------------

const COMPANIES = [
  { id: "intuit", group: "SCC_SPOTLIGHT", stage: "public" },
  { id: "kai", group: "SCC_SPOTLIGHT", stage: "startup" },
  { id: "cisco", group: "TECH_COMPANIES", stage: "public" },
];

test("a private company recorded as Wikipedia-sourced is a violation", () => {
  const { violations } = auditLogoProvenance(
    { intuit: "wikipedia", kai: "wikipedia", cisco: "wikipedia" },
    COMPANIES,
  );
  assert.deepEqual(
    violations.map((v) => v.id),
    ["kai"],
  );
  assert.equal(violations[0].group, "SCC_SPOTLIGHT");
  assert.equal(violations[0].stage, "startup");
});

test("the same private company sourced off its own site is clean", () => {
  const { violations } = auditLogoProvenance(
    { intuit: "wikipedia", kai: "website", cisco: "wikipedia" },
    COMPANIES,
  );
  assert.deepEqual(violations, []);
});

test("a hand-pinned Commons file is a human decision, not a bad search", () => {
  const { violations } = auditLogoProvenance({ kai: "pinned-wiki" }, COMPANIES);
  assert.deepEqual(violations, []);
});

test("unlabeled ids are reported separately and never counted as violations", () => {
  const { violations, unlabeled } = auditLogoProvenance({ kai: "wikipedia" }, COMPANIES);
  assert.deepEqual(violations.map((v) => v.id), ["kai"]);
  assert.deepEqual(unlabeled.sort(), ["cisco", "intuit"]);
});

test("a stage change from public to private turns a stale Wikipedia mark into a failure", () => {
  const sources = { intuit: "wikipedia" };
  assert.deepEqual(auditLogoProvenance(sources, COMPANIES).violations, []);
  const wentPrivate = [{ id: "intuit", group: "SCC_SPOTLIGHT", stage: "growth" }];
  assert.deepEqual(
    auditLogoProvenance(sources, wentPrivate).violations.map((v) => v.id),
    ["intuit"],
  );
});

test("empty or missing inputs do not throw", () => {
  assert.deepEqual(auditLogoProvenance(null, null), { violations: [], unlabeled: [] });
  assert.deepEqual(auditLogoProvenance({}, []), { violations: [], unlabeled: [] });
});

test("provenance for an id no longer in the data file is ignored, not flagged", () => {
  // Manifest drift is handled by findDrift; provenance only judges live rows.
  const { violations } = auditLogoProvenance({ "long-gone": "wikipedia" }, COMPANIES);
  assert.deepEqual(violations, []);
});
