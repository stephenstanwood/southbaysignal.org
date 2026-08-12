#!/usr/bin/env node
// One-shot place blurb generator. Produces place-blurb-cache.json keyed by
// place id with one venue-specific sentence each.
//
// Two-tier strategy:
//   1. If place-research-cache.json has a Google editorialSummary for this
//      id, use it verbatim — it's Google's own one-liner, ground truth.
//   2. Otherwise fall back to data-driven templates that combine
//      displayType + city + street + priceLevel into honest, specific copy.
//
// No LLM calls. Deterministic. Templates vary by category cluster + hash
// the place id so 50 Italian restaurants don't all read the same.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanDisplayCopy } from "../src/lib/south-bay/displayText.mjs";
import { writeFileAtomic } from "./lib/io.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLACES = join(__dirname, "..", "src", "data", "south-bay", "places.json");
const RESEARCH = join(__dirname, "..", "src", "data", "south-bay", "place-research-cache.json");
const OUT = join(__dirname, "..", "src", "data", "south-bay", "place-blurb-cache.json");

const places = JSON.parse(readFileSync(PLACES, "utf8")).places;
const research = existsSync(RESEARCH) ? JSON.parse(readFileSync(RESEARCH, "utf8")) : {};

const CITY_NAMES = {
  "campbell": "Campbell", "cupertino": "Cupertino", "los-gatos": "Los Gatos",
  "mountain-view": "Mountain View", "saratoga": "Saratoga", "sunnyvale": "Sunnyvale",
  "palo-alto": "Palo Alto", "san-jose": "San Jose", "santa-clara": "Santa Clara",
  "los-altos": "Los Altos", "milpitas": "Milpitas", "santa-cruz": "Santa Cruz",
};

