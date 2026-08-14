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

import { readFileSync, existsSync } from "fs";
import { writeFileAtomic } from "./lib/io.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnvLocal } from "./lib/env.mjs";
import { catSignal } from "./lib/notify.mjs";
import {
  classifyFinalInspection,
  isAddressDerivedBusinessName,
  isVerifiedOpeningRecord,
  normalizeSouthBayAddress,
} from "./lib/scc-food-openings.mjs";
import { lookupVenuePhoto } from "../src/lib/south-bay/eventImages.mjs";

loadEnvLocal();

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "scc-food-openings.json");
const PHOTO_CACHE_PATH = join(__dirname, "..", "src", "data", "south-bay", "scc-food-photo-cache.json");
const IMAGE_CACHE_PATH = join(__dirname, "..", "src", "data", "south-bay", "scc-food-image-cache.json");

const API_BASE = "https://data.sccgov.org/resource/skd7-7ix3.json";
const LOOKBACK_DAYS = 45;
const LOOKBACK_DATE = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().split("T")[0];

// A final inspection is not an opening date. Only records in this map may
// enter the `opened` feed, and their date comes from the cited opening source.
const VERIFIED_OPENING_EVIDENCE = {
  SR0884792: {
    date: "2026-03-15",
    url: "https://www.instagram.com/p/DVz2HnDlNAJ/",
    source: "Fugetsu Market",
  },
};

// Cities we care about (South Bay). SCC data uses uppercase city names.
const SOUTH_BAY_CITIES = new Set([
  "SAN JOSE", "MOUNTAIN VIEW", "SUNNYVALE", "SANTA CLARA", "CUPERTINO",
  "MILPITAS", "CAMPBELL", "SARATOGA", "LOS GATOS", "LOS ALTOS", "PALO ALTO",
  "LOS CATOS", // occasional typo in SCC data for Los Gatos
]);

// Non-restaurant facilities that nonetheless hold a county food permit, so they
// arrive in the feed looking like openings. A padel club, a senior PACE health
// center, and an office landlord's barista bar all shipped to the food radar on
// 2026-08-13 as "coming soon" restaurants. Kept separate from SKIP_PATTERNS
// because these are whole business types, not permit-line descriptors.
const NON_RESTAURANT_FACILITY = /\bPADEL\b|\bPICKLEBALL\b|\bPACE\b|\bDIALYSIS\b|SKILLED\s+NURSING|\bURGENT\s+CARE\b|\bCLINIC\b|ASSISTED\s+LIVING/i;

// ...but only when nothing in the name says "this serves the public food".
// "Pace Pizzeria", "Clinic Cafe Bakery" and "Padel Thai Kitchen" are all
// plausible restaurant names that the acronyms above would otherwise eat.
const FOOD_BUSINESS_WORD =
  /\b(RESTAURANT|CAFE|CAFF?[EÉ]|COFFEE|BAKERY|PIZZ(?:A|ERIA)|KITCHEN|GRILL|TAQUER[IÍ]A|TACO|SUSHI|RAMEN|PHO|BOBA|TEA\s+HOUSE|JUICE|DELI|BBQ|BAR\s*&\s*GRILL|BISTRO|DINER|EATERY|CREAMERY|DONUTS?|SANDWICH|NOODLE|BUFFET\s+RESTAURANT)\b/i;

// Patterns that indicate non-restaurant entries to skip
const SKIP_PATTERNS = /BARISTA\s+BAR|BUFFET\s+TABLE|\bPOOLS?\b|ELEM\b|SCHOOL\b|\bAPTS?\b|\bHOA\b|HOMEOWNER|COMMUNITY\s+ASSOC|MICRO KITCHEN|MODERNIZATION|MFF\b|MOBILE FOOD\b|CART\b|COMMISSARY\b|VENDING|\bCAFETERIA\b|PANTRY\b.*LEVEL|\bPANTRY\s+ROOM\b|\bSTORAGE\s+PANTRY\b|\bLVL\s+\d|\bRELOCATION\b|CORPORATE|EXTERIOR STORAGE|BARISTA AREA|COFFEE AREA|KITCHEN UNIT|BEVERAGE UNIT|AIRPORT BLVD|SJC AIRPORT|PLTR#|\bPRO SHOP\b|\bSPA\b|\bHOT TUB\b|\bAPT\s+SPA\b|APARTMENT\s+SPA|PARK\s+SPA\b|BREAKROOM|BREAK\s+ROOM|NSVC\s+B\d|EMPLOYEE\s+LOUNGE|\bREPLASTER\b|\bENCLOSURE\b|\bBLDG\b|\bYMCA\b|\bMEETING\s+ROOM\b|\bHQ\d+\s+KITCHEN\b|\bFENCE\b|\bGATES?\b|\bSECURITY\b|\bALARM\b|\bSPRINKLER\b|\bRE-?ROOF\b|\bSIGNAGE\b|\bMONUMENT\s+SIGN\b|\bPARKING\s+(LOT|GARAGE|STRUCTURE)\b|\bELEVATOR\b|\bRETAINING\s+WALL\b|\bINNOVATION\s+CAMPUS\b|\b(?:1ST|2ND|3RD|\d+TH)\s+FLOOR\b/i;

