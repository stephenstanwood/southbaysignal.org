#!/usr/bin/env node
/**
 * generate-apod.mjs
 *
 * Fetches the last 12 NASA Astronomy Picture of the Day (APOD) images.
 * Filters for actual images (not videos). Saves to src/data/south-bay/apod.json.
 *
 * API: https://api.nasa.gov/planetary/apod
 * Rate limit: DEMO_KEY = 30 req/hr, 50 req/day. One call per run → fine.
 *
 * Run: node scripts/generate-apod.mjs
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "apod.json");

const API_KEY = process.env.NASA_API_KEY || "DEMO_KEY";

// Fetch the last 14 days; filter to images only, keep up to 12
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const startDate = daysAgo(14);
  const endDate = daysAgo(0);
  const url = `https://api.nasa.gov/planetary/apod?api_key=${API_KEY}&start_date=${startDate}&end_date=${endDate}&thumbs=true`;

  console.log(`Fetching NASA APOD (${startDate} → ${endDate})…`);
  const res = await fetch(url, {
    headers: { "User-Agent": "SouthBaySignal/1.0 (southbaysignal.org; public data)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);

  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error("Unexpected response shape");

  // Keep images only (skip embedded YouTube/Vimeo videos)
  const items = raw
    .filter((d) => d.media_type === "image")
    .slice(-12) // most recent 12
    .reverse()  // newest first
    .map((d) => ({
      date: d.date,
      title: d.title,
      explanation: d.explanation,
      url: d.url,           // standard resolution
      hdurl: d.hdurl ?? d.url,
      copyright: d.copyright?.replace(/\n/g, " ").trim() ?? null,
    }));

  const output = {
    items,
    generatedAt: new Date().toISOString(),
    source: "NASA Astronomy Picture of the Day",
    sourceUrl: "https://apod.nasa.gov/apod/astropix.html",
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`✅ ${items.length} APOD images written to apod.json`);
  items.forEach((i) => console.log(`  • ${i.date}: ${i.title}`));
}

main().catch((err) => { console.error(err); process.exit(1); });
