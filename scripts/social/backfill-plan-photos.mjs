#!/usr/bin/env node
// Backfill missing photoRef on shared plan cards via Google Places API.
// This is for in-app display only (plan pages) — NOT for social redistribution.
// Usage: node scripts/social/backfill-plan-photos.mjs [--dry-run]

import { readFileSync, writeFileSync } from "node:fs";
import { canonicalizePlanCards } from "../../src/lib/south-bay/canonicalizeCard.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLANS_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "shared-plans.json");
const ENV_FILE = join(__dirname, "..", "..", ".env.local");

// Load env
try {
  const lines = readFileSync(ENV_FILE, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const apiKey = process.env.GOOGLE_PLACES_API_KEY;
if (!apiKey) { console.log("No GOOGLE_PLACES_API_KEY"); process.exit(1); }

const dryRun = process.argv.includes("--dry-run");
const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

async function lookupPhotoRef(name, city) {
  const query = city ? `${name} ${city.replace(/-/g, " ")}` : name;
  try {
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.photos",
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.places?.[0]?.photos?.[0]?.name || null;
  } catch {
    return null;
  }
}

const plans = JSON.parse(readFileSync(PLANS_FILE, "utf8"));
let found = 0;
let missed = 0;
const seen = new Map(); // cache name → photoRef

for (const [planId, plan] of Object.entries(plans)) {
  for (const card of (plan.cards || [])) {
    if (card.photoRef) continue;

    const name = card.venue || card.name;
    if (!name) continue;

    // Check cache first
    const cacheKey = `${name}|${card.city || ""}`;
    if (seen.has(cacheKey)) {
      const cached = seen.get(cacheKey);
      if (cached) {
        card.photoRef = cached;
        found++;
      }
      continue;
    }

    if (dryRun) {
      console.log(`Would look up: ${name} (${card.city || "?"})`);
      missed++;
      continue;
    }

    const ref = await lookupPhotoRef(name, card.city);
    seen.set(cacheKey, ref);

    if (ref) {
      card.photoRef = ref;
      found++;
      console.log(`✅ ${name}: ${ref.slice(0, 50)}...`);
    } else {
      missed++;
      console.log(`❌ ${name}: no photo found`);
    }

    // Polite delay
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Canonicalize every plan's cards on write so drift across plans heals over time.
for (const id of Object.keys(plans)) {
  if (plans[id]?.cards) plans[id].cards = canonicalizePlanCards(plans[id].cards);
}

if (!dryRun) {
  writeFileSync(PLANS_FILE, JSON.stringify(plans, null, 2) + "\n");
}

console.log(`\nDone: ${found} photos found, ${missed} still missing`);