// Equipment/maintenance-only permits — not openings, just upgrades to existing places.
// Anything matching here is a re-inspection of an existing facility, not a new business.
// "ADDING <equipment>" / "NEW HOOD" / "REFRIGERATION/RACK REPLACEMENT" are the
// same equipment-only filings in a phrasing the rules below missed, and they
// shipped as coming-soon restaurants ("Thermo Fisher - Adding Counter Top Oven",
// "Red Berry New Hood", "Wfm - Stc Refrigeration/Rack Replacement"). Note the
// slash separator — the "<equipment> REPLACEMENT" rule below requires a space.
const EQUIPMENT_ONLY_PATTERNS = /\bADD(?:ING|ITION\s+OF)\s+[\w\s]*\b(OVEN|GRIDDLE|FRYER|RANGE|STOVE|HOOD|WARMER|SINK|COOLER|FREEZER|DISHWASHER|ICE\s+MACHINE)S?\b|\bNEW\s+HOOD\b|\b(REFRIGERATION|HOOD|EXHAUST|PLUMBING|ELECTRICAL)\s*\/\s*\w+\s+(REPLACEMENT|REPAIR|UPGRADE)\b|\bRACK\s+REPLACEMENT\b|\bMOP\s+SINK\b|\bEQUIPMENT\s+(CHANGE|REPLACEMENT|INSTALL|UPGRADE|ADDITION)\b|\bUPDATED\s+KITCHEN\s+EQUIPMENT\b|\bKITCHEN\s+EQUIPMENT\b|\bMACHINE\s+(REPLACEMENT|INSTALL(?:ATION)?|CHANGE)\b|\b(SMOOTHIE|JUICE|ESPRESSO|COFFEE|DISH)\s+MACHINE\b|\bFREEZER[-\s]COOLER\b|\bWALK[-\s]IN\s+(COOLER|FREEZER)\b|\bOIL\s+TANK\b|\bGREASE\s+(TRAP|TANK|INTERCEPTOR)\b|\bUNDERGROUND\s+TANK\b|\bTANK\s+(INSTALL|REMOVAL|REPLACE)\b|\bHOOD\s+INSTALL\b|\bANSUL\s+SYSTEM\b|\bFIRE\s+SUPPRESSION\b|\bLIGHT(ING)?\s+(EQUIPMENT|REPLACEMENT|UPGRADE)\b|\bMINOR\s+EQUIPMENT\b|\bUNDERCOUNTER\b|\b(DISHWASHER|DISH\s*MACHINE|ICE\s+MACHINE|PREP\s+SINK)\s*$|\bEXPANSION\s*$|\bEXPANSION\b.*(EXISTING|OWNER)|\b(GRIDDLE|FRYER|RANGE|OVEN|WARMER|STOVE|REFRIGERATION|FREEZER|COOLER|DISHWASHER|HOOD|SINK|COUNTER|EXHAUST|PLUMBING|ELECTRICAL)S?\s+(UPDATE|MODIFICATION|REPAIR|REPLACEMENT|REMODEL)\b|\b(OVEN|GRIDDLE|FRYER|RANGE|STOVE|HOOD|WARMER|EQUIPMENT|KITCHEN)\s+ADDITION\b/i;

// Corporate campus patterns — office cafeterias aren't public restaurants.
// "JOHNSON & JOHNSON (AURIS HEALTH) 1ST FLOOR" shipped as a coming-soon
// restaurant; the floor-descriptor rule above now catches that shape too.
const CORPORATE_PATTERNS = /\b(GOOGLE(PLEX)?|APPLE|FACEBOOK|META|INTEL|CISCO|NVIDIA|WAYMO|MICROSOFT|AMAZON|LINKEDIN|TWITTER|SERVICENOW|PALO ALTO NETWORKS|VMW|BROADCOM|ADOBE|WALMART|YAHOO|SAMSUNG|DATABRICKS|JOHNSON\s*&\s*JOHNSON|AURIS\s+HEALTH)\b/i;

// Databricks Cityline office campus (200/250 W Washington Ave, Sunnyvale) —
// internal food facilities filed under building-code placeholder names
// ("B200 Cityline", "B250 Cityline Databricks - L2 Mk"), not public restaurants.
// SCC rotates the record ID on each re-filing (SR0883065→SR0883062,
// SR0883070→SR0883071), so a SOURCE_ID_SKIP entry can't keep up — match the
// "B### Cityline" building-code name instead. Real Cityline tenants brand
// themselves ("Philz", etc.), never "B### Cityline".
const CITYLINE_OFFICE_PATTERN = /\bB\d{2,3}\s+CITYLINE\b/i;

