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
];

// Parse the generated manifest TS without importing it (no TS runtime here).
export async function loadManifest(manifestPath = MANIFEST_PATH) {
  if (!existsSync(manifestPath)) return {};
  const raw = await readFile(manifestPath, "utf8");
  const manifest = {};
  const re = /"([^"]+)":\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(raw))) manifest[m[1]] = m[2];
  return manifest;
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
