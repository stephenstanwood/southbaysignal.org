#!/usr/bin/env node
// ---------------------------------------------------------------------------
// South Bay Today — Places Data Pool Generator
// ---------------------------------------------------------------------------
// Scrapes Google Places API (New) Text Search to build a pool of ~1500-2000
// quality places across 11 South Bay cities. Merges with hand-curated POIs
// from poi-data.ts.
//
// Usage: GOOGLE_PLACES_API_KEY=xxx node scripts/generate-places.mjs
//        or set GOOGLE_PLACES_API_KEY in .env.local
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACTS, DATA_DIR, REPO_ROOT, generatorMeta } from "./lib/paths.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Load .env.local if present
try {
  const envPath = join(REPO_ROOT, ".env.local");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* no .env.local, that's fine */ }

const API_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";
if (!API_KEY) {
  console.error("❌ GOOGLE_PLACES_API_KEY is required. Set it in .env.local or env.");
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
  "places.websiteUri",
  "places.googleMapsUri",
  "places.photos",
].join(",");

const MIN_RATING = 4.0;
const MIN_RATINGS_COUNT = 20;
const REQUEST_DELAY_MS = 500;
const MAX_PAGES_PER_QUERY = 3; // 60 results max per query

// ---------------------------------------------------------------------------
// Cities — center coordinates for locationBias
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Search categories
// ---------------------------------------------------------------------------

const CATEGORIES = [
  // Food & drink
  { query: "restaurant",                    ourCat: "food" },
  { query: "cafe coffee shop",              ourCat: "food" },
  { query: "bar brewery taproom",           ourCat: "food" },
  { query: "bakery dessert",                ourCat: "food" },
  { query: "ice cream frozen yogurt",       ourCat: "food" },
  { query: "winery tasting room",           ourCat: "food" },
  // Outdoor
  { query: "park trail hiking",             ourCat: "outdoor" },
  { query: "playground",                    ourCat: "outdoor" },
  { query: "swimming pool aquatic center",  ourCat: "outdoor" },
  { query: "farmers market",               ourCat: "outdoor" },
  // Culture
  { query: "museum gallery",               ourCat: "museum" },
  { query: "library",                       ourCat: "museum" },
  { query: "community center",             ourCat: "entertainment" },
  // Entertainment
  { query: "movie theater entertainment",   ourCat: "entertainment" },
  { query: "bowling arcade fun center",     ourCat: "entertainment" },
  { query: "escape room",                   ourCat: "entertainment" },
  { query: "mini golf go karts",            ourCat: "entertainment" },
  { query: "batting cages",                 ourCat: "entertainment" },
  { query: "karaoke",                       ourCat: "entertainment" },
  { query: "board game cafe",               ourCat: "entertainment" },
  // Creative
  { query: "paint and sip art studio",      ourCat: "entertainment" },
  { query: "cooking class",                 ourCat: "entertainment" },
  // Wellness
  { query: "spa wellness massage",          ourCat: "wellness" },
  // Shopping
  { query: "bookstore",                     ourCat: "shopping" },
];

// ---------------------------------------------------------------------------
// Google type → our category mapping (for primaryType fallback)
// ---------------------------------------------------------------------------

const TYPE_TO_CATEGORY = {
  restaurant: "food",
  cafe: "food",
  coffee_shop: "food",
  bar: "food",
  bakery: "food",
  ice_cream_shop: "food",
  meal_delivery: "food",
  meal_takeaway: "food",
  winery: "food",
  brewery: "food",
  pizza_restaurant: "food",
  seafood_restaurant: "food",
  steak_house: "food",
  sushi_restaurant: "food",
  ramen_restaurant: "food",
  sandwich_shop: "food",
  hamburger_restaurant: "food",
  mexican_restaurant: "food",
  italian_restaurant: "food",
  chinese_restaurant: "food",
  japanese_restaurant: "food",
  indian_restaurant: "food",
  thai_restaurant: "food",
  vietnamese_restaurant: "food",
  korean_restaurant: "food",
  american_restaurant: "food",
  mediterranean_restaurant: "food",
  middle_eastern_restaurant: "food",
  brunch_restaurant: "food",
  breakfast_restaurant: "food",
  vegetarian_restaurant: "food",
  vegan_restaurant: "food",
  tea_house: "food",
  juice_shop: "food",
  dessert_shop: "food",
  donut_shop: "food",
  park: "outdoor",
  playground: "outdoor",
  hiking_area: "outdoor",
  national_park: "outdoor",
  garden: "outdoor",
  dog_park: "outdoor",
  campground: "outdoor",
  museum: "museum",
  art_gallery: "museum",
  movie_theater: "entertainment",
  bowling_alley: "entertainment",
  amusement_park: "entertainment",
  aquarium: "entertainment",
  zoo: "entertainment",
  performing_arts_theater: "entertainment",
  night_club: "entertainment",
  spa: "wellness",
  gym: "wellness",
  yoga_studio: "wellness",
  shopping_mall: "shopping",
  clothing_store: "shopping",
  book_store: "shopping",
  gift_shop: "shopping",
  library: "museum",
  community_center: "entertainment",
  swimming_pool: "outdoor",
  water_park: "outdoor",
  farmers_market: "outdoor",
  escape_room: "entertainment",
  karaoke: "entertainment",
  miniature_golf: "entertainment",
  go_kart_track: "entertainment",
  batting_cage: "entertainment",
};

// ---------------------------------------------------------------------------
// City detection from address
// ---------------------------------------------------------------------------

/** Maps a formatted address to one of our city slugs */
function detectCity(address) {
  const addr = address.toLowerCase();
  for (const city of CITIES) {
    // Match "Campbell, CA" or "Campbell," in the address
    if (addr.includes(city.name.toLowerCase() + ",")) return city.slug;
  }
  // Fallback: check if any city name appears
  for (const city of CITIES) {
    if (addr.includes(city.name.toLowerCase())) return city.slug;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hours parsing
// ---------------------------------------------------------------------------

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

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

// ---------------------------------------------------------------------------
// API fetch with retry
// ---------------------------------------------------------------------------

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function searchPlaces(textQuery, city, pageToken = null) {
  const body = {
    textQuery,
    pageSize: 20,
    languageCode: "en",
    locationBias: {
      circle: {
        center: { latitude: city.lat, longitude: city.lng },
        radius: 8000.0, // 8km radius
      },
    },
  };
  if (pageToken) body.pageToken = pageToken;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(TEXT_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": API_KEY,
          "X-Goog-FieldMask": FIELD_MASK + ",nextPageToken",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 429) {
        console.warn(`  ⚠️  Rate limited, waiting ${2 ** attempt * 2}s...`);
        await sleep(2 ** attempt * 2000);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        console.error(`  ❌ API error ${res.status}: ${text.slice(0, 200)}`);
        return { places: [], nextPageToken: null };
      }

      const data = await res.json();
      return {
        places: data.places || [],
        nextPageToken: data.nextPageToken || null,
      };
    } catch (err) {
      if (attempt < 2) {
        console.warn(`  ⚠️  Fetch error, retrying... (${err.message})`);
        await sleep(1000);
      } else {
        console.error(`  ❌ Failed after 3 attempts: ${err.message}`);
        return { places: [], nextPageToken: null };
      }
    }
  }
  return { places: [], nextPageToken: null };
}

// ---------------------------------------------------------------------------
// Load curated POIs for merge
// ---------------------------------------------------------------------------

function loadCuratedPOIs() {
  // Read the TypeScript source and extract POI data manually
  // We parse the essentials: id, title, city, category, why, featuredPlace, etc.
  const poiPath = join(REPO_ROOT, "src", "data", "south-bay", "poi-data.ts");
  const src = readFileSync(poiPath, "utf-8");

  const pois = [];
  // Match each object block in SOUTH_BAY_POIS array
  const objRegex = /\{\s*\n([\s\S]*?)\n\s*\}/g;
  const arrayStart = src.indexOf("export const SOUTH_BAY_POIS");
  if (arrayStart === -1) return pois;

  const arrayContent = src.slice(arrayStart);
  let match;
  while ((match = objRegex.exec(arrayContent)) !== null) {
    const block = match[1];
    const get = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(?:"([^"]*?)"|'([^']*?)'|(\w+))`));
      return m ? (m[1] ?? m[2] ?? m[3]) : null;
    };
    const getBool = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(true|false)`));
      return m ? m[1] === "true" : null;
    };
    const getArray = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*\\[([^\\]]*?)\\]`));
      if (!m) return [];
      return m[1].match(/"([^"]*?)"/g)?.map((s) => s.replace(/"/g, "")) ?? [];
    };

    const id = get("id");
    if (!id) continue;

    pois.push({
      id: `curated:${id}`,
      name: get("title"),
      city: get("city"),
      category: get("category"),
      venue: get("venue"),
      why: get("why"),
      featuredPlace: get("featuredPlace"),
      kidFriendly: getBool("kidFriendly"),
      indoorOutdoor: get("indoorOutdoor"),
      bestSlots: getArray("bestSlots"),
      cost: get("cost"),
      costNote: get("costNote"),
      emoji: get("emoji"),
      url: get("url"),
      curated: true,
    });
  }
  return pois;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("🗺️  South Bay Today — Places Data Pool Generator");
  console.log(`   ${CITIES.length} cities × ${CATEGORIES.length} categories = ${CITIES.length * CATEGORIES.length} queries\n`);

  const seen = new Map(); // Google place ID → place object
  const warnings = [];
  let requestCount = 0;

  for (const city of CITIES) {
    console.log(`📍 ${city.name}`);

    for (const cat of CATEGORIES) {
      const textQuery = `${cat.query} in ${city.name}, CA`;
      process.stdout.write(`   🔍 ${cat.query}...`);

      let pageToken = null;
      let pageCount = 0;
      let addedThisQuery = 0;

      do {
        const result = await searchPlaces(textQuery, city, pageToken);
        requestCount++;

        for (const place of result.places) {
          const placeId = place.id;
          if (!placeId || seen.has(placeId)) continue;

          const rating = place.rating ?? 0;
          const ratingCount = place.userRatingCount ?? 0;

          // Quality filter
          if (rating < MIN_RATING || ratingCount < MIN_RATINGS_COUNT) continue;

          // Detect city from address
          const detectedCity = detectCity(place.formattedAddress || "");
          // Must be in one of our cities
          if (!detectedCity) continue;

          // Map category
          const primaryType = place.primaryType || "";
          const category = TYPE_TO_CATEGORY[primaryType] || cat.ourCat;

          const entry = {
            id: placeId,
            name: place.displayName?.text || "Unknown",
            address: place.formattedAddress || "",
            city: detectedCity,
            lat: place.location?.latitude ?? null,
            lng: place.location?.longitude ?? null,
            rating,
            ratingCount,
            priceLevel: place.priceLevel || null,
            types: place.types || [],
            primaryType: primaryType || null,
            category,
            hours: parseHours(place.regularOpeningHours),
            url: place.websiteUri || null,
            mapsUrl: place.googleMapsUri || null,
            photoRef: place.photos?.[0]?.name || null,
            curated: false,
          };

          seen.set(placeId, entry);
          addedThisQuery++;
        }

        pageToken = result.nextPageToken;
        pageCount++;
        if (pageToken) await sleep(REQUEST_DELAY_MS);
      } while (pageToken && pageCount < MAX_PAGES_PER_QUERY);

      process.stdout.write(` ${addedThisQuery} new\n`);
      await sleep(REQUEST_DELAY_MS);
    }
    console.log();
  }

  // ---------------------------------------------------------------------------
  // Merge curated POIs
  // ---------------------------------------------------------------------------

  console.log("📎 Merging curated POIs from poi-data.ts...");
  const curatedPOIs = loadCuratedPOIs();
  let curatedCount = 0;

  for (const poi of curatedPOIs) {
    // Try to match to an existing Google place by name + city
    const normalizedName = poi.name?.toLowerCase().replace(/[^a-z0-9]/g, "") || "";
    let matched = false;

    for (const [placeId, place] of seen) {
      const placeName = place.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (placeName === normalizedName && place.city === poi.city) {
        // Enrich the Google result with curated fields
        place.curated = true;
        place.curatedId = poi.id;
        if (poi.why) place.why = poi.why;
        if (poi.featuredPlace) place.featuredPlace = poi.featuredPlace;
        if (poi.kidFriendly !== null) place.kidFriendly = poi.kidFriendly;
        if (poi.indoorOutdoor) place.indoorOutdoor = poi.indoorOutdoor;
        if (poi.bestSlots?.length) place.bestSlots = poi.bestSlots;
        if (poi.cost) place.cost = poi.cost;
        if (poi.costNote) place.costNote = poi.costNote;
        if (poi.emoji) place.emoji = poi.emoji;
        matched = true;
        curatedCount++;
        break;
      }
    }

    if (!matched) {
      // Add curated POI directly (no Google match)
      seen.set(poi.id, {
        id: poi.id,
        name: poi.name,
        address: poi.venue || "",
        city: poi.city,
        lat: null,
        lng: null,
        rating: null,
        ratingCount: null,
        priceLevel: null,
        types: [],
        primaryType: null,
        category: poi.category || "outdoor",
        hours: null,
        url: poi.url || null,
        mapsUrl: null,
        curated: true,
        curatedId: poi.id,
        why: poi.why || null,
        featuredPlace: poi.featuredPlace || null,
        kidFriendly: poi.kidFriendly ?? null,
        indoorOutdoor: poi.indoorOutdoor || null,
        bestSlots: poi.bestSlots || [],
        cost: poi.cost || null,
        costNote: poi.costNote || null,
        emoji: poi.emoji || null,
      });
      curatedCount++;
    }
  }

  // ---------------------------------------------------------------------------
  // Sort and write output
  // ---------------------------------------------------------------------------

  const allPlaces = [...seen.values()].sort((a, b) => {
    // Sort by city, then category, then rating desc
    if (a.city !== b.city) return a.city.localeCompare(b.city);
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return (b.rating || 0) - (a.rating || 0);
  });

  // City distribution stats
  const cityStats = {};
  const catStats = {};
  for (const p of allPlaces) {
    cityStats[p.city] = (cityStats[p.city] || 0) + 1;
    catStats[p.category] = (catStats[p.category] || 0) + 1;
  }

  const output = {
    _meta: generatorMeta("generate-places", {
      sourceCount: allPlaces.length,
      sources: ["Google Places API (New) Text Search", "poi-data.ts (curated)"],
      warnings: warnings.length ? warnings : undefined,
    }),
    stats: {
      total: allPlaces.length,
      curated: curatedCount,
      googleOnly: allPlaces.length - curatedCount,
      byCity: cityStats,
      byCategory: catStats,
      apiRequests: requestCount,
    },
    places: allPlaces,
  };

  const outPath = join(DATA_DIR, "places.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log("✅ Done!");
  console.log(`   Total places: ${allPlaces.length}`);
  console.log(`   Curated:      ${curatedCount} (${curatedPOIs.length} POIs, ${curatedCount} merged)`);
  console.log(`   API requests:  ${requestCount}`);
  console.log(`\n   By city:`);
  for (const [city, count] of Object.entries(cityStats).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${city.padEnd(16)} ${count}`);
  }
  console.log(`\n   By category:`);
  for (const [cat, count] of Object.entries(catStats).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${cat.padEnd(16)} ${count}`);
  }
  console.log(`\n   Written to: ${outPath}`);
}

main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
