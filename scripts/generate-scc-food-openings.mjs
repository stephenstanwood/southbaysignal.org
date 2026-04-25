#!/usr/bin/env node
/**
 * generate-scc-food-openings.mjs
 *
 * Fetches restaurant permit data from Santa Clara County DEH Plan Check Progress API
 * to surface newly opened and coming-soon food businesses across the South Bay.
 *
 * Data source: data.sccgov.org resource skd7-7ix3 (SCC Plan Check Progress)
 * robots.txt at data.sccgov.org: permissive, SODA API (/resource/*) fully open.
 *
 * Run: node scripts/generate-scc-food-openings.mjs
 */

import { writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnvLocal } from "./lib/env.mjs";

loadEnvLocal();

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "scc-food-openings.json");

const API_BASE = "https://data.sccgov.org/resource/skd7-7ix3.json";
const LOOKBACK_DAYS = 45;
const LOOKBACK_DATE = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().split("T")[0];

// Cities we care about (South Bay). SCC data uses uppercase city names.
const SOUTH_BAY_CITIES = new Set([
  "SAN JOSE", "MOUNTAIN VIEW", "SUNNYVALE", "SANTA CLARA", "CUPERTINO",
  "MILPITAS", "CAMPBELL", "SARATOGA", "LOS GATOS", "LOS ALTOS", "PALO ALTO",
  "LOS CATOS", // occasional typo in SCC data for Los Gatos
]);

// Patterns that indicate non-restaurant entries to skip
const SKIP_PATTERNS = /\bPOOL\b|ELEM\b|SCHOOL\b|APTS\b|HOMEOWNER|MICRO KITCHEN|MODERNIZATION|MFF\b|MOBILE FOOD\b|CART\b|COMMISSARY\b|VENDING|\bCAFETERIA\b|PANTRY\b.*LEVEL|CORPORATE|EXTERIOR STORAGE|BARISTA AREA|COFFEE AREA|KITCHEN UNIT|BEVERAGE UNIT|AIRPORT BLVD|SJC AIRPORT|PLTR#|\bPRO SHOP\b|\bSPA\b|\bHOT TUB\b|\bAPT\s+SPA\b|APARTMENT\s+SPA|PARK\s+SPA\b|BREAKROOM|BREAK\s+ROOM|NSVC\s+B\d|EMPLOYEE\s+LOUNGE/i;

// Corporate campus patterns — office cafeterias aren't public restaurants
const CORPORATE_PATTERNS = /\b(GOOGLE|APPLE|FACEBOOK|META|INTEL|CISCO|NVIDIA|WAYMO|MICROSOFT|AMAZON|LINKEDIN|TWITTER|SERVICENOW|PALO ALTO NETWORKS|VMW|BROADCOM|ADOBE|WALMART)\b/i;

