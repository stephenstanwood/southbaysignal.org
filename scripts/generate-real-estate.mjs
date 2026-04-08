#!/usr/bin/env node
/**
 * generate-real-estate.mjs
 *
 * Streams the Redfin city-level market tracker (gzipped TSV) and extracts
 * the most recent monthly snapshot for South Bay cities.
 *
 * Source: Redfin Data Center (public, no auth required)
 * Run: node scripts/generate-real-estate.mjs
 */

import { writeFileSync, createWriteStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createGunzip } from "zlib";
import { createInterface } from "readline";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "real-estate.json");

const REDFIN_URL =
  "https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker/city_market_tracker.tsv000.gz";

const SOUTH_BAY_CITIES = new Set([
  "Campbell", "Cupertino", "Los Altos", "Los Gatos", "Milpitas",
  "Mountain View", "Palo Alto", "San Jose", "Santa Clara", "Saratoga", "Sunnyvale",
]);

const CITY_DISPLAY = { "San Jose": "San José" };

// Column indices (0-based)
const COL = {
  PERIOD_END: 1,
  STATE_CODE: 10,
  CITY: 8,
  PROPERTY_TYPE: 11,
  MEDIAN_SALE_PRICE: 13,
  MEDIAN_SALE_PRICE_YOY: 15,
  INVENTORY: 34,
  MEDIAN_DOM: 40,
  AVG_SALE_TO_LIST: 43,
  SOLD_ABOVE_LIST: 46,
};

function parseNum(s) {
  if (!s || s === "N/A" || !s.trim()) return null;
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}

const MAX_RETRIES = 2;
const TIMEOUT_MS = 300_000;

async function fetchWithRetry() {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = attempt * 5_000;
        console.log(`  Retry ${attempt}/${MAX_RETRIES} after ${delay / 1000}s…`);
        await new Promise((r) => setTimeout(r, delay));
      }
      const res = await fetch(REDFIN_URL, {
        headers: { "User-Agent": "SouthBaySignal/1.0 (southbaysignal.org; public data)" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      console.error(`  Attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === MAX_RETRIES) throw err;
    }
  }
}

async function main() {
  console.log("Streaming Redfin city market tracker…");

  const res = await fetchWithRetry();

  const nodeStream = Readable.fromWeb(res.body);
  const gunzip = createGunzip();
  const rl = createInterface({ input: nodeStream.pipe(gunzip), crlfDelay: Infinity });

  let lineNum = 0;
  let headers = null;
  const best = new Map(); // city → { periodEnd, cols }

  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;

    const cols = line.split("\t").map((c) => c.replace(/^"|"$/g, ""));

    if (lineNum === 1) {
      headers = cols;
      continue;
    }

    if (cols[COL.STATE_CODE] !== "CA") continue;
    if (cols[COL.PROPERTY_TYPE] !== "All Residential") continue;

    const city = cols[COL.CITY];
    if (!SOUTH_BAY_CITIES.has(city)) continue;

    const periodEnd = cols[COL.PERIOD_END];
    const existing = best.get(city);
    if (!existing || periodEnd > existing.periodEnd) {
      best.set(city, { periodEnd, cols });
    }
  }

  console.log(`  Scanned ${lineNum.toLocaleString()} rows, found ${best.size} cities`);

  const cities = [...best.entries()]
    .map(([city, { periodEnd, cols }]) => ({
      city: CITY_DISPLAY[city] ?? city,
      cityId: city.toLowerCase().replace(/\s+/g, "-"),
      periodEnd,
      medianSalePrice: parseNum(cols[COL.MEDIAN_SALE_PRICE]),
      // Los Altos YoY is unreliable due to small sample size — null it out to avoid outlier spikes
      medianSalePriceYoy: city === "Los Altos" ? null : parseNum(cols[COL.MEDIAN_SALE_PRICE_YOY]),
      inventory: (() => { const n = parseNum(cols[COL.INVENTORY]); return n != null ? Math.round(n) : null; })(),
      medianDaysOnMarket: (() => { const n = parseNum(cols[COL.MEDIAN_DOM]); return n != null ? Math.round(n) : null; })(),
      avgSaleToList: parseNum(cols[COL.AVG_SALE_TO_LIST]),
      soldAboveListPct: parseNum(cols[COL.SOLD_ABOVE_LIST]),
    }))
    .sort((a, b) => a.city.localeCompare(b.city));

  const output = {
    cities,
    generatedAt: new Date().toISOString(),
    source: "Redfin Data Center",
    sourceUrl: "https://www.redfin.com/news/data-center/",
    attribution: "Data sourced from Redfin (redfin.com). All Residential, monthly.",
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n✅ ${cities.length} cities written to real-estate.json`);
  cities.forEach((c) => {
    const price = c.medianSalePrice ? `$${(c.medianSalePrice / 1000).toFixed(0)}K` : "N/A";
    const yoy = c.medianSalePriceYoy != null
      ? ` (${c.medianSalePriceYoy >= 0 ? "+" : ""}${(c.medianSalePriceYoy * 100).toFixed(1)}% YoY)`
      : "";
    const dom = c.medianDaysOnMarket != null ? ` · ${c.medianDaysOnMarket}d on market` : "";
    console.log(`  • ${c.city}: ${price}${yoy}${dom}`);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
