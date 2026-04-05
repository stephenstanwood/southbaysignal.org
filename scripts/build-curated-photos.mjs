#!/usr/bin/env node
/**
 * build-curated-photos.mjs
 * Reads photo-data.json + photo-votes.json and outputs
 * src/data/south-bay/curated-photos.json with only approved photos.
 *
 * Run: node scripts/build-curated-photos.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { BLOCKED_IDS } from "./blocked-photos.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const dataPath  = join(ROOT, "photo-data.json");
const votesPath = join(ROOT, "photo-votes.json");
const outPath   = join(ROOT, "src", "data", "south-bay", "curated-photos.json");

if (!existsSync(dataPath))  { console.error("Missing photo-data.json"); process.exit(1); }
if (!existsSync(votesPath)) { console.error("Missing photo-votes.json"); process.exit(1); }

const allPhotos = JSON.parse(readFileSync(dataPath, "utf8"));
const votes     = JSON.parse(readFileSync(votesPath, "utf8"));
const approved  = new Set(votes.approved ?? []);

const curated = allPhotos
  .filter(p => approved.has(p.id) && !BLOCKED_IDS.has(p.id))
  .map(({ id, thumb, full, title, photographer, photoPage, license, source }) => ({
    id, thumb, full,
    title:        (title || "").slice(0, 100),
    photographer: (photographer || "").slice(0, 80),
    photoPage,
    license,
    source,
  }));

// Shuffle deterministically-ish (stable across runs unless pool changes)
curated.sort((a, b) => a.id.localeCompare(b.id));

writeFileSync(outPath, JSON.stringify({ photos: curated }, null, 2));
console.log(`✅ ${curated.length} curated photos → ${outPath}`);