// Gas station brands — convenience stores at gas stations aren't restaurant openings
const GAS_STATION_PATTERNS = /\b(SHELL|CHEVRON|ARCO|MOBIL|EXXON|VALERO|BP|CIRCLE K|76 GAS|TEXACO|SINCLAIR|SUNOCO|MARATHON|PHILLIPS 66|LOVE'S|PILOT)\b/i;

// Large-venue concessions — stands inside a stadium, arena, convention center,
// or amphitheatre file health permits but aren't neighborhood restaurants: you
// can only reach them with an event ticket. Same reasoning as the corporate
// cafeteria filter. Matched against the venue name (e.g. "Levis Stadium B143",
// "Santa Clara Convention Center Refresh").
const VENUE_CONCESSION_PATTERNS = /\bLEVI'?S?\s+STADIUM\b|\bCONVENTION\s+CENTER\b|\bSAP\s+CENTER\b|\bPAYPAL\s+PARK\b|\bAVAYA\s+STADIUM\b|\bSHORELINE\s+AMPHITHEATRE?\b/i;

// Venue/transit addresses — some concessions carry a plain food name (e.g.
// "Bad Egg / Pizza My Heart") so only the SITE ADDRESS reveals they're inside an
// airport terminal or a stadium. Match those against the location, not the name.
// Raw SCC site_location abbreviates "Boulevard" as "BL" (e.g. "1701 AIRPORT BL
// SPC B2990" = SJC terminal), so match AIRPORT BL with the VD optional.
const VENUE_ADDRESS_PATTERNS = /\bAIRPORT\s+BL(?:VD)?\b|\bSJC\b|\bTERM(INAL)?\s+[A-Z0-9]\b|MARIE\s+P\.?\s+DEBARTOLO/i;

// Manual blurb overrides keyed by sourceId — these survive AI regeneration
// Use when AI-generated blurbs are generic or when we have specific local knowledge
// Sourceid → preferred display name. Use when SCC's spelling/capitalization
// doesn't match the brand (e.g. "SWEET GREENS" plural → "sweetgreen" actual chain).
const NAME_OVERRIDES = {
  "SR0881648": "sweetgreen",
  "SR0884144": "Qamaria Yemeni Coffee", // SCC record truncates name to "...Coffee Ti"
  "SR0884719": "FujiSan Sushi @ Tawa1702",
};

const BLURB_OVERRIDES = {
  // Permit filings whose name gave the model nothing to go on, so it invented a
  // cuisine anyway — "Anne Doan" (an applicant's name) came out as "Vietnamese
  // restaurant". Pinned to location-only until someone confirms the concept.
  // See CUISINE_INFERENCE_RULE for the upstream guard.
  "SR0884033": "Restaurant opening on Lafayette St in Santa Clara.",
  "SR0884919": "Food business coming to Service St in San Jose.",
  "SR0884963": "Restaurant on S Central Ave in Campbell.",
  "SR0885456": "Fish-focused eatery opening on S De Anza Blvd in Cupertino.",
  "SR0883695": "Latin and Asian concept coming to Homestead Rd in Santa Clara.",
  "SR0881648": "Sweetgreen opens at El Paseo de Saratoga — salads, grain bowls, and warm plates. Soft opening May 15–16, official launch May 19.",
  // D55: El Paseo de Saratoga is a shopping plaza IN SAN JOSE — the model
  // kept reading "Saratoga" off the plaza name and writing "in Saratoga",
  // same trap as SR0881648 above.
  "SR0884724": "Gelato shop opening at El Paseo de Saratoga in San Jose.",
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
  "SR0880082": "Seafood restaurant focusing on crab dishes, now open at 625 Coleman Ave in San Jose.",
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
  "SR0884858", // Ice Cream Machine Installation — equipment supplier/installer permit at 19409 Stevens Creek Blvd, not a food venue
  "SR0883070", // B250 Cityline Databricks — office cafeteria in Databricks' Cityline Sunnyvale building (250 W Washington), not a public restaurant
  "SR0883065", // B200 Cityline — same Databricks Cityline campus (200 W Washington); building-code permit placeholder, not a public restaurant name
  // Re-inspections of long-standing chain locations — surfaced because we dropped the elapsed-time filter.
  // Add to this list when triaging false positives surfaced by the script.
  "SR0876482", // E-FOGO DE CHAO SJ — existing Santana Row location since ~2014 (8800+ Yelp reviews), re-inspection
  "SR0878576", // E-THE MELT (Stanford Shopping Center) — existing chain location, façade/signage update (Palo Alto ARB)
  // (SR0881648 Sweetgreen El Paseo de Saratoga IS a real new opening — see BLURB_OVERRIDES)
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

  // Strip the leading "RTI" permit-type code (Restaurant Tenant Improvement).
  // Same jargon the "- Restaurant T.I." suffix rule below removes, just filed
  // in front of the name: "RTI K107 BAYBAJA KITCHEN", "RTI -HOME BOWL NOODLE".
  // Requires a following word so a real name is never swallowed whole.
  s = s.replace(/^RTI\b[\s-]*(?=\S)/i, "").trim();

  // Strip leading food-hall stall codes ("K107 BAYBAJA KITCHEN",
  // "K115-MUMBAI EXPRESS" at 1026 W Evelyn Ave in Sunnyvale). The unit is
  // already carried in the address, so in the name it just reads as noise.
  // Requires a following letter so a code-only name is never emptied out.
  s = s.replace(/^K\d{2,3}\s*[-–]?\s*(?=[A-Za-z])/i, "").trim();

  // If the whole thing is a generic tenant improvement placeholder, return null
  if (/^(RESTAURANT\s+)?TENANT\s+IMPR(OVEMENT)?(\s+\d+)?$/i.test(s)) return null;

  // Strip trailing permit artifact suffixes like "- 3 Comp Sink Install", "- TI", "- Remodel", "- Hood Install"
  s = s.replace(/\s+-\s+\d+\s+Comp\s+Sink.*$/i, "").trim();
  // The qualifier prefix ("Restaurant T.I.", "Kitchen Remodel") and the dotted
  // "T.I." spelling both occur in the county feed — "Hotel De Anza - Restaurant
  // T.I." published with the permit jargon still attached to the venue name.
  s = s.replace(/\s+-\s+(?:Restaurant\s+|Kitchen\s+|Food\s+)?(T\.?I\.?|Tenant\s+Impr(?:ovement)?|TI|Remodel|Hood\s+Install|Plumbing|Electrical|Fire\s+Suppression|Grease\s+Trap|Ansul|Ventilation|Sprinkler|Build[-\s]?Out|Buildout|Renovation|Expansion|Addition|Alteration|Conversion|New\s+Construction|Plan\s+Check|Permit|Install|Upgrade|Oil\s+Tank|Grease\s+Tank|Underground\s+Tank|Tank\s+Install|Tank\s+Removal|Tank\s+Replace|Lvl|Level|Lgt|Light|Concession(\s+\w+)?)(\s+\d+)?$/i, "").trim();

  // The tenant-improvement jargon also arrives with no dash separator
  // ("Momokitty Life Store T.I."). Only the unambiguous forms are stripped
  // bare — "Remodel"/"Renovation" can be part of a real venue name, so those
  // stay behind the dash-anchored rule above.
  s = s.replace(/\s+(T\.I\.?|Tenant\s+Impr(?:ovement)?)\s*$/i, "").trim();

  // Strip trailing equipment-only descriptors without dash separator (e.g. "Chick Fil A Oil Tank")
  s = s.replace(/\s+(Oil\s+Tank|Grease\s+Tank|Underground\s+Tank|Tank\s+Install|Tank\s+Removal|Grease\s+Trap\s+Install|Kitchen\s+Hood|Hood\s+Install|Ansul\s+System|Fire\s+Suppression\s+System|Minor\s+Equipment\s+Change|Machine\s+Replacement|Equipment\s+Change|Equipment\s+Replacement|Equipment\s+Install|Equipment\s+Upgrade|New\s+Equipment|Gas\s+Stove|Lgt|Light\s+Equipment|New\s+Build|New\s+Food\s+Facility)\s*$/i, "").trim();

  // Strip "Phase [noun]" permit phase descriptors (e.g. "Phase Concession", "Phase 1 Construction")
  s = s.replace(/\s+Phase\s+(Concession|Construction|Renovation|Buildout|Build\s*Out|Install|Equipment|Remodel|Plumbing)\s*$/i, "").trim();

  // Strip " At [Venue City]" location descriptors — e.g. "Blendid At City Sports Mountain View"
  // These appear when a kiosk is located inside another business
  s = s.replace(/\s+At\s+.+\b(San Jose|Palo Alto|Mountain View|Sunnyvale|Santa Clara|Cupertino|Milpitas|Campbell|Saratoga|Los Gatos|Los Altos|Almaden|Berryessa|Cambrian|Willow\s+Glen|Evergreen|Alum\s+Rock|Japantown)\b.*$/i, "").trim();

  // Also strip " At [Host Venue]" when the suffix is a known host-business
  // keyword without a trailing city — covers cases like "Blendid At City Sports"
  s = s.replace(/\s+At\s+(City\s+Sports|Walmart|Costco|Target|Whole\s+Foods|Safeway|Stanford\s+Mall|Valley\s+Fair|Westfield|Santana\s+Row).*$/i, "").trim();

  // Strip trailing plan-check / permit codes ("Pc03", "Pc 03", "Pc-03"), with an
  // optional redundant city name in front ("Kaizen Lounge San Jose Pc03" →
  // "Kaizen Lounge"). These are SCC filing artifacts, not part of the name.
  s = s.replace(/\s+(San Jose|Palo Alto|Mountain View|Sunnyvale|Santa Clara|Cupertino|Milpitas|Campbell|Saratoga|Los Gatos|Los Altos)?\s*\bPc\s*-?\d+\s*$/i, "").trim();

  // Strip trailing business-entity suffixes ("K108 Hey Noodle LLC" → "Hey
  // Noodle"). These are filing-entity artifacts on the permit, not how the
  // restaurant brands itself. Restaurants effectively never display a trailing
  // LLC/Inc/Corp, so this is safe; leave "Co." alone (real names like "Brewing Co.").
  s = s.replace(/\s+(LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Corporation)\s*$/i, "").trim();

  // Strip trailing address-like suffixes ("4120" at end)
  s = s.replace(/\s+\d+\s*$/, "").trim();

  // Strip trailing punctuation left behind by an empty or truncated permit
  // field — a hanging dash ("B250 Cityline Databricks -") or a dangling comma
  // where SCC cut the name short ("Cosa Fai,"). No real name ends in either.
  s = s.replace(/\s*[-–,;]\s*$/, "").trim();

  // Strip parenthetical garbage (airport permit codes, unit numbers embedded in name)
  s = s.replace(/\s*\(Unit\s+[A-Z0-9-]+[^)]*\)/gi, "").trim();
  s = s.replace(/\s*\([^)]*(?:Pltr|Airport|Terminal)[^)]*\)/gi, "").trim();

  // If name still contains "Tenant Improvement" (wasn't caught above), skip
  if (/tenant improv/i.test(s)) return null;

  // If the "name" is just a street address (digits + street words ending in a
  // street type), it's a permit-data placeholder — the actual business name
  // wasn't on the filing. Skip rather than display "14612 Big Basin Wy" as
  // a restaurant. The trailing group also accepts truncated street-type
  // fragments (SCC truncates the name field at ~20 chars: "4988 Great American
  // Pkwy" → "4988 Great American P"). Anchored to a leading street number, so
  // real names that merely start with a digit ("7 Leaves Cafe", "99 Ranch
  // Market") never match — they end in a business word, not a street fragment.
  if (/^\d+\s+[\w.\s]+?\s+(St|Street|Ave?|Avenue|Way|Wa?y?|Rd|Road|Blvd?|Blv|Boulevard|Dr|Drive|Ct|Court|Ln|Lane|Cir?|Circle|Pl|Place|Pkw?y?|Pk?|Parkway|Hwy?|Highway|Ex|Expw?y?|Ter|Terrace|Sq|Square)\.?$/i.test(s)) return null;

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

  // SCC entry sometimes splits BLVD as "B L" (typo) — normalize before title-casing
  s = s.replace(/\bB\s+L\b\.?/gi, "Blvd");

  // County records misspell San José's Barack Obama Boulevard as "BARAK OBAMA
  // BLVD" (seen 2026-08-06 on Bay Padel San Jose at #87). It's a person's name
  // on a street sign — ship the correct spelling.
  s = s.replace(/\bBarak\b(?=\s+Obama\b)/gi, "Barack");

  // Title case. Each abbreviation rule consumes an optional trailing period
  // so a raw input that already has one (e.g. "DR.") doesn't double up to "Dr..".
  s = s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bBl\b\.?/g, "Blvd")
    .replace(/\bAv\b\.?/g, "Ave")
    .replace(/\bSt\b\.?/g, "St.")
    .replace(/\bRd\b\.?/g, "Rd.")
    .replace(/\bDr\b\.?/g, "Dr.")
    .replace(/\bCt\b\.?/g, "Ct.")
    .replace(/\bCi\b\.?/g, "Cir.")
    .replace(/\bEx\b\.?/g, "Expwy")
    .replace(/\bPy\b\.?/g, "Pkwy")
    .replace(/\bWy\b\.?/g, "Way")
    .replace(/\bSte\b\.?/g, "Ste.")
    .replace(/\bFc-\d+/i, "")
    .replace(/\bUnit\s+Tbd\b/gi, "")
    .replace(/\bUnit\s+Nc-[\w,\s]+$/i, "")
    // Spanish prepositions in proper-noun South Bay place names stay lowercase
    // after title-casing ("El Paseo de Saratoga"). Skip "De Anza" — that's a
    // surname (Juan Bautista de Anza) rendered "De Anza" in local naming.
    .replace(/\bEl Paseo De\b/g, "El Paseo de")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,]+$/, "");

  s = normalizeSouthBayAddress(s);

  return s || null;
}

