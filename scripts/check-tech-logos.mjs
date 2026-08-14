#!/usr/bin/env node
// Prebuild gate over the COMMITTED tech logo manifest. Offline — no network,
// no fetching. Fails the build when:
//   1. a manifest entry points at a file that isn't in /public/logos (broken
//      image on /tech),
//   2. two unrelated ids resolve to byte-identical images (a resolver strategy
//      fell through to somebody's site chrome, and one wrong mark gets stamped
//      on a pile of real companies), or
//   3. a company that isn't allowed to source from Wikipedia has a committed
//      logo recorded as coming from Wikipedia. Checks 1 and 2 both pass a
//      wrong-but-unique mark: /tech carried an Indonesian railway's logo on a
//      Palo Alto security startup's card for five months, and it took a manual
//      audit to find. Provenance is what makes that catchable at build time.
//
// The same audits run at the end of fetch-tech-logos.mjs, but nobody runs the
// fetcher on a schedule — this is the check that actually ships.
//
// Usage: node scripts/check-tech-logos.mjs

import {
  ROOT,
  MANIFEST_PATH,
  loadManifest,
  loadManifestSources,
  loadDataIds,
  loadCompanies,
  findDrift,
  auditLogoManifest,
  auditLogoProvenance,
} from "./lib/logo-audit.mjs";

const manifest = await loadManifest(MANIFEST_PATH);
const total = Object.keys(manifest).length;

if (!total) {
  console.error("check-tech-logos: manifest is empty or unreadable at");
  console.error(`  ${MANIFEST_PATH}`);
  process.exit(1);
}

const { missing, duplicates } = await auditLogoManifest(manifest, ROOT);

// Provenance: only rows recorded since fetch-tech-logos.mjs started tracking it
// can be judged. An unlabeled id predates tracking and is reported, never
// failed — retrofitting a label would mean asserting a source we never saw.
const sources = await loadManifestSources();
const companies = await loadCompanies();
const { violations, unlabeled } = auditLogoProvenance(sources, companies);
if (companies.length && unlabeled.length) {
  console.log(
    `check-tech-logos: note — ${unlabeled.length}/${companies.length} compan(ies) have no recorded logo source yet; they'll be labeled as logos are re-fetched.`,
  );
}

// Drift is informational: a company can legitimately land before its logo is
// fetched, and removing a company shouldn't break a deploy.
const ids = await loadDataIds();
if (ids) {
  const { orphans, unresolved } = findDrift(manifest, ids);
  if (orphans.length) {
    console.log(
      `check-tech-logos: note — ${orphans.length} manifest entr(ies) no longer in tech-companies.ts: ${orphans.join(", ")}`,
    );
  }
  if (unresolved.length) {
    console.log(
      `check-tech-logos: note — ${unresolved.length} compan(ies) have no logo, using the favicon fallback: ${unresolved.join(", ")}`,
    );
  }
}

if (!missing.length && !duplicates.length && !violations.length) {
  console.log(
    `check-tech-logos: OK (${total} logos, no missing files, no unexpected shared marks, no misrouted sources)`,
  );
  process.exit(0);
}

console.error(`\n✖ check-tech-logos failed (${total} logos audited)\n`);

if (missing.length) {
  console.error(`Manifest points at ${missing.length} file(s) that don't exist:`);
  for (const { id, rel } of missing) console.error(`  ${id} → ${rel}`);
  console.error(
    "\nFix: re-run `node scripts/fetch-tech-logos.mjs --id <id>`, or drop the\n" +
      "entry so the page falls back to the render-time favicon service.\n",
  );
}

if (duplicates.length) {
  console.error(`${duplicates.length} unexpected shared logo cluster(s):`);
  for (const ids of duplicates) console.error(`  ${ids.join(", ")}`);
  console.error(
    "\nThese ids resolved to byte-identical images. Either pin the odd one out\n" +
      "in PINNED_WIKI_LOGOS (scripts/fetch-tech-logos.mjs) and re-fetch it, or —\n" +
      "if they really are the same brand — add them to SHARED_LOGO_GROUPS in\n" +
      "scripts/lib/logo-audit.mjs.\n",
  );
}

if (violations.length) {
  console.error(`${violations.length} logo(s) sourced from Wikipedia for a company that can't use it:`);
  for (const v of violations) console.error(`  ${v.id} (${v.group}, stage=${v.stage})`);
  console.error(
    "\nYoung private companies are named after plain nouns, so a Wikipedia\n" +
      "lookup lands on the noun's article and returns its chrome or an unrelated\n" +
      "business. Re-fetch off the company's own site:\n" +
      "  node scripts/fetch-tech-logos.mjs --refresh --id <id>\n" +
      "If this company genuinely has the best mark on Wikipedia, add it to\n" +
      "FORCE_WIKI_IDS in scripts/lib/logo-audit.mjs and re-fetch.\n",
  );
}

process.exit(1);
