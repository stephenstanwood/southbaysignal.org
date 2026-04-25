#!/usr/bin/env node
/**
 * backfill-places-from-reddit.mjs
 *
 * Reads reddit-gaps.json placeGaps[], looks each up via Google Places Text Search,
 * applies the same quality filters as generate-places.mjs (rating ≥4.0, ≥20 ratings,
 * has photo, address is in one of our 11 South Bay cities), and appends new entries
 * to places.json.
 *
 * Conservative: only adds places that pass the quality bar AND aren't already in
 * places.json by id. Reports skipped entries with reason.
 *
 * Run: node --env-file=.env.local scripts/backfill-places-from-reddit.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ARTIFACTS } from "./lib/paths.mjs";
import { loadEnvLocal } from "./lib/env.mjs";
import { autotagPlace } from "./lib/infer-place-tags.mjs";

loadEnvLocal();

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
if (!API_KEY) {
  console.error("ERROR: GOOGLE_PLACES_API_KEY not set");
  process.exit(1);
}

const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.types",
  "places.regularOpeningHours",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.photos",
].join(",");

const MIN_RATING = 4.0;
const MIN_RATINGS_COUNT = 20;
const REQUEST_DELAY_MS = 350;

// ─── Cities (matches generate-places.mjs) ────────────────────────────
const CITIES = [
  { slug: "campbell",      name: "Campbell",      lat: 37.2872, lng: -121.9500 },
  { slug: "cupertino",     name: "Cupertino",     lat: 37.3230, lng: -122.0322 },
  { slug: "los-altos",     name: "Los Altos",     lat: 37.3852, lng: -122.1141 },
  { slug: "los-gatos",     name: "Los Gatos",     lat: 37.2358, lng: -121.9624 },
  { slug: "milpitas",      name: "Milpitas",      lat: 37.4323, lng: -121.8996 },
  { slug: "mountain-view", name: "Mountain View", lat: 37.3861, lng: -122.0839 },
  { slug: "palo-alto",     name: "Palo Alto",     lat: 37.4419, lng: -122.1430 },
  { slug: "san-jose",      name: "San Jose",      lat: 37.3382, lng: -121.8863 },
  { slug: "santa-clara",   name: "Santa Clara",   lat: 37.3541, lng: -121.9552 },
  { slug: "saratoga",      name: "Saratoga",      lat: 37.2638, lng: -122.0230 },
  { slug: "sunnyvale",     name: "Sunnyvale",     lat: 37.3688, lng: -122.0363 },
];
const CITY_BY_NAME = new Map(CITIES.map((c) => [c.name.toLowerCase(), c]));

const TYPE_TO_CATEGORY = {
  // Food
  restaurant: "food", cafe: "food", coffee_shop: "food", bar: "food", bakery: "food",
  pastry_shop: "food", cake_shop: "food", ice_cream_shop: "food", dessert_shop: "food",
  donut_shop: "food", bagel_shop: "food", winery: "food", brewery: "food",
  pub: "food", wine_bar: "food", deli: "food", diner: "food", food_court: "food",
  acai_shop: "food", tea_house: "food", juice_shop: "food", confectionery: "food",
  pizza_restaurant: "food", seafood_restaurant: "food", steak_house: "food",
  sushi_restaurant: "food", ramen_restaurant: "food", sandwich_shop: "food",
  hamburger_restaurant: "food", fast_food_restaurant: "food",
  fine_dining_restaurant: "food", mexican_restaurant: "food", italian_restaurant: "food",
  chinese_restaurant: "food", japanese_restaurant: "food", indian_restaurant: "food",
  thai_restaurant: "food", vietnamese_restaurant: "food", korean_restaurant: "food",
  korean_barbecue_restaurant: "food", american_restaurant: "food", asian_restaurant: "food",
  mediterranean_restaurant: "food", french_restaurant: "food", greek_restaurant: "food",
  vegetarian_restaurant: "food", vegan_restaurant: "food", brunch_restaurant: "food",
  breakfast_restaurant: "food", barbecue_restaurant: "food",
  asian_fusion_restaurant: "food", afghan_restaurant: "food", filipino_restaurant: "food",
  taqueria: "food", taco_restaurant: "food", noodle_restaurant: "food",
  bistro: "food", gastropub: "food",
  // Outdoor
  park: "outdoor", state_park: "outdoor", playground: "outdoor", hiking_area: "outdoor",
  garden: "outdoor", botanical_garden: "outdoor", water_park: "outdoor",
  swimming_pool: "outdoor", beach: "outdoor",
  // Culture
  museum: "museum", art_gallery: "museum", library: "museum",
  // Entertainment
  movie_theater: "entertainment", bowling_alley: "entertainment",
  amusement_park: "entertainment", aquarium: "entertainment", zoo: "entertainment",
  performing_arts_theater: "entertainment", concert_hall: "entertainment",
  stadium: "entertainment", arena: "entertainment", ice_skating_rink: "entertainment",
  skate_park: "entertainment", roller_skating_rink: "entertainment",
  arcade: "entertainment", casino: "entertainment",
  // Wellness
  spa: "wellness",
  // Shopping
  book_store: "shopping", record_store: "shopping",
};

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// ─── Helpers ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function detectCity(address) {
  const addr = address.toLowerCase();
  if (!/,\s*ca\s+\d{5}/.test(addr) && !addr.includes(", ca,")) return null;
  for (const city of CITIES) {
    const name = city.name.toLowerCase();
    const re = new RegExp(`\\b${name.replace(/\s+/g, "\\s+")},\\s*ca\\b`);
    if (re.test(addr)) return city.slug;
  }
  return null;
}

function parseHours(regularOpeningHours) {
  if (!regularOpeningHours?.periods) return null;
  const hours = {};
  for (const period of regularOpeningHours.periods) {
    const day = DAY_NAMES[period.open?.day];
    if (!day) continue;
    const open = `${String(period.open.hour ?? 0).padStart(2, "0")}:${String(period.open.minute ?? 0).padStart(2, "0")}`;
    const close = period.close
      ? `${String(period.close.hour ?? 0).padStart(2, "0")}:${String(period.close.minute ?? 0).padStart(2, "0")}`
      : "23:59";
    hours[day] = hours[day] ? `${hours[day]}, ${open}-${close}` : `${open}-${close}`;
  }
  return Object.keys(hours).length > 0 ? hours : null;
}

const NAME_SUFFIXES_TO_STRIP = [
  /\s+-\s+.+$/,
  /\s*\(.+\)\s*$/,
];
function cleanPlaceName(name) {
  let cleaned = name;
  for (const pattern of NAME_SUFFIXES_TO_STRIP) cleaned = cleaned.replace(pattern, "");
  return cleaned.trim();
}

async function searchPlace(textQuery, city) {
  const body = {
    textQuery,
    pageSize: 5,
    languageCode: "en",
  };
  if (city) {
    body.locationBias = {
      circle: {
        center: { latitude: city.lat, longitude: city.lng },
        radius: 8000.0,
      },
    };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (!res.ok) {
      console.warn(`  ⚠️  API ${res.status} for "${textQuery}"`);
      return [];
    }
    const data = await res.json();
    return data.places || [];
  }
  return [];
}

function buildPlaceEntry(place) {
  const detectedCity = detectCity(place.formattedAddress || "");
  if (!detectedCity) return { ok: false, reason: "out-of-area" };

  const rating = place.rating ?? 0;
  const ratingCount = place.userRatingCount ?? 0;
  if (rating < MIN_RATING) return { ok: false, reason: `rating ${rating} < ${MIN_RATING}` };
  if (ratingCount < MIN_RATINGS_COUNT) return { ok: false, reason: `${ratingCount} ratings < ${MIN_RATINGS_COUNT}` };
  if (!place.photos?.[0]?.name) return { ok: false, reason: "no photo" };

  const primaryType = place.primaryType || "";
  const category = TYPE_TO_CATEGORY[primaryType] || null;

  const entry = {
    id: place.id,
    name: cleanPlaceName(place.displayName?.text || "Unknown"),
    address: place.formattedAddress || "",
    city: detectedCity,
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    rating,
    ratingCount,
    priceLevel: place.priceLevel || null,
    types: place.types || [],
    primaryType: primaryType || null,
    displayType: place.primaryTypeDisplayName?.text || null,
    category: category || "other",
    hours: parseHours(place.regularOpeningHours),
    url: place.websiteUri || null,
    mapsUrl: place.googleMapsUri || null,
    photoRef: place.photos?.[0]?.name || null,
    curated: false,
    discoverySource: "reddit-gaps",
  };

  // Apply autotag (kid-friendly, indoor/outdoor, etc.)
  if (autotagPlace) {
    try {
      const tagged = autotagPlace(entry);
      Object.assign(entry, tagged);
    } catch {}
  }

  if (!category) return { ok: false, reason: `unmapped primaryType: ${primaryType}` };
  return { ok: true, entry };
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(ARTIFACTS.redditGaps)) {
    console.error(`Missing ${ARTIFACTS.redditGaps}`);
    process.exit(1);
  }

  const gaps = JSON.parse(readFileSync(ARTIFACTS.redditGaps, "utf8"));
  const placeGaps = gaps.placeGaps || [];
  console.log(`Loaded ${placeGaps.length} place gaps from reddit-gaps.json\n`);

  const placesData = JSON.parse(readFileSync(ARTIFACTS.places, "utf8"));
  const existingIds = new Set((placesData.places || []).map((p) => p.id));
  console.log(`Existing places: ${existingIds.size}\n`);

  const added = [];
  const skipped = [];

  for (const gap of placeGaps) {
    const cityHint = (gap.city || "").trim();
    const city = cityHint ? CITY_BY_NAME.get(cityHint.toLowerCase()) : null;
    const cityForQuery = cityHint || "South Bay";

    // Skip categories that won't be useful in the day-plan pool.
    if (gap.kind === "park") {
      // Allow parks — they're useful day-plan stops
    }
    if (gap.kind === "service" || gap.kind === "other") {
      skipped.push({ name: gap.name, reason: `kind=${gap.kind} (apartments/transit/etc)` });
      continue;
    }

    const query = `${gap.name}, ${cityForQuery}, CA`;
    process.stdout.write(`  ${query.padEnd(55)} `);

    const results = await searchPlace(query, city);
    await sleep(REQUEST_DELAY_MS);

    if (results.length === 0) {
      console.log("✗ no results");
      skipped.push({ name: gap.name, reason: "no Google Places match" });
      continue;
    }

    // Pick the first result that passes our filters
    let added_this = false;
    for (const place of results) {
      if (existingIds.has(place.id)) {
        console.log(`= already in places.json (${place.displayName?.text})`);
        skipped.push({ name: gap.name, reason: "already-known", existingId: place.id });
        added_this = true;
        break;
      }

      const built = buildPlaceEntry(place);
      if (!built.ok) {
        // Try the next result
        continue;
      }

      added.push({ ...built.entry, source: gap.sourceUrls?.[0] || null });
      existingIds.add(built.entry.id);
      console.log(`✓ ${built.entry.name} (${built.entry.city}, ${built.entry.rating}★ × ${built.entry.ratingCount})`);
      added_this = true;
      break;
    }

    if (!added_this) {
      const reasons = results
        .map((r) => buildPlaceEntry(r).reason)
        .filter(Boolean)
        .slice(0, 3)
        .join("; ");
      console.log(`✗ filtered (${reasons || "no quality match"})`);
      skipped.push({ name: gap.name, reason: reasons || "no quality match" });
    }
  }

  if (added.length === 0) {
    console.log(`\nNothing new to add. ${skipped.length} skipped.`);
    return;
  }

  // Append to places.json
  placesData.places = [...(placesData.places || []), ...added];
  if (placesData.stats) {
    placesData.stats.total = placesData.places.length;
  }
  if (placesData._meta) {
    placesData._meta.lastBackfilledAt = new Date().toISOString();
    placesData._meta.lastBackfillSource = "reddit-gaps";
  }

  writeFileSync(ARTIFACTS.places, JSON.stringify(placesData, null, 2) + "\n");

  console.log(`\n✅ Added ${added.length} new places to places.json`);
  added.forEach((p) => console.log(`   • ${p.name} — ${p.city} — ${p.category} (${p.rating}★)`));
  console.log(`\n⏭️  Skipped: ${skipped.length}`);
  // Group skip reasons
  const skipCounts = {};
  for (const s of skipped) {
    const r = s.reason.split(";")[0].trim().split(":")[0];
    skipCounts[r] = (skipCounts[r] || 0) + 1;
  }
  for (const [r, n] of Object.entries(skipCounts)) console.log(`   ${n}× ${r}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