/**
 * Build a dedup key for an item's location. The same physical suite is often
 * written different ways across permits ("...Blvd, Ste. 1891" vs "...Blvd #1891"),
 * which used to slip past dedup and surface the same venue twice (e.g. a venue's
 * main kitchen + its sushi-bar facility filed as separate food-facility permits).
 * Canonicalize unit/suite markers so identical suites collapse, while genuinely
 * different units in the same building (Unit A vs Unit B) stay distinct.
 */
function addressKey(item) {
  const addr = (item.address ?? "")
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(/\b(ste|suite|unit|apt|no|#)\.?\s*/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return `${item.cityId}:${addr}`;
}

/**
 * Longest shared leading-word run across a group of names. Permit splits append
 * facility descriptors to a common base ("Asia Live Main", "Asia Live 1st Floor
 * Kitchen Sushi Bar" → "Asia Live"), so the shared prefix is the real venue name.
 * Returns "" when names diverge from the first word (keep the original name then).
 */
function commonNamePrefix(names) {
  const wordLists = names.map((n) => n.split(/\s+/));
  const first = wordLists[0];
  let i = 0;
  for (; i < first.length; i++) {
    const w = first[i].toLowerCase();
    if (!wordLists.every((wl) => (wl[i] ?? "").toLowerCase() === w)) break;
  }
  return first.slice(0, i).join(" ").trim();
}

/**
 * Collapse items sharing a normalized address into one entry. When the collapsed
 * group's names share a base prefix shorter than the kept name, use the prefix so
 * we show "Asia Live" rather than "Asia Live 1st Floor Kitchen Sushi Bar".
 */
function dedupeByAddress(items) {
  const groups = new Map();
  for (const item of items) {
    const key = addressKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].map((group) => {
    const rep = group[0];
    if (group.length === 1) return rep;
    const prefix = commonNamePrefix(group.map((g) => g.name));
    if (prefix && prefix.length < rep.name.length) {
      return { ...rep, name: prefix };
    }
    return rep;
  });
}

// Pure legal entity names (no real business descriptor) — e.g. "Sp Social LLC", "Umesjoakland Inc."
const BARE_ENTITY_PATTERN = /^[A-Za-z0-9&'\s]{1,30}\s+(LLC|Inc\.|Inc|Corp\.|Corp|Ltd\.|Ltd|L\.L\.C\.|L\.L\.P\.|LLP|Co\.)$/i;

// Non-food establishments that sometimes appear in health permit data (law firms, spas, etc.)
const NON_FOOD_PATTERNS = /\b(LLP|L\.L\.P\.)\b|\bATTORNEY|BARRISTERS|SOLICITORS|\bLAW\s+(OFFICES?|GROUP|FIRM)\b/i;

// Dollar/variety stores carry packaged food (so they get a health permit) but are
// not food destinations readers care about in a restaurant-openings feed. Grocery
// stores (Whole Foods, T&T, Grocery Outlet) are intentionally kept — only skip
// general-merchandise dollar/variety chains.
const VARIETY_STORE_PATTERNS = /\bDOLLAR\s*TREE\b|\bDOLLAR\s*GENERAL\b|\bFAMILY\s*DOLLAR\b|\b99\s*(CENTS?|¢)\b|\bDOLLARAMA\b|\bFIVE\s*BELOW\b/i;

function shouldSkip(item) {
  const name = item.business_name ?? "";
  const rawName = name.replace(/^E-\s*/i, "").trim();

  if (item.record_id && SOURCE_ID_SKIP.has(item.record_id)) return true;
  if (isAddressDerivedBusinessName(rawName, item.site_location)) return true;
  if (SKIP_PATTERNS.test(name)) return true;
  if (EQUIPMENT_ONLY_PATTERNS.test(name)) return true;
  if (CORPORATE_PATTERNS.test(rawName)) return true;
  if (CITYLINE_OFFICE_PATTERN.test(rawName)) return true;
  if (NON_FOOD_PATTERNS.test(rawName)) return true;
  if (NON_RESTAURANT_FACILITY.test(rawName) && !FOOD_BUSINESS_WORD.test(rawName)) return true;
  if (VARIETY_STORE_PATTERNS.test(rawName)) return true;
  if (GAS_STATION_PATTERNS.test(rawName)) return true;
  if (VENUE_CONCESSION_PATTERNS.test(rawName)) return true;
  if (VENUE_ADDRESS_PATTERNS.test(item.site_location ?? "")) return true;

  // "MFF" (Mobile Food Facility) sometimes lands in the site_location field
  // instead of the name, so the MFF clause in SKIP_PATTERNS — which only sees
  // the name — misses it and the truck ships with "Mff" printed as its street
  // address. Match the address side too.
  if (/^\s*MFF\b|\bMFF\s*$/i.test(item.site_location ?? "")) return true;

  // Skip entries whose site location is a PO Box — a storefront food venue is
  // never located at a PO Box. These are almost always HOA/apartment amenity
  // permits (pool kitchens, clubhouses) filed under a mailing address.
  if (/\bP\.?\s*O\.?\s*BOX\b/i.test(item.site_location ?? "")) return true;

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

// These records are Santa Clara County health-permit filings, so "name" is
// whatever went on the application — often the applicant rather than a business
// ("Anne Doan"), an operator ("Latin & Asian Hospitality Group"), or an opaque
// code ("Rti - Wei's Fish"). The model has no menu, so it was reading cuisine off
// the name and stating it as fact: "Anne Doan" became "Vietnamese restaurant"
// — a cuisine guessed from a person's surname. Name + address + city is all we
// actually know; when the name isn't a chain we recognize, say only that.
const CUISINE_INFERENCE_RULE = `Only name a cuisine when the source supports it. The name may be a person, a holding company, or a code — it is NOT evidence of a cuisine, and a person's name is never evidence of their food's ethnicity. State a cuisine ONLY when (a) the name explicitly says it ("Gelato Scoping Store" → gelato, "Latin & Asian Hospitality Group" → Latin and Asian), or (b) it's a chain you genuinely recognize ("Jersey Mike's Subs" → sub sandwiches). Otherwise write a location-only line — "Restaurant opening on Lafayette St in Santa Clara." — and do not guess at the food. Never infer cuisine or nationality from a personal or surname-like name.`;

/**
 * Generate one-line blurbs for a list of recently opened restaurants using Claude Sonnet.
 * Returns a map of item id → blurb string.
 */
function blurbList(items) {
  return items.map((i) => `- ${i.name} at ${i.address ?? "unknown address"} — CITY: ${i.cityName}`).join("\n");
}

// Title-case a SCC-record city name ("SAN JOSE" -> "San Jose") for the
// mismatch check below and for override authoring.
function titleCaseCity(cityName) {
  return String(cityName || "")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// D55: shopping-center names that borrow another city's name ("El Paseo de
// Saratoga" is in San Jose; the plaza's own name reads as a stronger signal
// to the model than the trailing city field) fool the blurb model into
// writing "opening in Saratoga" for a San Jose address. Scan the generated
// blurb for an "in <City>"/"at <City>" location claim naming a DIFFERENT
// covered city than the record's actual cityName and drop the blurb (falls
// back to null, same as a failed generation) rather than ship a wrong city.
function blurbCityMismatch(blurb, cityName) {
  if (!blurb || !cityName) return null;
  const correct = titleCaseCity(cityName).toLowerCase();
  for (const rawCity of new Set(Object.keys(CITY_ID_MAP))) {
    const candidate = titleCaseCity(rawCity);
    if (candidate.toLowerCase() === correct) continue;
    const re = new RegExp(`\\b(?:in|at)\\s+${candidate}\\b`, "i");
    if (re.test(blurb)) return candidate;
  }
  return null;
}

/**
 * Shared Sonnet call: runs `prompt`, parses the returned [{name, blurb}] array,
 * and maps it back onto item ids. The blurb generators below differ only in
 * their prompt + log label.
 */
async function generateBlurbMap(items, prompt, label) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || items.length === 0) return {};
  const client = new Anthropic({ apiKey });
  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
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
    console.warn(`${label} failed:`, err.message);
    return {};
  }
}

async function generateBlurbs(items) {
  const prompt = `You are a local journalist writing one-line descriptions for a South Bay residents' news site.

For each newly opened restaurant below, write one concise factual sentence (max 12 words) describing what kind of food or experience it offers. Focus on cuisine type, chain background, or what makes it distinctive. No exclamation points, no hype. Don't start with the restaurant name.

The "CITY:" field after each address is the authoritative city — always trust it over the street address. Shopping centers are sometimes named after a different city than the one they're actually in (e.g. "El Paseo de Saratoga" is a plaza in San Jose, not Saratoga) — you may mention the plaza's name, but never claim the restaurant is "in" or "at" a city other than the one given in CITY:.

${CUISINE_INFERENCE_RULE}

Examples of good blurbs:
- "Filipino chain known for Chickenjoy fried chicken, now in South San Jose."
- "Korean braised pork knuckle specialist on El Camino Real."
- "Robotic smoothie kiosk at Grant Rd and El Camino Real."

Restaurants:
${blurbList(items)}

Respond with a JSON array of objects with "name" and "blurb" fields only. No markdown, no explanation.`;
  return generateBlurbMap(items, prompt, "Blurb generation");
}

/**
 * Generate anticipation-style blurbs for coming-soon restaurants using Claude Sonnet.
 * Returns a map of item id → blurb string.
 */
async function generateComingSoonBlurbs(items) {
  const prompt = `You are a local journalist writing one-line descriptions for a South Bay residents' news site.

For each "coming soon" restaurant below, write one concise factual sentence (max 12 words) describing what kind of food or experience it will offer. Focus on cuisine type, chain background, or location context. No exclamation points, no hype. Don't start with the restaurant name.

The "CITY:" field after each address is the authoritative city — always trust it over the street address. Shopping centers are sometimes named after a different city than the one they're actually in (e.g. "El Paseo de Saratoga" is a plaza in San Jose, not Saratoga) — you may mention the plaza's name, but never claim the restaurant is "in" or "at" a city other than the one given in CITY:.

${CUISINE_INFERENCE_RULE}

Examples of good blurbs:
- "BBQ chain with smoked ribs and wings, opening on Curtner Ave."
- "Breakfast and brunch spot coming to San Antonio Rd in Mountain View."
- "Sushi restaurant opening on Los Gatos Blvd."

Restaurants:
${blurbList(items)}

Respond with a JSON array of objects with "name" and "blurb" fields only. No markdown, no explanation.`;
  return generateBlurbMap(items, prompt, "Coming-soon blurb generation");
}

/** Generate neutral descriptions for permits whose only dated fact is inspection. */
async function generateInspectionBlurbs(items) {
  const prompt = `You are a local journalist writing one-line descriptions for a South Bay residents' news site.

For each food business below, write one concise factual sentence (max 12 words) describing its apparent business type or location. These records only establish that a county final inspection occurred. Never say or imply the business opened, is new, recently opened, or is now operating. No exclamation points, no hype. Don't start with the business name.

The "CITY:" field after each address is authoritative. ${CUISINE_INFERENCE_RULE}

Businesses:
${blurbList(items)}

Respond with a JSON array of objects with "name" and "blurb" fields only. No markdown, no explanation.`;
  return generateBlurbMap(items, prompt, "Inspection blurb generation");
}

// ── Google Places photoRef enrichment ────────────────────────────────────
// Tile UI on /#food shows each opening as a square card with a real photo.
// First try places.json (free; covers existing chains). Fall back to a live
// Places Text Search for new locations. Cache misses too — sub-second cost,
// but no point hammering Google on items we know have no photo.
function loadPhotoCache() {
  if (!existsSync(PHOTO_CACHE_PATH)) return { byKey: {} };
  try { return JSON.parse(readFileSync(PHOTO_CACHE_PATH, "utf8")); } catch { return { byKey: {} }; }
}

function savePhotoCache(cache) {
  cache.generatedAt = new Date().toISOString();
  writeFileAtomic(PHOTO_CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

async function searchPlacesPhotoRef(name, address, cityId, apiKey) {
  if (!apiKey) return null;
  const cityLabel = (cityId || "").replace(/-/g, " ");
  const query = address ? `${name} ${address} ${cityLabel}` : `${name} ${cityLabel}`;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
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
  } catch (err) {
    console.warn(`  ⚠️  Places lookup failed for ${name}: ${err.message}`);
    return null;
  }
}

async function enrichWithPhotos(items) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const cache = loadPhotoCache();
  let venueHits = 0, cacheHits = 0, apiHits = 0, missing = 0;

  for (const item of items) {
    // Tier 1: places.json by name (free, instant).
    const venueRef = lookupVenuePhoto(item.name);
    if (venueRef) { item.photoRef = venueRef; venueHits++; continue; }

    // Tier 2: scc-food-photo-cache.json keyed by sourceId.
    const key = item.sourceId || `${item.name}|${item.address || ""}|${item.cityId || ""}`;
    if (Object.prototype.hasOwnProperty.call(cache.byKey, key)) {
      const cached = cache.byKey[key];
      if (cached) { item.photoRef = cached; cacheHits++; }
      else missing++;
      continue;
    }

    // Tier 3: live Google Places Text Search (paid, cached).
    const ref = await searchPlacesPhotoRef(item.name, item.address, item.cityId, apiKey);
    cache.byKey[key] = ref;
    if (ref) { item.photoRef = ref; apiHits++; }
    else missing++;
    await new Promise((r) => setTimeout(r, 250));
  }

  savePhotoCache(cache);
  console.log(`  Photos: ${venueHits} from places.json, ${cacheHits} cached, ${apiHits} new lookups, ${missing} no photo`);
}

// ── Recraft fallback for items without a Google Places photo ─────────────
// Generates a stylized food illustration so the tile grid never falls back
// to a flat gradient. Cached by sourceId so the same item reuses its tile
// across daily regens. Pruned after 30 days of being out of the feed.
function loadImageCache() {
  if (!existsSync(IMAGE_CACHE_PATH)) return {};
  try { return JSON.parse(readFileSync(IMAGE_CACHE_PATH, "utf8")); } catch { return {}; }
}

function saveImageCache(cache) {
  writeFileAtomic(IMAGE_CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

async function generateRecraftPrompts(items) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || items.length === 0) return {};
  const client = new Anthropic({ apiKey });
  const list = items.map((i) => `- ${i.sourceId}: ${i.name} — ${i.blurb || "new spot"}`).join("\n");

  const prompt = `Generate a Recraft image prompt for each food spot below. Each prompt must:
- Be a short bold flat-color illustration prompt (12-22 words)
- Center on the food/cuisine type, not the building or signage
- Include a vivid 2-color palette hint (vary between items so the grid feels colorful)
- End with: "no text, no people, no logos, no faces"

Examples:
- "playful flat illustration of a French dip sandwich with melted cheese, bright purple and orange palette, no text, no people, no logos, no faces"
- "stack of colorful Japanese street crepes with strawberries and cream, pop-art style, vivid teal and pink palette, no text, no people, no logos, no faces"
- "abstract donut tower with sprinkles and glaze swirls, bold flat shapes, magenta and lemon yellow palette, no text, no people, no logos, no faces"

Items:
${list}

Respond with JSON: array of objects with "sourceId" and "prompt" fields only. No markdown.`;

  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    let text = msg.content[0]?.text ?? "[]";
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(text);
    const map = {};
    for (const e of parsed) if (e.sourceId && e.prompt) map[e.sourceId] = e.prompt;
    return map;
  } catch (err) {
    console.warn(`  ⚠️  prompt generation failed: ${err.message}`);
    return {};
  }
}

async function generateFallbackImages(items) {
  const need = items.filter((i) => !i.photoRef && i.sourceId);
  if (need.length === 0) {
    console.log("  All items have Google Places photos — no Recraft fallbacks needed.");
    return;
  }

  const cache = loadImageCache();
  const cachedHits = need.filter((i) => cache[i.sourceId]?.url);
  for (const item of cachedHits) item.image = cache[item.sourceId].url;

  const fresh = need.filter((i) => !cache[i.sourceId]?.url);
  if (fresh.length === 0) {
    console.log(`  Recraft fallbacks: ${cachedHits.length} cached, 0 new.`);
    saveImageCache(cache);
    return;
  }

  if (!process.env.RECRAFT_API_KEY) {
    console.warn(`  ⏭️  ${fresh.length} item(s) need Recraft tiles but RECRAFT_API_KEY is unset — skipping.`);
    saveImageCache(cache);
    return;
  }

  const prompts = await generateRecraftPrompts(fresh);
  const { generateAndUploadResized } = await import("./social/lib/recraft.mjs");

  console.log(`  Recraft fallbacks: ${cachedHits.length} cached, generating ${fresh.length} new…`);
  for (const item of fresh) {
    const baseCue = prompts[item.sourceId]
      || `stylized food illustration for ${item.name}, bold flat-color graphic, vivid colors, no text, no people, no logos, no faces`;
    const fullPrompt = `${baseCue}. Bold flat-color illustration, vibrant colors, decorative composition, square 1:1 ratio. Absolutely NO TEXT, no letters, no words, no logos, no people, no faces.`;

    let url = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // /#food tiles display at 217x162 (FoodTile) — 450x340 lossy webp q80
        // is generous headroom vs. Recraft's lossless ~1MB+ source (D45).
        const result = await generateAndUploadResized({
          prompt: fullPrompt,
          pathname: `food-tiles/${item.sourceId}-450.webp`,
          width: 450,
          height: 340,
        });
        url = result.url;
        break;
      } catch (err) {
        const msg = err.message || "";
        if (msg.includes("429") && attempt < 2) {
          const wait = 4000 * (attempt + 1);
          console.warn(`  ⏳ ${item.name} rate-limited, waiting ${wait}ms…`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        console.warn(`  ⚠️  ${item.name}: ${msg}`);
        break;
      }
    }

    if (url) {
      item.image = url;
      cache[item.sourceId] = { url, prompt: baseCue, generatedAt: new Date().toISOString() };
      console.log(`  ✓ tile ${item.name}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Prune entries not seen in current items + older than 30 days.
  const liveIds = new Set(items.map((i) => i.sourceId).filter(Boolean));
  const now = Date.now();
  const pruned = {};
  for (const [id, entry] of Object.entries(cache)) {
    const ageDays = (now - new Date(entry.generatedAt).getTime()) / 86400000;
    if (liveIds.has(id) || ageDays < 30) pruned[id] = entry;
  }
  saveImageCache(pruned);
}

async function fetchPage(whereClause, orderField, limit = 50) {
  const params = new URLSearchParams({
    $where: whereClause,
    $order: `${orderField} DESC`,
    $limit: limit.toString(),
  });
  const url = `${API_BASE}?${params}`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "southbaytoday.org/data-pipeline" },
  });
  if (!res.ok) throw new Error(`SCC API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log("Fetching SCC restaurant permit data…\n");

  // --- Recent county final inspections ---
  const finalizedRaw = await fetchPage(
    `final_inspection > '${LOOKBACK_DATE}T00:00:00.000'`,
    "final_inspection",
    100,
  );

  // SCC final_inspection also fires for re-inspections, ownership changes, and
  // long-running permit work. Classify every row as an inspection unless a
  // separate first-party source establishes a real opening date.
  const finalized = finalizedRaw
    .filter((item) => !shouldSkip(item))
    .map((item) => {
      const cleaned = cleanName(item.business_name);
      if (!cleaned) return null;
      const name = (item.record_id && NAME_OVERRIDES[item.record_id]) ?? cleaned;
      const city = (item.city ?? "").toUpperCase();
      return classifyFinalInspection({
        id: item.record_id ?? item.business_name?.toLowerCase().replace(/\W+/g, "-"),
        name,
        address: cleanAddress(item.site_location),
        cityId: CITY_ID_MAP[city] ?? null,
        cityName: city,
        inspectionDate: item.final_inspection?.slice(0, 10) ?? null,
        sourceId: item.record_id ?? null,
      }, item.record_id ? VERIFIED_OPENING_EVIDENCE[item.record_id] : null);
    })
    .filter(Boolean);

  // Deduplicate by address (different units in same building stay distinct;
  // the same suite written two ways collapses to one — see addressKey)
  // Validate again after dedupe because its shared-prefix transform can create a
  // new display name that no individual source record had.
  const finalizedDeduped = dedupeByAddress(finalized)
    .filter((item) => !isAddressDerivedBusinessName(item.name, item.address));
  const openedDeduped = finalizedDeduped
    .filter(isVerifiedOpeningRecord)
    .filter((item) => item.date >= LOOKBACK_DATE);
  const inspectionsDeduped = finalizedDeduped
    .filter((item) => item.status === "inspection-complete");

  // --- Coming soon: plan approved but no final inspection yet ---
  const comingSoonRaw = await fetchPage(
    `date_plan_approved > '${LOOKBACK_DATE}T00:00:00.000' AND final_inspection IS NULL`,
    "date_plan_approved",
    100,
  );

  const comingSoon = comingSoonRaw
    .filter((item) => !shouldSkip(item))
    .map((item) => {
      const cleaned = cleanName(item.business_name);
      if (!cleaned) return null;
      const name = (item.record_id && NAME_OVERRIDES[item.record_id]) ?? cleaned;
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
  const comingSoonDeduped = dedupeByAddress(comingSoon)
    .filter((item) => !isAddressDerivedBusinessName(item.name, item.address));

  // A final inspection closes the coming-soon permit state even when we cannot
  // honestly claim the business opened.
  const finalizedAddresses = new Set(finalizedDeduped.map((i) => addressKey(i)));
  const comingSoonFinal = comingSoonDeduped.filter((i) => !finalizedAddresses.has(addressKey(i)));

  // Manual overrides are hand-verified — trust them outright. AI-generated
  // blurbs get a post-gen city-mismatch check (D55): a plaza named after a
  // different city (El Paseo de Saratoga, in San Jose) can fool the model
  // into writing "opening in Saratoga" for a San Jose address. Drop rather
  // than ship a wrong city — falls back to null, same as a failed generation.
  function resolveBlurb(item, aiBlurbMap) {
    const override = item.sourceId && BLURB_OVERRIDES[item.sourceId];
    if (override) return override;
    const aiBlurb = aiBlurbMap[item.id] ?? null;
    const mismatch = blurbCityMismatch(aiBlurb, item.cityName);
    if (mismatch) {
      console.warn(`[blurb-city-mismatch] "${item.name}" (${item.cityName}) blurb names "${mismatch}": ${JSON.stringify(aiBlurb)}`);
      return null;
    }
    return aiBlurb;
  }

  // Generate blurbs for top opened restaurants
  const topOpened = openedDeduped.slice(0, 12);
  console.log("Generating blurbs for opened restaurants…");
  const blurbs = await generateBlurbs(topOpened);

  const openedWithBlurbs = openedDeduped.slice(0, 12).map((i) => ({
    ...i,
    blurb: resolveBlurb(i, blurbs),
  }));

  const topInspections = inspectionsDeduped.slice(0, 12);
  console.log("Generating neutral blurbs for final inspections…");
  const inspectionBlurbs = await generateInspectionBlurbs(topInspections);
  const inspectionsWithBlurbs = topInspections.map((i) => ({
    ...i,
    blurb: inspectionBlurbs[i.id] ?? null,
  }));

  // Generate anticipation blurbs for top coming-soon restaurants
  const topComingSoon = comingSoonFinal.slice(0, 12);
  console.log("Generating blurbs for coming-soon restaurants…");
  const comingSoonBlurbs = await generateComingSoonBlurbs(topComingSoon);

  const comingSoonWithBlurbs = comingSoonFinal.slice(0, 12).map((i) => ({
    ...i,
    blurb: resolveBlurb(i, comingSoonBlurbs),
  }));

  // Attach Google Places photoRef so /#food can render real-photo tiles.
  console.log("Looking up Google Places photos…");
  await enrichWithPhotos(openedWithBlurbs);
  await enrichWithPhotos(inspectionsWithBlurbs);
  await enrichWithPhotos(comingSoonWithBlurbs);

  // Generate Recraft food illustrations for items that didn't get a Places photo.
  console.log("Recraft fallback for items without Places photo…");
  await generateFallbackImages([...openedWithBlurbs, ...inspectionsWithBlurbs, ...comingSoonWithBlurbs]);

  const output = {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    sourceUrl: "https://data.sccgov.org/resource/skd7-7ix3",
    opened: openedWithBlurbs,
    inspections: inspectionsWithBlurbs,
    comingSoon: comingSoonWithBlurbs,
  };

  writeFileAtomic(OUT_PATH, JSON.stringify(output, null, 2) + "\n");

  console.log(`✅ ${openedDeduped.length} verified openings, ${inspectionsDeduped.length} final inspections, ${comingSoonFinal.length} coming soon → scc-food-openings.json`);
  console.log("\nRecently opened:");
  openedDeduped.slice(0, 8).forEach((i) => console.log(`  [${i.date}] ${i.name} — ${i.address}, ${i.cityName}`));
  console.log("\nRecent final inspections (not opening claims):");
  inspectionsDeduped.slice(0, 8).forEach((i) => console.log(`  [${i.inspectionDate}] ${i.name} — ${i.address}, ${i.cityName}`));
  console.log("\nComing soon:");
  comingSoonFinal.slice(0, 8).forEach((i) => console.log(`  [${i.date}] ${i.name} — ${i.address}, ${i.cityName}`));

  // Content-freshness alarm: final-inspection dates test whether the SCC feed is
  // still moving. They must not be relabeled as opening dates in the alert.
  // The file mtime won't catch this — reddit-pulse appends keep bumping generatedAt
  // even when the SCC source has stopped producing new entries.
  const FRESHNESS_THRESHOLD_DAYS = 14;
  const dates = inspectionsWithBlurbs
    .map((i) => i.inspectionDate)
    .filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const newest = dates[dates.length - 1] ?? null;
  if (newest) {
    const ageDays = (Date.now() - new Date(newest + "T12:00:00").getTime()) / 86400000;
    if (ageDays > FRESHNESS_THRESHOLD_DAYS) {
      const msg =
        `Newest SCC final inspection is **${Math.round(ageDays)} days old** (${newest}). ` +
        `Either the upstream API stopped returning new South Bay records or our filter is dropping valid inspections. ` +
        `Check scripts/generate-scc-food-openings.mjs run logs.`;
      console.warn(`⚠️  Freshness alert: ${msg}`);
      await catSignal({
        key: "scc-food-openings-stale",
        title: "SBT food permits — data going stale",
        body: msg,
      });
    }
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