// Gas station brands — convenience stores at gas stations aren't restaurant openings
const GAS_STATION_PATTERNS = /\b(SHELL|CHEVRON|ARCO|MOBIL|EXXON|VALERO|BP|CIRCLE K|76 GAS|TEXACO|SINCLAIR|SUNOCO|MARATHON|PHILLIPS 66|LOVE'S|PILOT)\b/i;

// Patterns for names that need more cleanup
const TENANT_IMPROVEMENT_PATTERN = /tenant improvement|TENANT IMPROV/i;

// Manual blurb overrides keyed by sourceId — these survive AI regeneration
// Use when AI-generated blurbs are generic or when we have specific local knowledge
const BLURB_OVERRIDES = {
  "SR0879467": "Wine bar from the team behind The Winery — 250-bottle program, live music nightly, heated patio.",
  "SR0883252": "Popular Yemeni coffee chain expanding to downtown San Jose — cardamom-spiced brews and pastries.",
  "SR0883251": "Yemeni coffee and pastries in downtown San Jose — mezzanine-level location at 1 E San Fernando St.",
  "SR0880573": "Molly Tea opening a second South Bay location at Rivermark Plaza in Santa Clara.",
  "SR0884317": "Molly Tea's Stevens Creek location — bubble tea and snacks in Cupertino's Stevens Creek corridor.",
  // April 2026 opened
  "SR0880717": "Dairy Queen opens on S Winchester Blvd in Campbell — ice cream, Blizzards, and fast food.",
  "SR0880767": "Dough Zone opens at 1875 S Bascom Ave in Campbell — Taiwanese dumplings and buns, second South Bay location.",
  "SR0878726": "T&T Supermarket — a major Canadian Asian grocery chain — opens its Westgate Mall location, bringing fresh produce, seafood, and imported Asian goods to West San Jose.",
  "SR0884181": "Health-focused cafe and restaurant inside Bay Club Santa Clara — smoothies, salads, and fresh meals for members and guests.",
  "SR0876717": "Ramen and Japanese comfort food at 180 S. Market St in downtown San Jose.",
  "SR0877677": "Filipino fast-food chain known for Chickenjoy fried chicken and Jolly Spaghetti — new South San Jose location.",
  "SR0882706": "New Cupertino Whole Foods at 20955 Stevens Creek Blvd — long-awaited grocery anchor for the Stevens Creek corridor.",
  "SR0882358": "New Milpitas location for the popular chicken sandwich chain at 755 E Calaveras Blvd.",
  "SR0882635": "North Indian sweets, snacks, and vegetarian food from the century-old New Delhi-based chain — first Sunnyvale location.",
  "SR0883358": "Robotic smoothie kiosk at Grant Rd and El Camino Real in Mountain View.",
  "SR0883588": "Korean braised pork knuckle specialist at El Camino Real in Santa Clara.",
  "SR0876718": "Boba tea and Japanese-inspired drinks near South First Street in downtown San Jose.",
  "SR0883940": "Coffee and tea shop at S Winchester Blvd in San Jose's Cambrian neighborhood.",
  "SR0882015": "Modern brunch bistro from Bloom Eatery (Santa Clara) — inventive breakfast dishes, hearty lunches, and seasonal cocktails in downtown San Jose.",
  "SR0879599": "Taiwanese tea and light food in Milpitas.",
  "SR0884051": "Boba tea shop at San Antonio Rd in Mountain View.",
  // Coming soon — April 2026
  "SR0884326": "Pizza shop coming to Alum Rock Ave in East San Jose.",
  "SR0884064": "Boba tea shop coming to Camden Ave in South San Jose.",
  "SR0884383": "Grocery Outlet discount grocery — coming to Homestead Rd in Santa Clara.",
  "SR0884339": "Heytea — a popular Chinese tea chain known for fresh fruit teas — opening at Barber Ln in Milpitas.",
  "SR0884243": "Toastique — upscale avocado toast and cold-pressed juice bar — opening downtown San Jose on W Santa Clara St.",
  "SR0880648": "Crepe Shibuya — Japanese-style street crepes — coming to Ranch Dr in Milpitas.",
  "SR0880855": "Johnny Donuts coming to Santana Row area — handcrafted doughnuts and coffee at Olin Ave.",
  "SR0883952": "Chama Nativa Brazilian Steakhouse — rodizio churrasco with tableside carving service — opening on Blossom Hill Rd in San Jose.",
  "SR0884604": "Sushi restaurant opening at 15650 Los Gatos Blvd in Los Gatos.",
  "SR0880082": "Seafood restaurant focusing on crab dishes — coming to 625 Coleman Ave in San Jose.",
  "SR0884303": "Boba tea shop opening at De Anza Blvd in Cupertino's shopping district.",
  "SR0884106": "Japanese restaurant opening at 10445 S De Anza Blvd in Cupertino.",
  "SR0884217": "Breakfast and brunch spot at 545 San Antonio Rd in Mountain View.",
  "SR0879164": "Seafood restaurant at E Calaveras Blvd in Milpitas.",
  "SR0884293": "Classic American BBQ chain with smoked meats — returning to San Jose at 61 Curtner Ave.",
  "SR0883509": "Tisane tea house opening a new location at 2980 E Capitol Expwy in San Jose.",
};

// Source IDs to explicitly skip — non-public venues, existing restaurants with equipment-only permits, etc.
const SOURCE_ID_SKIP = new Set([
  "SR0881556", // Palo Alto Central — apartment complex amenity kitchen, not a public restaurant
  "SR0884332", // XPP Claypot — existing restaurant at 20950 Stevens Creek; permit is for new equipment only
  "SR0883385", // SAP Center Phase Concession — arena concession permit, not a public restaurant opening
  "SR0883386", // SAP Center South Concourse Bar — arena bar permit, not a public restaurant opening
  "SR0883387", // SAP Center Press Box Kitchenette — arena internal kitchen, not a public restaurant opening
  "SR0883017", // Villa Sport Fitness - Whirlpool #1 — gym equipment permit, not a food opening
  "SR0883020", // Villa Sport Fitness - Whirlpool #2 — gym equipment permit, not a food opening
  "SR0879553", // Autochlor Dishwasher — commercial dishwasher service company, not a restaurant
  "SR0883371", // Byte Coolers (Terminal B) — airport terminal concession, not a public SB restaurant
  "SR0883372", // Byte Coolers (Terminal B) — airport terminal concession, not a public SB restaurant
  "SR0884107", // Indoor Food Facility For Cbre — corporate cafeteria at 4353 N First St, not public
  "SR0881676", // Walmart Nsvc B4 Breakrooms — employee break rooms at Walmart, not a public restaurant
  "SR0883046", // Life Time Fitness - Santana Row — gym with internal food facility, not a standalone restaurant
]);

// Map city names to our city IDs
const CITY_ID_MAP = {
  "SAN JOSE": "san-jose",
  "MOUNTAIN VIEW": "mountain-view",
  "SUNNYVALE": "sunnyvale",
  "SANTA CLARA": "santa-clara",
  "CUPERTINO": "cupertino",
  "MILPITAS": "milpitas",
  "CAMPBELL": "campbell",
  "SARATOGA": "saratoga",
  "LOS GATOS": "los-gatos",
  "LOS CATOS": "los-gatos", // typo
  "LOS ALTOS": "los-altos",
  "PALO ALTO": "palo-alto",
};

/**
 * Clean a business name:
 * - Strip leading "E-" (electronic submission prefix)
 * - Strip trailing permit artifact suffixes (e.g., "- 3 Comp Sink Install", "- TI")
 * - Title case
 * - Trim trailing generic suffixes like "TENANT IMPROVEMENT"
 */
function cleanName(raw) {
  if (!raw) return null;
  let s = raw.trim();

  // Strip electronic submission prefix
  s = s.replace(/^E-\s*/i, "").trim();

  // If the whole thing is a generic tenant improvement placeholder, return null
  if (/^(RESTAURANT\s+)?TENANT\s+IMPR(OVEMENT)?(\s+\d+)?$/i.test(s)) return null;

  // Strip trailing permit artifact suffixes like "- 3 Comp Sink Install", "- TI", "- Remodel", "- Hood Install"
  s = s.replace(/\s+-\s+\d+\s+Comp\s+Sink.*$/i, "").trim();
  s = s.replace(/\s+-\s+(TI|Remodel|Hood\s+Install|Plumbing|Electrical|Fire\s+Suppression|Grease\s+Trap|Ansul|Ventilation|Sprinkler|Build[-\s]?Out|Buildout|Renovation|Expansion|Addition|Alteration|Conversion|New\s+Construction|Plan\s+Check|Permit|Install|Upgrade|Oil\s+Tank|Grease\s+Tank|Underground\s+Tank|Tank\s+Install|Tank\s+Removal|Tank\s+Replace|Lvl|Level|Lgt|Light|Concession(\s+\w+)?)(\s+\d+)?$/i, "").trim();

  // Strip trailing equipment-only descriptors without dash separator (e.g. "Chick Fil A Oil Tank")
  s = s.replace(/\s+(Oil\s+Tank|Grease\s+Tank|Underground\s+Tank|Tank\s+Install|Tank\s+Removal|Grease\s+Trap\s+Install|Hood\s+Install|Ansul\s+System|Fire\s+Suppression\s+System|Minor\s+Equipment\s+Change|Machine\s+Replacement|Equipment\s+Change|Equipment\s+Replacement|Equipment\s+Install|Equipment\s+Upgrade|New\s+Equipment|Lgt|Light\s+Equipment|New\s+Build)\s*$/i, "").trim();

  // Strip "Phase [noun]" permit phase descriptors (e.g. "Phase Concession", "Phase 1 Construction")
  s = s.replace(/\s+Phase\s+(Concession|Construction|Renovation|Buildout|Build\s*Out|Install|Equipment|Remodel|Plumbing)\s*$/i, "").trim();

  // Strip " At [Venue City]" location descriptors — e.g. "Blendid At City Sports Mountain View"
  // These appear when a kiosk is located inside another business
  s = s.replace(/\s+At\s+.+\b(San Jose|Palo Alto|Mountain View|Sunnyvale|Santa Clara|Cupertino|Milpitas|Campbell|Saratoga|Los Gatos|Los Altos)\b.*$/i, "").trim();

  // Strip trailing address-like suffixes ("4120" at end)
  s = s.replace(/\s+\d+\s*$/, "").trim();

  // Strip parenthetical garbage (airport permit codes, unit numbers embedded in name)
  s = s.replace(/\s*\(Unit\s+[A-Z0-9-]+[^)]*\)/gi, "").trim();
  s = s.replace(/\s*\([^)]*(?:Pltr|Airport|Terminal)[^)]*\)/gi, "").trim();

  // If name still contains "Tenant Improvement" (wasn't caught above), skip
  if (/tenant improv/i.test(s)) return null;

  // Title case
  s = s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bLlc\b/g, "LLC")
    .replace(/\bInc\b/g, "Inc.")
    .replace(/\bBbq\b/g, "BBQ")
    .replace(/\bDba\b/g, "dba")
    // Fix apostrophe title-case: "Ralph'S" → "Ralph's"
    .replace(/'(\w)/g, (_, c) => `'${c.toLowerCase()}`)
    .replace(/^(\w)/, (c) => c.toUpperCase());

  return s || null;
}

/**
 * Clean and shorten an address to just the street portion.
 */
function cleanAddress(raw) {
  if (!raw) return null;
  let s = raw.trim();

  // Remove everything after the street address (city, state, zip)
  // Pattern: "1234 MAIN ST., CITY, CA ZIPCODE" → "1234 Main St."
  const commaIdx = s.search(/,\s*[A-Z ]+,?\s*CA/i);
  if (commaIdx > 0) s = s.slice(0, commaIdx);

  s = s.trim().replace(/\s+/g, " ");

  // Title case
  s = s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bBl\b/g, "Blvd")
    .replace(/\bAv\b/g, "Ave")
    .replace(/\bSt\b/g, "St.")
    .replace(/\bRd\b/g, "Rd.")
    .replace(/\bDr\b/g, "Dr.")
    .replace(/\bCt\b/g, "Ct.")
    .replace(/\bCi\b/g, "Cir.")
    .replace(/\bEx\b/g, "Expwy")
    .replace(/\bWy\b/g, "Way")
    .replace(/\bSte\b/g, "Ste.")
    .replace(/\bFc-\d+/i, "")
    .replace(/\bUnit\s+Tbd\b/gi, "")
    .replace(/\bUnit\s+Nc-[\w,\s]+$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,]+$/, "");

  return s || null;
}

// Pure legal entity names (no real business descriptor) — e.g. "Sp Social LLC", "Umesjoakland Inc."
const BARE_ENTITY_PATTERN = /^[A-Za-z0-9&'\s]{1,30}\s+(LLC|Inc\.|Inc|Corp\.|Corp|Ltd\.|Ltd|L\.L\.C\.|L\.L\.P\.|LLP|Co\.)$/i;

// Non-food establishments that sometimes appear in health permit data (law firms, spas, etc.)
const NON_FOOD_PATTERNS = /\b(LLP|L\.L\.P\.)\b|\bATTORNEY|BARRISTERS|SOLICITORS|\bLAW\s+(OFFICES?|GROUP|FIRM)\b/i;

function shouldSkip(item) {
  const name = item.business_name ?? "";
  const rawName = name.replace(/^E-\s*/i, "").trim();

  if (item.record_id && SOURCE_ID_SKIP.has(item.record_id)) return true;
  if (SKIP_PATTERNS.test(name)) return true;
  if (CORPORATE_PATTERNS.test(rawName)) return true;
  if (NON_FOOD_PATTERNS.test(rawName)) return true;
  if (GAS_STATION_PATTERNS.test(rawName)) return true;

  // Skip entries with no city or city outside South Bay
  const city = (item.city ?? "").toUpperCase();
  if (!SOUTH_BAY_CITIES.has(city)) return true;

  // Skip if cleaned name is null (generic TI placeholder)
  const cleaned = cleanName(name);
  if (!cleaned) return true;

  // Skip pure legal entity names with no real business descriptor
  // e.g. "Sp Social LLC", "Umesjoakland Inc." — no actual restaurant name
  if (BARE_ENTITY_PATTERN.test(cleaned)) {
    const wordsBeforeEntity = cleaned.replace(/\s+(LLC|Inc\.|Inc|Corp\.|Corp|Ltd\.|Ltd|L\.L\.C\.|Co\.)$/i, "").trim().split(/\s+/);
    if (wordsBeforeEntity.length <= 2) return true;
  }

  return false;
}

/**
 * Generate one-line blurbs for a list of recently opened restaurants using Claude Haiku.
 * Returns a map of item id → blurb string.
 */
async function generateBlurbs(items) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || items.length === 0) return {};

  const client = new Anthropic({ apiKey });
  const list = items.map((i) => `- ${i.name} at ${i.address ?? "unknown address"}, ${i.cityName}`).join("\n");

  const prompt = `You are a local journalist writing one-line descriptions for a South Bay residents' news site.

For each newly opened restaurant below, write one concise factual sentence (max 12 words) describing what kind of food or experience it offers. Focus on cuisine type, chain background, or what makes it distinctive. No exclamation points, no hype. Don't start with the restaurant name.

Examples of good blurbs:
- "Filipino chain known for Chickenjoy fried chicken, now in South San Jose."
- "Korean braised pork knuckle specialist on El Camino Real."
- "Robotic smoothie kiosk at Grant Rd and El Camino Real."

Restaurants:
${list}

Respond with a JSON array of objects with "name" and "blurb" fields only. No markdown, no explanation.`;

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    let text = msg.content[0]?.text ?? "[]";
    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(text);
    const map = {};
    for (const entry of parsed) {
      const match = items.find((i) => i.name === entry.name);
      if (match) map[match.id] = entry.blurb;
    }
    return map;
  } catch (err) {
    console.warn("Blurb generation failed:", err.message);
    return {};
  }
}

/**
 * Generate anticipation-style blurbs for coming-soon restaurants using Claude Haiku.
 * Returns a map of item id → blurb string.
 */
async function generateComingSoonBlurbs(items) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || items.length === 0) return {};

  const client = new Anthropic({ apiKey });
  const list = items.map((i) => `- ${i.name} at ${i.address ?? "unknown address"}, ${i.cityName}`).join("\n");

  const prompt = `You are a local journalist writing one-line descriptions for a South Bay residents' news site.

For each "coming soon" restaurant below, write one concise factual sentence (max 12 words) describing what kind of food or experience it will offer. Focus on cuisine type, chain background, or location context. No exclamation points, no hype. Don't start with the restaurant name.

Examples of good blurbs:
- "BBQ chain with smoked ribs and wings, opening on Curtner Ave."
- "Breakfast and brunch spot coming to San Antonio Rd in Mountain View."
- "Sushi restaurant opening on Los Gatos Blvd."

Restaurants:
${list}

Respond with a JSON array of objects with "name" and "blurb" fields only. No markdown, no explanation.`;

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    let text = msg.content[0]?.text ?? "[]";
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(text);
    const map = {};
    for (const entry of parsed) {
      const match = items.find((i) => i.name === entry.name);
      if (match) map[match.id] = entry.blurb;
    }
    return map;
  } catch (err) {
    console.warn("Coming-soon blurb generation failed:", err.message);
    return {};
  }
}

async function fetchPage(whereClause, orderField, limit = 50) {
  const params = new URLSearchParams({
    $where: whereClause,
    $order: `${orderField} DESC`,
    $limit: limit.toString(),
  });
  const url = `${API_BASE}?${params}`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "southbaysignal.org/data-pipeline" },
  });
  if (!res.ok) throw new Error(`SCC API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log("Fetching SCC restaurant permit data…\n");

  // --- Recently opened: passed final inspection in last LOOKBACK_DAYS days ---
  const openedRaw = await fetchPage(
    `final_inspection > '${LOOKBACK_DATE}T00:00:00.000'`,
    "final_inspection",
    100,
  );

  // SCC final_inspection fires for re-inspections too (renovations, ownership
  // changes, annual recerts) — not just new businesses. Brand-new restaurants
  // typically clear plan check → final in 3–6 months; anything dragging past
  // ~150 days is almost always a remodel of an existing business. Dropped a
  // long-standing Dairy Queen Campbell as "just opened" before this filter.
  const RENOVATION_THRESHOLD_DAYS = 150;
  const isLikelyRenovation = (item) => {
    if (!item.received_date || !item.final_inspection) return false;
    const elapsed = (new Date(item.final_inspection) - new Date(item.received_date)) / 86400000;
    return elapsed > RENOVATION_THRESHOLD_DAYS;
  };
  const renovationDrops = openedRaw.filter(isLikelyRenovation).length;
  if (renovationDrops > 0) {
    console.log(`  Dropped ${renovationDrops} likely-renovation record(s) (>${RENOVATION_THRESHOLD_DAYS}d plan→final)`);
  }

  const opened = openedRaw
    .filter((item) => !shouldSkip(item))
    .filter((item) => !isLikelyRenovation(item))
    .map((item) => {
      const name = cleanName(item.business_name);
      if (!name) return null;
      const city = (item.city ?? "").toUpperCase();
      return {
        id: `opened-${item.record_id ?? item.business_name?.toLowerCase().replace(/\W+/g, "-")}`,
        name,
        address: cleanAddress(item.site_location),
        cityId: CITY_ID_MAP[city] ?? null,
        cityName: city,
        date: item.final_inspection?.slice(0, 10) ?? null,
        status: "opened",
        sourceId: item.record_id ?? null,
      };
    })
    .filter(Boolean);

  // Deduplicate by address (same address can have multiple units in same building)
  const seenAddresses = new Set();
  const openedDeduped = opened.filter((item) => {
    const key = `${item.cityId}:${item.address?.toLowerCase()}`;
    if (seenAddresses.has(key)) return false;
    seenAddresses.add(key);
    return true;
  });

  // --- Coming soon: plan approved but no final inspection yet ---
  const comingSoonRaw = await fetchPage(
    `date_plan_approved > '${LOOKBACK_DATE}T00:00:00.000' AND final_inspection IS NULL`,
    "date_plan_approved",
    100,
  );

  const comingSoon = comingSoonRaw
    .filter((item) => !shouldSkip(item))
    .map((item) => {
      const name = cleanName(item.business_name);
      if (!name) return null;
      const city = (item.city ?? "").toUpperCase();
      return {
        id: `soon-${item.record_id ?? item.business_name?.toLowerCase().replace(/\W+/g, "-")}`,
        name,
        address: cleanAddress(item.site_location),
        cityId: CITY_ID_MAP[city] ?? null,
        cityName: city,
        date: item.date_plan_approved?.slice(0, 10) ?? null,
        status: "coming-soon",
        sourceId: item.record_id ?? null,
      };
    })
    .filter(Boolean);

  // Deduplicate coming soon by address
  const seenComing = new Set();
  const comingSoonDeduped = comingSoon.filter((item) => {
    const key = `${item.cityId}:${item.address?.toLowerCase()}`;
    if (seenComing.has(key)) return false;
    seenComing.add(key);
    return true;
  });

  // Remove items from coming-soon that are already in opened
  const openedAddresses = new Set(openedDeduped.map((i) => `${i.cityId}:${i.address?.toLowerCase()}`));
  const comingSoonFinal = comingSoonDeduped.filter(
    (i) => !openedAddresses.has(`${i.cityId}:${i.address?.toLowerCase()}`),
  );

  // Generate blurbs for top opened restaurants
  const topOpened = openedDeduped.slice(0, 12);
  console.log("Generating blurbs for opened restaurants…");
  const blurbs = await generateBlurbs(topOpened);

  const openedWithBlurbs = openedDeduped.slice(0, 12).map((i) => ({
    ...i,
    blurb: (i.sourceId && BLURB_OVERRIDES[i.sourceId]) ?? blurbs[i.id] ?? null,
  }));

  // Generate anticipation blurbs for top coming-soon restaurants
  const topComingSoon = comingSoonFinal.slice(0, 12);
  console.log("Generating blurbs for coming-soon restaurants…");
  const comingSoonBlurbs = await generateComingSoonBlurbs(topComingSoon);

  const comingSoonWithBlurbs = comingSoonFinal.slice(0, 12).map((i) => ({
    ...i,
    blurb: (i.sourceId && BLURB_OVERRIDES[i.sourceId]) ?? comingSoonBlurbs[i.id] ?? null,
  }));

  const output = {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    sourceUrl: "https://data.sccgov.org/resource/skd7-7ix3",
    opened: openedWithBlurbs,
    comingSoon: comingSoonWithBlurbs,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

  console.log(`✅ ${openedDeduped.length} recently opened, ${comingSoonFinal.length} coming soon → scc-food-openings.json`);
  console.log("\nRecently opened:");
  openedDeduped.slice(0, 8).forEach((i) => console.log(`  [${i.date}] ${i.name} — ${i.address}, ${i.cityName}`));
  console.log("\nComing soon:");
  comingSoonFinal.slice(0, 8).forEach((i) => console.log(`  [${i.date}] ${i.name} — ${i.address}, ${i.cityName}`));
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
