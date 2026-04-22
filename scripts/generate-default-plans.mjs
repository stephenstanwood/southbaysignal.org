#!/usr/bin/env node
/**
 * generate-default-plans.mjs
 *
 * Pre-generates day plans for featured cities using the production plan-day API.
 * These are served as the instant default plan on the homepage — no loading
 * spinner, no separate "lazy" algorithm. Same quality as the API.
 *
 * Run: node scripts/generate-default-plans.mjs
 * Schedule: 2:00 AM PT daily on Mini
 *
 * Generates two plans per city (kids=false, kids=true) and saves to
 * src/data/south-bay/default-plans.json.
 */

import { writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "default-plans.json");
const CITIES_PATH = join(__dirname, "..", "src", "lib", "south-bay", "cities.ts");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = process.env.SBT_API_BASE || "https://southbaytoday.org";

/**
 * Pull the canonical city list from cities.ts so adding a new city anywhere
 * in the app automatically gets a pre-generated default plan. santa-cruz is
 * excluded from plan-day VALID_CITIES so we skip it here too.
 */
function loadFeaturedCities() {
  try {
    const src = readFileSync(CITIES_PATH, "utf8");
    const ids = [];
    for (const m of src.matchAll(/id:\s*"([^"]+)"/g)) {
      if (m[1] !== "santa-cruz") ids.push(m[1]);
    }
    if (ids.length === 0) throw new Error("no city ids parsed");
    return ids;
  } catch (err) {
    console.warn(`  ⚠️  falling back to hardcoded city list: ${err.message}`);
    return ["campbell", "cupertino", "los-altos", "los-gatos", "milpitas", "mountain-view", "palo-alto", "san-jose", "santa-clara", "saratoga", "sunnyvale"];
  }
}

const FEATURED_CITIES = loadFeaturedCities();
/**
 * Anchor hours: first-visit users land in one of these buckets based on wall
 * time. Homepage loader picks the nearest-but-not-future anchor (9 for 8–12,
 * 13 for 12–16, 17 for 16–20) so the plan shape matches their time of day.
 * Anchor cards before the user's current time get filtered client-side as a
 * final belt-and-suspenders pass.
 */
const ANCHOR_HOURS = [9, 13, 17];
const DELAY_MS = 3000; // polite delay between API calls

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPlan(city, kids, anchorHour) {
  const url = `${API_BASE}/api/plan-day`;
  console.log(`  → ${city} (kids=${kids}, anchor=${anchorHour}:00)...`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      city,
      kids,
      lockedIds: [],
      dismissedIds: [],
      currentHour: anchorHour,
      currentMinute: 0,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status} for ${city}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`generate-default-plans: ${FEATURED_CITIES.length} cities × 2 kids × ${ANCHOR_HOURS.length} anchors = ${FEATURED_CITIES.length * 2 * ANCHOR_HOURS.length} plans`);
  console.log(`  API: ${API_BASE}`);
  console.log(`  anchors: ${ANCHOR_HOURS.map(h => `${h}:00`).join(", ")}`);

  const plans = {};
  let errors = 0;

  for (const city of FEATURED_CITIES) {
    for (const kids of [false, true]) {
      for (const anchor of ANCHOR_HOURS) {
        // Key shape: "city:kids|adults:h9" — homepage loader parses the
        // anchor suffix and picks the nearest-but-not-future anchor.
        const key = `${city}:${kids ? "kids" : "adults"}:h${anchor}`;
        try {
          const data = await fetchPlan(city, kids, anchor);
          plans[key] = {
            cards: data.cards || [],
            weather: data.weather || null,
            city,
            kids,
            anchorHour: anchor,
            generatedAt: new Date().toISOString(),
            poolSize: data.poolSize || 0,
          };
          console.log(`  ✓ ${key}: ${plans[key].cards.length} cards`);
        } catch (err) {
          console.error(`  ✗ ${key}: ${err.message}`);
          errors++;
        }
        await sleep(DELAY_MS);
      }
    }
  }

  if (Object.keys(plans).length === 0) {
    console.error("ERROR: no plans generated, aborting");
    process.exit(1);
  }

  const output = {
    _meta: {
      generatedAt: new Date().toISOString(),
      generator: "generate-default-plans",
      cities: FEATURED_CITIES,
      anchorHours: ANCHOR_HOURS,
      planCount: Object.keys(plans).length,
      errors,
    },
    plans,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${Object.keys(plans).length} plans to default-plans.json`);
  if (errors > 0) console.warn(`  (${errors} errors — some cities/anchors may be missing)`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
