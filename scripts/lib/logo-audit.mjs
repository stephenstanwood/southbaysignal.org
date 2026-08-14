// Shared logo-manifest audit. Lives here so both the fetcher
// (scripts/fetch-tech-logos.mjs, at the end of a resolver run) and the prebuild
// gate (scripts/check-tech-logos.mjs, over the committed manifest) apply the
// exact same rules — one wrong image served as 16 companies' logos for months
// because nothing ever compared the files on disk.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");
export const MANIFEST_PATH = path.join(
  ROOT,
  "src",
  "lib",
  "south-bay",
  "tech-logo-manifest.ts",
);
export const DATA_PATH = path.join(
  ROOT,
  "src",
  "data",
  "south-bay",
  "tech-companies.ts",
);

// Ids that legitimately share one mark — a milestone aliased to its parent
// brand, or a funding round aliased to the company. Everything else sharing an
// identical image file is a resolver bug, not a coincidence.
export const SHARED_LOGO_GROUPS = [
  ["apple", "apple-wwdc", "app-store-launch", "apple-acquires-next", "apple-ipo",
   "apple-retail", "apple-think-different", "iphone-announcement", "iphone-on-sale",
   "ipod", "mac-introduction"],
  ["intel", "intel-4004", "intel-8086", "intel-core2", "intel-pentium", "moores-law"],
  ["google", "google-ipo"],
  ["yahoo", "yahoo-ipo"],
  ["hp", "hp35-calculator"],
  ["atari", "atari-2600", "atari-founding"],
  ["palm-computing", "palmpilot-launch"],
  ["netscape", "netscape-ipo"],
  ["glean", "glean-series-f"],
  // Same company on two surfaces: the "Smaller, But Notable" spotlight card and
  // its Recently Funded round card. Converged once the spotlight entry started
  // resolving off sambanova.ai instead of Wikipedia — same brand, so this is the
  // pair agreeing, not a resolver falling through to shared site chrome.
  ["sambanova", "sambanova-series-f"],
];

/** Pull one `export const <name> ... = { "k": "v", ... }` block out of generated
 *  TS. Scoped per-constant on purpose: the manifest file holds two record
 *  exports now, and a file-wide `"k": "v"` sweep would merge logo paths and
 *  provenance labels into one map. */
export function parseRecordBlock(raw, constName) {
  const start = new RegExp(`export\\s+const\\s+${constName}\\b[^=]*=\\s*\\{`).exec(raw);
  if (!start) return {};
  const from = start.index + start[0].length;
  let depth = 1;
  let i = from;
  while (i < raw.length && depth > 0) {
    const ch = raw[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  const body = raw.slice(from, i - 1);
  const out = {};
  const re = /"([^"]+)":\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[2];
  return out;
}

// Parse the generated manifest TS without importing it (no TS runtime here).
export async function loadManifest(manifestPath = MANIFEST_PATH) {
  if (!existsSync(manifestPath)) return {};
  const raw = await readFile(manifestPath, "utf8");
  return parseRecordBlock(raw, "TECH_LOGO_MANIFEST");
}

/** id → the resolver strategy that produced the committed file ("wikipedia",
 *  "website", "icon-horse", …). Absent for entries fetched before provenance
 *  was recorded; callers treat a missing label as unknown, never as a pass. */
export async function loadManifestSources(manifestPath = MANIFEST_PATH) {
  if (!existsSync(manifestPath)) return {};
  const raw = await readFile(manifestPath, "utf8");
  return parseRecordBlock(raw, "TECH_LOGO_SOURCES");
}

// Every `id:` in the data file. Deliberately a superset of what the fetcher's
// per-array parser sees, so drift reporting stays conservative: a real id can
// never be mistaken for an orphan just because it moved between arrays.
export async function loadDataIds(dataPath = DATA_PATH) {
  if (!existsSync(dataPath)) return null;
  const src = await readFile(dataPath, "utf8");
  return new Set([...src.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]));
}

// Manifest rows for ids the data file no longer has (dead logo files shipping
// to /public), and ids with no logo at all (they fall back to the render-time
// favicon service). Both are drift, not breakage — callers warn, never fail.
export function findDrift(manifest, ids) {
  const orphans = Object.keys(manifest).filter((id) => !ids.has(id));
  const unresolved = [...ids].filter((id) => !manifest[id]);
  return { orphans, unresolved };
}

// ── Wikipedia eligibility ────────────────────────────────────────────────────
// Which companies may take a logo from Wikipedia. Lives here, next to the
// audit, so the fetcher's decision and the gate's check can never disagree —
// the whole point of recording provenance is that the gate re-derives this rule
// against the committed data and catches an entry the fetcher no longer would.

// Common-word names where Wikipedia search returns the wrong subject outright.
export const SKIP_WIKI_IDS = new Set([
  "sycamore", // matches Indiana State Sycamores sports team
  "aria-networks", // matches Aria opera houses
  "java", // ambiguous; covered by PINNED instead
  "android", // covered by PINNED
  "tesla", // covered by PINNED
]);

// `stage` is a funding label, not a fame label, so a few private companies are
// household enough to have a real article with a clean mark AND a website that
// serves something useless. Both verified by hand: ampere's own site yields a
// product photo of a chip on a circuit board, cohesity's a banner whose
// wordmark is white-on-white.
export const FORCE_WIKI_IDS = new Set(["ampere-computing", "cohesity"]);

