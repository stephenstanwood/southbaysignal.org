#!/usr/bin/env node
/**
 * generate-photos.mjs
 * Fetches CC-licensed photos from Flickr for each South Bay city.
 * Searches by geo bounding box + CC license, sorted by "interestingness".
 * Output: src/data/south-bay/photos.json
 *
 * Requires: FLICKR_API_KEY in environment or .env.local
 *
 * Flickr CC license IDs:
 *   1 = CC BY-NC-SA  2 = CC BY-NC  3 = CC BY-NC-ND
 *   4 = CC BY        5 = CC BY-SA  6 = CC BY-ND
 *   9 = CC0 (public domain)  10 = PDM
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "../src/data/south-bay/photos.json");

// Load .env.local if needed
if (!process.env.FLICKR_API_KEY && existsSync(join(__dirname, "../.env.local"))) {
  const env = readFileSync(join(__dirname, "../.env.local"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const API_KEY = process.env.FLICKR_API_KEY;
if (!API_KEY) {
  console.error("❌ FLICKR_API_KEY not set");
  process.exit(1);
}

const UA = "SouthBaySignal/1.0 (southbaysignal.org; educational/noncommercial)";

// CC licenses that allow reuse with attribution (excluding NC variants for safety)
const CC_LICENSES = "4,5,6,9,10"; // CC BY, CC BY-SA, CC BY-ND, CC0, PDM

// Bounding boxes: [minLon, minLat, maxLon, maxLat]
const CITIES = [
  { id: "san-jose",      label: "San Jose",      bbox: "-122.035,37.197,-121.775,37.469", tags: "sanjose,downtownsanjose,sanjoseca" },
  { id: "campbell",      label: "Campbell",       bbox: "-122.00,37.255,-121.935,37.295",  tags: "campbell,campbellca,campbellcalifornia" },
  { id: "los-gatos",     label: "Los Gatos",      bbox: "-122.00,37.21,-121.94,37.26",     tags: "losgatos,losgatosca" },
  { id: "saratoga",      label: "Saratoga",       bbox: "-122.06,37.24,-122.00,37.29",     tags: "saratoga,saratogaca" },
  { id: "cupertino",     label: "Cupertino",      bbox: "-122.08,37.29,-122.00,37.34",     tags: "cupertino,cupertinoca" },
  { id: "milpitas",      label: "Milpitas",       bbox: "-121.95,37.40,-121.87,37.45",     tags: "milpitas,milpitasca" },
  { id: "santa-clara",   label: "Santa Clara",    bbox: "-122.00,37.33,-121.94,37.38",     tags: "santaclara,santaclaraca" },
  { id: "mountain-view", label: "Mountain View",  bbox: "-122.12,37.37,-122.04,37.42",     tags: "mountainview,mountainviewca" },
  { id: "palo-alto",     label: "Palo Alto",      bbox: "-122.18,37.40,-122.09,37.47",     tags: "paloalto,paloaltoca" },
  { id: "los-altos",     label: "Los Altos",      bbox: "-122.13,37.36,-122.07,37.40",     tags: "losaltos,losaltosca" },
  { id: "sunnyvale",     label: "Sunnyvale",      bbox: "-122.07,37.35,-121.99,37.40",     tags: "sunnyvale,sunnyvaleca" },
];

const PHOTOS_PER_CITY = 8;
const BASE = "https://www.flickr.com/services/rest/";

async function flickrSearch(city) {
  const params = new URLSearchParams({
    method: "flickr.photos.search",
    api_key: API_KEY,
    bbox: city.bbox,
    license: CC_LICENSES,
    sort: "interestingness-desc",
    per_page: String(PHOTOS_PER_CITY),
    page: "1",
    extras: "url_m,url_l,url_o,owner_name,license,geo,tags,title,views",
    content_type: "1", // photos only, no screenshots
    safe_search: "1",
    format: "json",
    nojsoncallback: "1",
  });

  const url = `${BASE}?${params}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Flickr ${res.status}`);
  const data = await res.json();
  if (data.stat !== "ok") throw new Error(`Flickr error: ${data.message}`);
  return data.photos.photo;
}

function licenseLabel(id) {
  const labels = {
    "4": "CC BY", "5": "CC BY-SA", "6": "CC BY-ND",
    "9": "CC0", "10": "PDM",
  };
  return labels[String(id)] || "CC";
}

function licenseUrl(id) {
  const urls = {
    "4": "https://creativecommons.org/licenses/by/2.0/",
    "5": "https://creativecommons.org/licenses/by-sa/2.0/",
    "6": "https://creativecommons.org/licenses/by-nd/2.0/",
    "9": "https://creativecommons.org/publicdomain/zero/1.0/",
    "10": "https://creativecommons.org/publicdomain/mark/1.0/",
  };
  return urls[String(id)] || "https://creativecommons.org/licenses/";
}

async function main() {
  console.log("📷 Fetching Flickr CC photos for South Bay cities...");

  const results = {};
  let total = 0;

  for (const city of CITIES) {
    try {
      const photos = await flickrSearch(city);
      const cleaned = photos
        .filter((p) => p.url_m || p.url_l) // must have at least medium URL
        .map((p) => ({
          id: p.id,
          title: p.title || "",
          url: p.url_l || p.url_m,          // prefer large
          thumb: p.url_m,                    // medium for thumbnails
          photographer: p.ownername || "",
          photoPage: `https://www.flickr.com/photos/${p.owner}/${p.id}`,
          license: licenseLabel(p.license),
          licenseUrl: licenseUrl(p.license),
        }));

      results[city.id] = cleaned;
      total += cleaned.length;
      console.log(`  ✅ ${city.label}: ${cleaned.length} photos`);

      // Be polite — small delay between cities
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.log(`  ⚠️  ${city.label}: ${err.message}`);
      results[city.id] = [];
    }
  }

  const out = {
    generated: new Date().toISOString(),
    cities: results,
  };

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n✅ Done — ${total} photos across ${CITIES.length} cities → ${OUT}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