function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function extractStreet(address, cityName, placeName = "") {
  if (!address) return null;
  const firstSeg = address.split(",")[0]?.trim();
  if (!firstSeg) return null;
  const placeKey = normalizeKey(placeName);
  if (placeKey && normalizeKey(firstSeg).includes(placeKey)) return null;
  // Strip leading street number (single or hyphenated range), then trailing
  // unit/building/floor/suite blobs.
  // The leading-number strip must require a hyphen for the secondary digits —
  // otherwise "100 1st St" gets eaten as "100 1" → "st St".
  let cleaned = firstSeg
    .replace(/^\d+\s*(?:-\s*\d+\s*)?/, "")
    .replace(/\s+(Suites?|Ste|Unit|Apt|#|Bldg|Building|Floor|Fl|Lvl|Level)\b.*$/i, "")
    .trim();
  // Trailing unit designator after a street-type token: solo letter
  // ("Ave A"), letter-dash-number ("Ave C-31"), or solo number ("Blvd 200").
  // Constrained to known street types so we don't mangle real names.
  cleaned = cleaned.replace(
    /(\s+(?:Ave|St|Blvd|Rd|Dr|Ct|Ln|Way|Pl|Pkwy|Hwy|Ter|Cir))\s+(?:[A-Z]\-?\d*|[A-Z]?\d+[A-Z]?)$/i,
    "$1"
  ).trim();
  if (!cleaned || cleaned.length < 3) return null;
  if (/^\d+$/.test(cleaned) || /^P\.?O\.?\s*Box/i.test(cleaned)) return null;
  if (!/\b(?:Ave|St|Blvd|Rd|Dr|Ct|Ln|Way|Wy|Pl|Pkwy|Hwy|Ter|Cir|Expy|Expressway|Alameda|Row|Mall|Square|Real)\b/i.test(cleaned)) return null;
  // Drop streets named after the city — "Saratoga library on Saratoga Ave"
  // reads as redundant. The card already shows the city as a chip.
  if (cityName && new RegExp(`^${cityName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(cleaned)) return null;
  return cleaned;
}

function hashIdx(s, mod) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % mod;
}

function pickTemplate(templates, id) {
  return templates[hashIdx(id, templates.length)];
}

function lowerType(displayType) {
  if (!displayType) return "spot";
  const NATIONALITY_RE = /^(Vietnamese|Italian|Chinese|Japanese|Korean|Taiwanese|Mexican|Indian|Thai|French|Spanish|Greek|American|Mediterranean|German|Persian|Cuban|Brazilian|Ethiopian|Filipino|Cambodian|Burmese|Lebanese|Turkish|Pakistani|Caribbean|Peruvian|Argentine|Russian|Egyptian|Moroccan|Polish|Portuguese|Hawaiian|Asian|African|European|Latin)\b/;
  if (NATIONALITY_RE.test(displayType)) return displayType;
  return displayType.charAt(0).toLowerCase() + displayType.slice(1);
}

// Google Places returns priceLevel as enum strings (PRICE_LEVEL_INEXPENSIVE,
// _MODERATE, _EXPENSIVE, _VERY_EXPENSIVE). Normalize to $/$$/$$$/$$$$.
function priceTier(priceLevel) {
  if (!priceLevel) return null;
  const map = {
    "PRICE_LEVEL_INEXPENSIVE": "$",
    "PRICE_LEVEL_MODERATE": "$$",
    "PRICE_LEVEL_EXPENSIVE": "$$$",
    "PRICE_LEVEL_VERY_EXPENSIVE": "$$$$",
    "$": "$", "$$": "$$", "$$$": "$$$", "$$$$": "$$$$",
  };
  return map[priceLevel] || null;
}

const FOOD_TYPE_LABELS = {
  afghani_restaurant: "Afghan restaurant",
  african_restaurant: "African restaurant",
  american_restaurant: "American restaurant",
  asian_fusion_restaurant: "Asian fusion restaurant",
  asian_restaurant: "Asian restaurant",
  austrian_restaurant: "Austrian restaurant",
  bagel_shop: "Bagel shop",
  barbecue_restaurant: "Barbecue restaurant",
  bar_and_grill: "Bar & grill",
  beer_garden: "Beer garden",
  brazilian_restaurant: "Brazilian restaurant",
  breakfast_restaurant: "Breakfast restaurant",
  brewpub: "Brewpub",
  brewery: "Brewery",
  brunch_restaurant: "Brunch restaurant",
  buffet_restaurant: "Buffet restaurant",
  burmese_restaurant: "Burmese restaurant",
  cajun_restaurant: "Cajun restaurant",
  californian_restaurant: "Californian restaurant",
  cantonese_restaurant: "Cantonese restaurant",
  chicken_restaurant: "Chicken restaurant",
  chinese_noodle_restaurant: "Chinese noodle restaurant",
  chinese_restaurant: "Chinese restaurant",
  cocktail_bar: "Cocktail bar",
  coffee_shop: "Coffee shop",
  deli: "Deli",
  dessert_restaurant: "Dessert restaurant",
  dim_sum_restaurant: "Dim sum restaurant",
  diner: "Diner",
  eastern_european_restaurant: "Eastern European restaurant",
  dumpling_restaurant: "Dumpling restaurant",
  filipino_restaurant: "Filipino restaurant",
  fine_dining_restaurant: "Fine dining restaurant",
  fast_food_restaurant: "Fast food restaurant",
  food_court: "Food court",
  french_restaurant: "French restaurant",
  fusion_restaurant: "Fusion restaurant",
  gastropub: "Gastropub",
  german_restaurant: "German restaurant",
  greek_restaurant: "Greek restaurant",
  hamburger_restaurant: "Hamburger restaurant",
  halal_restaurant: "Halal restaurant",
  hawaiian_restaurant: "Hawaiian restaurant",
  hot_pot_restaurant: "Hot pot restaurant",
  indian_restaurant: "Indian restaurant",
  indonesian_restaurant: "Indonesian restaurant",
  israeli_restaurant: "Israeli restaurant",
  italian_restaurant: "Italian restaurant",
  japanese_curry_restaurant: "Japanese curry restaurant",
  japanese_izakaya_restaurant: "Izakaya",
  japanese_restaurant: "Japanese restaurant",
  korean_barbecue_restaurant: "Korean barbecue restaurant",
  korean_restaurant: "Korean restaurant",
  lebanese_restaurant: "Lebanese restaurant",
  mediterranean_restaurant: "Mediterranean restaurant",
  mexican_restaurant: "Mexican restaurant",
  middle_eastern_restaurant: "Middle Eastern restaurant",
  north_indian_restaurant: "North Indian restaurant",
  oyster_bar_restaurant: "Oyster bar",
  pakistani_restaurant: "Pakistani restaurant",
  persian_restaurant: "Persian restaurant",
  peruvian_restaurant: "Peruvian restaurant",
  portuguese_restaurant: "Portuguese restaurant",
  pizza_restaurant: "Pizza restaurant",
  pub: "Pub",
  ramen_restaurant: "Ramen restaurant",
  sandwich_shop: "Sandwich shop",
  seafood_restaurant: "Seafood restaurant",
  soup_restaurant: "Soup restaurant",
  south_indian_restaurant: "South Indian restaurant",
  spanish_restaurant: "Spanish restaurant",
  steak_house: "Steak house",
  sushi_restaurant: "Sushi restaurant",
  taiwanese_restaurant: "Taiwanese restaurant",
  tapas_restaurant: "Tapas restaurant",
  tea_house: "Tea house",
  thai_restaurant: "Thai restaurant",
  tonkatsu_restaurant: "Tonkatsu restaurant",
  turkish_restaurant: "Turkish restaurant",
  vegan_restaurant: "Vegan restaurant",
  vegetarian_restaurant: "Vegetarian restaurant",
  vietnamese_restaurant: "Vietnamese restaurant",
  wine_bar: "Wine bar",
};

const GENERIC_FOOD_TYPES = new Set([
  "restaurant", "food", "point_of_interest", "establishment", "meal_takeaway",
  "meal_delivery", "food_delivery", "catering_service", "family_restaurant",
  "service", "store", "food_store",
]);

function foodDisplayType(p) {
  const display = String(p.displayType || "").trim();
  if (display && !/^(restaurant|food|null|undefined)$/i.test(display)) return display;
  for (const type of p.types || []) {
    if (GENERIC_FOOD_TYPES.has(type)) continue;
    if (FOOD_TYPE_LABELS[type]) return FOOD_TYPE_LABELS[type];
  }
  const profile = foodProfileFromName(p.name || "", "");
  return profile?.label || display || "Restaurant";
}

function isFoodPlace(p) {
  if (p.category === "food") return true;
  if (FOOD_TYPE_LABELS[p.primaryType]) return true;
  for (const type of p.types || []) {
    if (FOOD_TYPE_LABELS[type]) return true;
  }
  return /\b(restaurant|cafe|bakery|coffee|tea|dessert|bar|grill|brewpub|brewery|deli|pizza|ramen|sushi)\b/i.test(p.displayType || "");
}

function capFirst(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function foodProfileFromName(name, typeText) {
  const hay = normalizeKey(name) + " " + normalizeKey(typeText);
  const rules = [
    [/telef.?ric barcelona/, "Spanish restaurant", "tapas, paella, and Spanish plates"],
    [/bloom bagels|main street bagels|bagel/, "bagel shop", "bagels, coffee, and breakfast sandwiches"],
    [/roja/, "fine-dining restaurant", "seasonal dinner plates and cocktails"],
    [/le l kitchen|lele kitchen/, "Asian restaurant", "Asian plates and rice bowls"],
    [/first born/, "sandwich shop", "sandwiches, brunch plates, and coffee"],
    [/asa restaurant/, "New American restaurant", "seafood, pastas, and seasonal dinner plates"],
    [/shepherd sims/, "American restaurant", "burgers, steaks, and cocktails"],
    [/los gatos parkside/, "American restaurant", "burgers, salads, and dinner plates"],
    [/senza italian/, "Italian restaurant", "pasta, pizza, and Italian plates"],
    [/oy gluten free/, "gluten-free bakery", "gluten-free breads, pastries, and baked goods"],
    [/intl kitchen/, "Asian restaurant", "Asian plates, noodles, and rice bowls"],
    [/la casa mia/, "Japanese-Italian restaurant", "Japanese-style pastas, gratins, and cafe plates"],
    [/big al s/, "bowling-alley restaurant", "burgers, pizza, wings, and group-friendly bites"],
    [/nar restaurant/, "Azerbaijani restaurant", "kebabs, dumplings, and Caucasus plates"],
    [/bevri/, "Georgian restaurant", "khachapuri, khinkali, and Georgian wines"],
    [/bloomsgiving/, "cafe and flower shop", "coffee, cafe bites, and flowers"],
    [/saigon breadfast|sai gon breadfast/, "Vietnamese sandwich shop", "banh mi, coffee, and Vietnamese breakfast bites"],
    [/redwood caf|redwood cafe/, "cafe", "breakfast plates, sandwiches, and coffee"],
    [/ethel s fancy/, "New American restaurant", "seasonal New American plates and cocktails"],
    [/naschmarkt/, "Austrian restaurant", "schnitzel, sausages, and Austrian plates"],
    [/lou herbert s/, "cafe bar", "coffee, cocktails, and cafe plates"],
    [/san pedro square market/, "food hall", "multiple food vendors, drinks, and casual plates"],
    [/burma roots|burma taste|rangoon ruby/, "Burmese restaurant", "tea leaf salad, curries, and Burmese noodles"],
    [/holy cannoli/, "dessert caterer", "cannoli, pastries, and Italian sweets"],
    [/augustine/, "bakery cafe", "pastries, coffee, and cafe plates"],
    [/tarim garden|xinjiang|uyghur/, "Xinjiang restaurant", "hand-pulled noodles, kebabs, and Uyghur-style plates"],
    [/jashn/, "Indian restaurant", "curries, kebabs, and Indian plates"],
    [/hero ranch/, "American restaurant", "steaks, seafood, and cocktails"],
    [/goga/, "fine-dining restaurant", "seasonal tasting-menu plates and wine"],
    [/historic saratoga village/, "village dining area", "cafes, restaurants, and walkable Saratoga stops"],
    [/flowers saratoga/, "Californian restaurant", "dinner plates, cocktails, and patio drinks"],
    [/khao thai/, "Thai restaurant", "Thai curries, noodles, and rice plates"],
    [/frankie/, "Italian restaurant", "pasta, pizza, and Italian-American plates"],
    [/dishdash/, "Middle Eastern restaurant", "kebabs, hummus, and Middle Eastern plates"],
    [/trifecta/, "catering-friendly lunch spot", "sandwiches, wraps, and lunch plates"],
    [/the stand/, "American classics spot", "burgers, sandwiches, salads, and fries"],
    [/bayon temple|khmer|cambod/, "Cambodian restaurant", "Cambodian/Khmer plates"],
    [/latin asian fusion/, "Latin-Asian fusion restaurant", "Latin-Asian fusion plates"],
    [/empanada/, "empanada shop", "savory and sweet empanadas"],
    [/good salad|sprout|salad|palmetto superfood|raw superfood|true food|wildseed/, "salad and bowls spot", "salads, bowls, and plant-forward plates"],
    [/pho|banh mi|vpho|y linh/, "Vietnamese restaurant", "pho, banh mi, and rice plates"],
    [/la jaiba|mariscos|cajun crack|bag o crab|cap'?t loui|crab|raw bar|one fish|oyster|surmai/, "seafood restaurant", "fish, crab, and seafood plates"],
    [/taqueria|taco|burrito|jalisco|distrito federal|luna mexican|dos burros|mayan|fiesta vallarta|el comal|cantina/, "Mexican restaurant", "tacos, burritos, and Mexican plates"],
    [/sushi|sushiko|kakuna|mj sushi/, "sushi restaurant", "sushi rolls and Japanese plates"],
    [/ramen|hironori/, "ramen shop", "ramen bowls and Japanese small plates"],
    [/udon|marugame|uzumakiya/, "udon shop", "udon bowls and Japanese small plates"],
    [/dumpling|xlb|xiao long bao|dough zone|bun dynasty/, "dumpling house", "dumplings, buns, and Chinese small plates"],
    [/mian|noodle|malatang|special noodle|duan chun zhen|noodlepanda|fish with you/, "noodle shop", "noodle bowls and soup"],
    [/hot pot|shabu|claypot|xpp|home eat/, "hot pot and claypot spot", "hot pots, claypots, and shareable plates"],
    [/biryani|curry|tiffin|dosa|naan|thaali|masakali|ambrosia|avachi|bangalore|calcutta|karimi|aurum|inchin|namaste/, "Indian restaurant", "curries, biryani, and tandoori plates"],
    [/momo|kathmandu/, "Himalayan dumpling spot", "momos, curries, and Himalayan plates"],
    [/bbq chicken|bb q chicken|fried chicken|starbird|fire wings|chicken|wings/, "chicken spot", "fried chicken, wings, and sandwiches"],
    [/korean|tofu|hansang|danbi|saucy asian/, "Korean restaurant", "Korean comfort plates, tofu stews, and barbecue"],
    [/gyu kaku|yakiniku|ushiya/, "Japanese barbecue restaurant", "table-grilled meats and Japanese barbecue"],
    [/burger|super duper|konjoe|main street burgers/, "burger spot", "burgers, fries, and casual plates"],
    [/pizza|pizzeria|square pie|rosie/, "pizza spot", "pizza, slices, and Italian-leaning casual plates"],
    [/steak|chop house|morton's|fleming|galp[aã]o gaucho/, "steakhouse", "steaks, grilled meats, and sides"],
    [/barbecue|bbq|smoke/, "barbecue restaurant", "barbecue plates and smoked meats"],
    [/crepe/, "crepe cafe", "crepes, salads, and cafe plates"],
    [/pancake|breakfast|brunch|mimosas|breaking dawn|uncle john|holder|country inn|orange bowl|creamery/, "breakfast and brunch spot", "eggs, pancakes, and brunch plates"],
    [/sandwich|panino|bun me up|oakmont/, "sandwich shop", "sandwiches, coffee, and quick lunch plates"],
    [/coffee|cafe|caffe|roasting|philz|lookout|arwa|bijan|nahita|olympus/, "cafe", "coffee, pastries, and cafe bites"],
    [/bakery|donut|doughnut|cake|bundt|patisserie|pastry/, "bakery", "pastries, cakes, and baked goods"],
    [/ice cream|gelato|creamery|tong sui|dessert|sweets|boba|tea|teaspoon/, "dessert and drinks shop", "desserts, tea drinks, and sweet snacks"],
    [/\b(?:wine|vino)\b|tasting house|tessora/, "wine bar", "wine pours and small plates"],
    [/\b(?:brew(?:pub|ery|ing)?|beer|tap(?:s|room)?|barrel)\b/, "beer bar", "beer, taps, and pub bites"],
    [/\b(?:pub|grill|bar)\b|district|local union|double d|topgolf|dave buster/, "bar and grill", "burgers, drinks, and shareable plates"],
    [/coconuts|caribbean/, "Caribbean restaurant", "Caribbean plates"],
    [/cascal|suspiro|macarena|bodeguita/, "Spanish and Latin restaurant", "tapas, Latin plates, and cocktails"],
  ];
  for (const [rx, label, food] of rules) {
    if (rx.test(hay)) return { label, food };
  }
  return null;
}

function foodProfileFromType(typeText) {
  const t = normalizeKey(typeText);
  const checks = [
    [/bagel/, "bagel shop", "bagels, coffee, and breakfast sandwiches"],
    [/pakistani/, "Pakistani restaurant", "kebabs, curries, and Pakistani plates"],
    [/persian/, "Persian restaurant", "kebabs, rice plates, and Persian stews"],
    [/burmese/, "Burmese restaurant", "tea leaf salad, curries, and Burmese noodles"],
    [/portuguese/, "Portuguese restaurant", "Portuguese small plates, seafood, and brunch plates"],
    [/austrian/, "Austrian restaurant", "schnitzel, sausages, and Austrian plates"],
    [/eastern european/, "Eastern European restaurant", "kebabs, dumplings, and Eastern European plates"],
    [/xinjiang|uyghur|halal/, "halal restaurant", "kebabs, rice plates, and halal-friendly plates"],
    [/fine dining/, "fine-dining restaurant", "seasonal dinner plates and cocktails"],
    [/fast food/, "quick-service restaurant", "sandwiches, bowls, and quick bites"],
    [/south indian/, "South Indian restaurant", "dosas, idli, and tiffin plates"],
    [/north indian|indian/, "Indian restaurant", "curries, biryani, and tandoori plates"],
    [/cambodian/, "Cambodian restaurant", "Cambodian/Khmer plates"],
    [/vietnamese/, "Vietnamese restaurant", "pho, banh mi, and rice plates"],
    [/mexican/, "Mexican restaurant", "tacos, burritos, and Mexican plates"],
    [/sushi/, "sushi restaurant", "sushi rolls and Japanese plates"],
    [/ramen/, "ramen shop", "ramen bowls and Japanese small plates"],
    [/japanese curry/, "Japanese curry shop", "Japanese curry rice and cutlet plates"],
    [/izakaya/, "izakaya", "Japanese small plates and drinks"],
    [/tonkatsu/, "tonkatsu restaurant", "fried pork cutlets and Japanese set plates"],
    [/japanese/, "Japanese restaurant", "Japanese plates"],
    [/korean barbecue/, "Korean barbecue restaurant", "table-grilled meats and Korean sides"],
    [/korean/, "Korean restaurant", "Korean comfort plates, tofu stews, and barbecue"],
    [/chinese noodle/, "Chinese noodle shop", "Chinese noodle soups and wok dishes"],
    [/dumpling|dim sum|cantonese/, "Chinese dumpling and dim sum spot", "dumplings, buns, and Cantonese plates"],
    [/taiwanese/, "Taiwanese restaurant", "Taiwanese noodles, rice plates, and snacks"],
    [/chinese/, "Chinese restaurant", "Chinese plates"],
    [/thai/, "Thai restaurant", "Thai curries, noodles, and rice plates"],
    [/filipino/, "Filipino restaurant", "Filipino comfort plates"],
    [/hawaiian/, "Hawaiian spot", "poke, rice bowls, and island-style plates"],
    [/cajun/, "Cajun restaurant", "Cajun seafood boils and saucy shellfish"],
    [/seafood|oyster/, "seafood restaurant", "fish, crab, and seafood plates"],
    [/barbecue/, "barbecue restaurant", "barbecue plates and smoked meats"],
    [/brazilian/, "Brazilian steakhouse", "grilled meats and Brazilian sides"],
    [/peruvian/, "Peruvian restaurant", "Peruvian chicken, seafood, and rice plates"],
    [/burger|hamburger/, "burger spot", "burgers and fries"],
    [/pizza/, "pizza spot", "pizza and Italian-leaning casual plates"],
    [/italian/, "Italian restaurant", "pasta, pizza, and Italian plates"],
    [/french|bistro/, "French bistro", "French bistro plates"],
    [/greek/, "Greek restaurant", "gyros, souvlaki, and mezze"],
    [/israeli|middle eastern|mediterranean|lebanese|turkish/, "Mediterranean restaurant", "pita, kebabs, hummus, and mezze"],
    [/persian/, "Persian restaurant", "kebabs, rice plates, and Persian stews"],
    [/spanish|tapas/, "Spanish restaurant", "tapas and Spanish plates"],
    [/american|californian/, "American restaurant", "burgers, sandwiches, and American plates"],
    [/breakfast|brunch|diner/, "breakfast and brunch spot", "eggs, pancakes, and brunch plates"],
    [/sandwich|deli/, "sandwich shop", "sandwiches and quick lunch plates"],
    [/coffee|cafe/, "cafe", "coffee, pastries, and cafe bites"],
    [/tea/, "tea house", "tea drinks and sweet snacks"],
    [/bakery|pastry|donut|cake/, "bakery", "pastries, cakes, and baked goods"],
    [/ice cream|dessert|chocolate|confectionery/, "dessert shop", "desserts and sweet snacks"],
    [/wine/, "wine bar", "wine pours and small plates"],
    [/cocktail/, "cocktail bar", "cocktails and bar snacks"],
    [/\b(?:brew(?:pub|ery|ing)?|beer)\b/, "beer bar", "beer, taps, and pub bites"],
    [/\b(?:pub|bar and grill|gastropub|bar)\b/, "bar and grill", "burgers, drinks, and shareable plates"],
    [/food court/, "food hall", "multiple food vendors under one roof"],
    [/vegan|vegetarian/, "plant-based spot", "plant-based bowls and cafe plates"],
    [/asian fusion|fusion/, "Asian fusion restaurant", "Asian-fusion plates"],
  ];
  for (const [rx, label, food] of checks) {
    if (rx.test(t)) return { label, food };
  }
  return null;
}

export function inferFoodProfile(p, displayType) {
  const typeText = [displayType, ...(p.types || [])].filter(Boolean).join(" ");
  return foodProfileFromName(p.name || "", typeText)
    || foodProfileFromType(typeText)
    || { label: "restaurant", food: "dinner plates, drinks, and casual bites" };
}

function buildFoodProfileBlurb(p, ctx, profile) {
  const { cityName, street } = ctx;
  const priceLevel = priceTier(ctx.priceLevel);
  const where = street ? " in " + cityName + " on " + street : " in " + cityName;
  const priced = priceLevel ? ", " + priceLevel : "";
  const templates = [
    capFirst(profile.food) + where + priced + ".",
    cityName + " " + profile.label + " for " + profile.food + (street ? " on " + street : "") + ".",
  ];
  return pickTemplate(templates, p.id);
}

// Trim editorial summary if it has marketing fluff or runs too long.
function cleanEditorial(text) {
  if (!text) return null;
  let t = text.trim();
  // Strip leading "We're..." / "Our..." marketing voice that sometimes appears.
  t = t.replace(/^(We are|We're|Our|Welcome to)\b/i, "").trim();
  t = t
    .replace(/also serving a full menu of /gi, "also serving ")
    .replace(/serving a full menu of /gi, "serving ")
    .replace(/& a full menu of /gi, "& ");
  if (t.length > 220) {
    // Take first sentence
    const first = t.split(/(?<=[.!?])\s+/)[0]?.trim();
    if (first && first.length >= 40 && first.length <= 220) t = first;
    else t = t.slice(0, 200).replace(/\s+\S*$/, "") + ".";
  }
  if (t.length < 20) return null;
  if (!/[.!?]$/.test(t)) t += ".";
  return t;
}

// FOOD ----------------------------------------------------------------------
function blurbForFood(p, ctx) {
  const displayType = foodDisplayType(p);
  const profile = inferFoodProfile(p, displayType);
  return buildFoodProfileBlurb(p, ctx, profile);
}

// OUTDOOR -------------------------------------------------------------------
function blurbForOutdoor(p, ctx) {
  const { cityName, types } = ctx;
  const type = lowerType(p.displayType || "park");
  const isPark = /park\b/i.test(p.displayType || "") || (types || []).includes("park");
  const isHike = /hiking|trail|preserve|open space|nature/i.test(p.displayType || "");
  const isGarden = /garden|botanical/i.test(p.displayType || "");
  const isBeach = /beach|waterfront/i.test(p.displayType || "");
  const isPlayground = /playground/i.test((p.types || []).join(",")) || /playground/i.test(p.displayType || "");

  if (isPlayground) {
    const t = [
      `${cityName} playground — slides, swings, climbing structures.`,
      `${cityName} park with playground equipment for the kids.`,
      `Open green space and a playground in ${cityName}.`,
    ];
    return pickTemplate(t, p.id);
  }
  if (isHike) {
    const t = [
      `${cityName} ${type} with shaded trails and open-space stretches.`,
      `Hiking spot in the ${cityName} hills — ${type}.`,
      `${cityName} trail loop, easy to medium effort.`,
    ];
    return pickTemplate(t, p.id);
  }
  if (isGarden) {
    return `${cityName} ${type} for a slow stroll through plantings.`;
  }
  if (isBeach) {
    return `${cityName} waterfront — bring a layer for the wind.`;
  }
  if (isPark) {
    const t = [
      `${cityName} park with green space, paths, and picnic spots.`,
      `Open ${cityName} park — easy walk, room to spread out.`,
      `${cityName} neighborhood park, free to drop in.`,
      `${cityName} park for a quick outdoor reset.`,
    ];
    return pickTemplate(t, p.id);
  }
  return `${cityName} ${type} for an outdoor stretch.`;
}

function blurbForMuseum(p, ctx) {
  const { cityName, street } = ctx;
  const dt = (p.displayType || "").toLowerCase();
  const nameLower = (p.name || "").toLowerCase();
  const isLibrary = /library/.test(dt);
  const isGallery = /gallery|art museum/.test(dt) || /\bgallery\b/.test(nameLower);
  const isStudio = /studio/.test(dt) || /\bstudios?\b/.test(nameLower);

  if (isLibrary) {
    const t = [
      street ? `Public library on ${street} — open stacks, study tables, and quiet rooms.` : `${cityName}'s public library — open stacks, study tables, and quiet rooms.`,
      `${cityName} library, two floors of books and a kids' corner.`,
      `Free public library — easy hour with the kids or a quiet hour with a book.`,
    ];
    return pickTemplate(t, p.id);
  }
  if (isGallery) {
    return street ? `${cityName} gallery on ${street}, low-key drop-in.` : `${cityName} gallery, low-key drop-in.`;
  }
  if (isStudio) {
    return street
      ? `Art studio in ${cityName} on ${street} — check class and workshop times before you go.`
      : `Art studio in ${cityName} — check class and workshop times before you go.`;
  }
  // Google's type is too generic to describe a visit around (Services, Store, ...)
  if (/^(services|store|establishment)$/.test(dt)) {
    return street ? `${cityName} stop on ${street} — worth a quick visit.` : `${cityName} stop — worth a quick visit.`;
  }
  // Not actually a museum (university, mosque, cultural center, school...) —
  // describe it as what Google says it is rather than claiming "museum".
  if (dt && !/museum|historical|landmark|monument|planetarium|observation/.test(dt)) {
    return street ? `${p.displayType} in ${cityName} on ${street}.` : `${p.displayType} in ${cityName}.`;
  }
  // Real museum
  return street ? `${cityName} museum on ${street}, plan an hour or two.` : `${cityName} museum, plan an hour or two.`;
}

function blurbForShopping(p, ctx) {
  const { cityName, street, types } = ctx;
  const type = lowerType(p.displayType || "shop");
  const isBookstore = /book/i.test(p.displayType || "") || (types || []).includes("book_store");
  const isRecord = /record|music store/i.test(p.displayType || "");
  const isFarmers = /farmers/i.test(p.displayType || "");

  if (isBookstore) return street ? `${cityName} bookstore on ${street}, good for a slow browse.` : `${cityName} bookstore.`;
  if (isRecord) return street ? `${cityName} record shop on ${street} — bins to dig through.` : `${cityName} record shop.`;
  if (isFarmers) return `${cityName} farmers market — local produce, baked goods, samples.`;
  return street ? `${cityName} ${type} on ${street} — pick something up or just browse.` : `${cityName} ${type}.`;
}

function blurbForEntertainment(p, ctx) {
  const { cityName, street } = ctx;
  const dt = (p.displayType || "").toLowerCase();
  const type = lowerType(p.displayType || "venue");
  const isClimb = /climbing|bouldering/.test(dt);
  const isArcade = /arcade|bowling|laser tag|escape|amusement/.test(dt);
  const isCinema = /movie theater|cinema/.test(dt);
  const isStage = /performing arts|theater|theatre|opera|concert hall/.test(dt);
  const isCommunity = /community center|community hall|senior center|recreation center/.test(dt);
  const isEducational = /educational institution|art studio|art school|tutoring|learning center/.test(dt);
  const isSports = /sports activity|sports complex|sports club|fitness center|gym\b/.test(dt);
  const isStore = /\bstore\b/.test(dt);

  if (isClimb) return street ? `${cityName} climbing gym on ${street} — bring shoes or rent at the desk.` : `${cityName} climbing gym.`;
  if (isArcade) {
    const t = [
      street ? `${cityName} ${type} on ${street} — solid rainy-day option.` : `${cityName} ${type} — solid rainy-day option.`,
      `${cityName} indoor ${type}${street ? ` on ${street}` : ""}, easy with a group.`,
    ];
    return pickTemplate(t, p.id);
  }
  if (isCinema) {
    const t = [
      `${cityName} cinema${street ? ` on ${street}` : ""} — catch a screening.`,
      street ? `Movies on ${street} in ${cityName}.` : `Movie theater in ${cityName}.`,
      `${cityName} movie house${street ? ` on ${street}` : ""}, check the showtimes.`,
    ];
    return pickTemplate(t, p.id);
  }
  if (isStage) {
    const t = [
      `${cityName} stage${street ? ` on ${street}` : ""} — plays, music, and seasonal runs.`,
      `Live performance venue in ${cityName}${street ? ` on ${street}` : ""}.`,
      `${cityName} theater${street ? ` on ${street}` : ""}, check the season calendar.`,
    ];
    return pickTemplate(t, p.id);
  }
  if (isCommunity) {
    const t = [
      `${cityName} community center${street ? ` on ${street}` : ""} — classes, drop-in hours, public rooms.`,
      street ? `Community space on ${street} in ${cityName}.` : `${cityName} community space.`,
      `${cityName} rec hub${street ? ` on ${street}` : ""}, open to the public.`,
    ];
    return pickTemplate(t, p.id);
  }
  if (isEducational) {
    const t = [
      `${cityName} drop-in studio${street ? ` on ${street}` : ""} — workshops and classes.`,
      `${cityName} learning space${street ? ` on ${street}` : ""}, sign up or walk in.`,
    ];
    return pickTemplate(t, p.id);
  }
  if (isSports) {
    const t = [
      street ? `${cityName} sports facility on ${street}.` : `${cityName} sports facility.`,
      `${cityName} fitness spot${street ? ` on ${street}` : ""} — drop in for a session.`,
    ];
    return pickTemplate(t, p.id);
  }
  if (isStore) {
    return street ? `${cityName} ${type} on ${street}.` : `${cityName} ${type}.`;
  }
  const t = [
    street ? `${cityName} ${type} on ${street}.` : `${cityName} ${type}.`,
    `${cityName} stop${street ? ` on ${street}` : ""} — worth a look.`,
  ];
  return pickTemplate(t, p.id);
}

function blurbForWellness(p, ctx) {
  const { cityName, street } = ctx;
  const dt = (p.displayType || "").toLowerCase();
  const type = lowerType(p.displayType || "wellness");
  const isMassage = /massage/.test(dt);
  const isSpa = /\bspa\b/.test(dt) && !isMassage;
  const isYoga = /yoga|pilates|barre/.test(dt);
  const isSalon = /\b(beauty salon|hair salon|nail salon|salon|nail|barbershop)\b/.test(dt);
  const isSkin = /skin care|skincare|skin clinic|aesthetic|facial/.test(dt);
  const isChiro = /chiropract/.test(dt);

  if (isMassage) {
    const t = [
      street ? `${cityName} massage studio on ${street} — book ahead or walk in.` : `${cityName} massage studio — book ahead or walk in.`,
      `${cityName} massage spot${street ? ` on ${street}` : ""} for a quiet hour.`,
      `Massage in ${cityName}${street ? ` on ${street}` : ""}, full menu of styles.`,
    ];
    return pickTemplate(t, p.id);
  }
  if (isSpa) {
    const t = [
      `${cityName} day spa${street ? ` on ${street}` : ""} — facials, massage, the works.`,
      street ? `Spa on ${street} in ${cityName}, full menu of treatments.` : `${cityName} spa, full menu of treatments.`,
      `${cityName} treatment spa${street ? ` on ${street}` : ""}, book a slot and unwind.`,
    ];
    return pickTemplate(t, p.id);
  }
  if (isYoga) {
    const t = [
      street ? `${cityName} ${type} on ${street} — drop-in classes most days.` : `${cityName} ${type} — drop-in classes most days.`,
      `${cityName} ${type}${street ? ` on ${street}` : ""}, schedule online and grab a mat.`,
    ];
    return pickTemplate(t, p.id);
  }
  if (isSalon) {
    const t = [
      street ? `${cityName} ${type} on ${street}, walk-in or appointment.` : `${cityName} ${type}, walk-in or appointment.`,
      `${cityName} ${type}${street ? ` on ${street}` : ""} — book a chair.`,
    ];
    return pickTemplate(t, p.id);
  }
  if (isSkin) {
    return street ? `${cityName} skincare studio on ${street} — facials and treatments.` : `${cityName} skincare studio — facials and treatments.`;
  }
  if (isChiro) {
    return street ? `${cityName} chiropractor on ${street}.` : `${cityName} chiropractor.`;
  }
  return street ? `${cityName} ${type} on ${street}.` : `${cityName} ${type}.`;
}

// MAIN --------------------------------------------------------------------
const cache = {};
let researchHits = 0, templateHits = 0;

for (const p of places) {
  const cityName = CITY_NAMES[p.city] || p.city;
  const street = extractStreet(p.address, cityName, p.name);
  const category = isFoodPlace(p) ? "food" : p.category;
  const ctx = {
    cityName,
    street,
    priceLevel: p.priceLevel,
    indoorOutdoor: p.indoorOutdoor,
    types: p.types,
  };

  // Research-first: use Google's editorialSummary verbatim if present.
  const r = research[p.id];
  const summary = cleanEditorial(r?.editorialSummary);
  if (summary) {
    cache[p.id] = { blurb: cleanDisplayCopy(summary), source: "editorial", category };
    researchHits++;
    continue;
  }

  // Template fallback.
  let blurb;
  switch (category) {
    case "food": blurb = blurbForFood(p, ctx); break;
    case "outdoor": blurb = blurbForOutdoor(p, ctx); break;
    case "museum": blurb = blurbForMuseum(p, ctx); break;
    case "shopping": blurb = blurbForShopping(p, ctx); break;
    case "entertainment": blurb = blurbForEntertainment(p, ctx); break;
    case "wellness": blurb = blurbForWellness(p, ctx); break;
    case "arts": blurb = blurbForMuseum(p, ctx); break;
    case "neighborhood": {
      const t = [
        `${cityName}'s walkable strip — shops, food, somewhere to sit.`,
        `Wandering distance of shops and restaurants in ${cityName}${street ? ` along ${street}` : ""}.`,
        `${cityName}'s downtown — a few blocks worth of stops.`,
        `Pocket of ${cityName} you can park once and explore on foot.`,
      ];
      blurb = pickTemplate(t, p.id);
      break;
    }
    default: {
      const t = [
        street ? `${p.displayType || "Spot"} in ${cityName} on ${street}.` : `${p.displayType || "Spot"} in ${cityName}.`,
        `${cityName} stop${street ? ` on ${street}` : ""} — worth a quick visit.`,
      ];
      blurb = pickTemplate(t, p.id);
    }
  }
  cache[p.id] = { blurb: cleanDisplayCopy(blurb), source: "template", category };
  templateHits++;
}

const out = {
  _meta: {
    generatedAt: new Date().toISOString(),
    placeCount: places.length,
    blurbCount: Object.keys(cache).length,
    sources: { editorial: researchHits, template: templateHits },
  },
  blurbs: cache,
};

if (process.argv[1] === __filename) {
  writeFileAtomic(OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT}`);
  console.log(`  ${out._meta.blurbCount} blurbs (${researchHits} from Google editorialSummary, ${templateHits} from templates)`);
  console.log(`\nSample editorial (5):`);
  const editorialSamples = Object.entries(cache).filter(([, v]) => v.source === "editorial").slice(0, 5);
  for (const [id, v] of editorialSamples) {
    const p = places.find((x) => x.id === id);
    console.log(`  ${p?.name} → ${v.blurb}`);
  }
  console.log(`\nSample template (one per category):`);
  const cats = new Map();
  for (const p of places) {
    if (cats.size >= 8) break;
    if (cache[p.id].source !== "template") continue;
    if (cats.has(cache[p.id].category)) continue;
    cats.set(cache[p.id].category, { name: p.name, blurb: cache[p.id].blurb });
  }
  for (const [cat, x] of cats) console.log(`  [${cat}] ${x.name} → ${x.blurb}`);
}