/** True when a company must NOT source its logo from Wikipedia.
 *
 *  Young private companies are named after plain nouns — "Glow", "Hark",
 *  "Simile", "Queue", "Kai", "Nile" — and the lookup lands on a dictionary or
 *  disambiguation page, returning that page's chrome or an unrelated business.
 *  Shipping that is a trust bug: /tech carried an Indonesian railway's logo on
 *  a Palo Alto security startup's card for five months. Public companies still
 *  use Wikipedia, where it genuinely has the best mark. */
export function shouldSkipWikipedia(company) {
  if (!company) return false;
  if (FORCE_WIKI_IDS.has(company.id)) return false;
  if (SKIP_WIKI_IDS.has(company.id)) return true;
  if (company.group === "RECENTLY_FUNDED") return true;
  if (company.group === "SCC_SPOTLIGHT" && company.stage !== "public") return true;
  return false;
}

// Provenance labels a resolver strategy can record. Only the two Wikipedia
// ones are load-bearing for the gate; the rest exist so a manifest row says
// where its image actually came from.
export const WIKIPEDIA_SOURCE = "wikipedia";
export const PINNED_WIKI_SOURCE = "pinned-wiki";

/** Manifest rows whose committed image came from Wikipedia for a company that
 *  isn't allowed to use it. Recorded provenance plus the live data file, so a
 *  company moving from public to private (or into RECENTLY_FUNDED) turns its
 *  stale Wikipedia mark into a build failure instead of a silent wrong logo.
 *
 *  `pinned-wiki` is exempt: PINNED_WIKI_LOGOS is a hand-picked Commons file per
 *  id, which is a human decision, not a search result that went wrong. */
export function auditLogoProvenance(sources, companies) {
  const byId = new Map((companies || []).map((c) => [c.id, c]));
  const violations = [];
  const unlabeled = [];
  for (const [id, company] of byId) {
    const src = sources?.[id];
    if (!src) {
      unlabeled.push(id);
      continue;
    }
    if (src === WIKIPEDIA_SOURCE && shouldSkipWikipedia(company)) {
      violations.push({ id, source: src, group: company.group, stage: company.stage || "—" });
    }
  }
  return { violations, unlabeled };
}

// ── data parser ──────────────────────────────────────────────────────────────
// Light TS-source parser for the fields both the fetcher and the gate need.

function extractArrayBlock(src, name) {
  const re = new RegExp(`export\\s+const\\s+${name}[^=]*=\\s*\\[`);
  const m = re.exec(src);
  if (!m) return "";
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

function splitObjectLiterals(body) {
  const items = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") {
      if (depth === 0) buf = "";
      depth++;
      buf += ch;
    } else if (ch === "}") {
      depth--;
      buf += ch;
      if (depth === 0) items.push(buf);
    } else if (depth > 0) {
      buf += ch;
    }
  }
  return items;
}

function matchField(item, field) {
  const re = new RegExp(`\\b${field}\\s*:\\s*"([^"]*)"`);
  const m = re.exec(item);
  return m ? m[1] : null;
}

/** Every logo-bearing entry in tech-companies.ts, carrying the `group` and
 *  `stage` that shouldSkipWikipedia gates on. */
export async function loadCompanies(dataPath = DATA_PATH) {
  if (!existsSync(dataPath)) return [];
  const src = await readFile(dataPath, "utf8");
  const groups = [
    "TECH_COMPANIES",
    "SCC_SPOTLIGHT",
    "RECENTLY_FUNDED",
    "TECH_MILESTONES",
    "TECH_CONFERENCES",
  ];
  const out = [];
  for (const groupName of groups) {
    const body = extractArrayBlock(src, groupName);
    if (!body) continue;
    for (const item of splitObjectLiterals(body)) {
      const id = matchField(item, "id");
      if (!id) continue;
      out.push({
        id,
        name:
          matchField(item, "name") ||
          matchField(item, "company") ||
          matchField(item, "title") ||
          id,
        url:
          matchField(item, "careersUrl") ||
          matchField(item, "url") ||
          matchField(item, "website") ||
          "",
        group: groupName,
        stage: matchField(item, "stage") || "",
      });
    }
  }
  // De-dupe by id (TECH_COMPANIES + TECH_MILESTONES often share IDs).
  const seen = new Map();
  for (const c of out) {
    const prev = seen.get(c.id);
    if (!prev) seen.set(c.id, c);
    else if (!prev.url && c.url) seen.set(c.id, c); // prefer entry with url
  }
  return [...seen.values()];
}

// Returns { missing, duplicates } instead of printing, so callers decide
// whether a finding is a warning (mid-run) or a build failure (prebuild).
export async function auditLogoManifest(manifest, root = ROOT) {
  const allowed = new Set();
  for (const group of SHARED_LOGO_GROUPS) {
    for (const a of group) for (const b of group) if (a !== b) allowed.add(`${a}|${b}`);
  }

  const missing = [];
  const byHash = new Map();
  for (const [id, rel] of Object.entries(manifest)) {
    const abs = path.join(root, "public", rel.replace(/^\//, ""));
    if (!existsSync(abs)) {
      missing.push({ id, rel });
      continue;
    }
    const hash = createHash("sha256").update(await readFile(abs)).digest("hex");
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(id);
  }

  const duplicates = [];
  for (const ids of byHash.values()) {
    if (ids.length < 2) continue;
    const unexpected = ids.filter((id) =>
      ids.some((other) => other !== id && !allowed.has(`${id}|${other}`)),
    );
    if (unexpected.length > 1) duplicates.push(unexpected);
  }

  return { missing, duplicates };
}
