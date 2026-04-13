#!/usr/bin/env node
// One-time script to backfill venue photos for tonight-pick and wildcard slots

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEDULE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-schedule.json");
const ENV_FILE = join(__dirname, "..", "..", ".env.local");
const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

// Load env
try {
  const lines = readFileSync(ENV_FILE, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const apiKey = process.env.GOOGLE_PLACES_API_KEY;
const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

if (!apiKey) { console.log("No GOOGLE_PLACES_API_KEY"); process.exit(1); }
if (!blobToken) { console.log("No BLOB_READ_WRITE_TOKEN"); process.exit(1); }

const d = JSON.parse(readFileSync(SCHEDULE, "utf8"));
let count = 0;

for (const [date, day] of Object.entries(d.days || {})) {
  for (const slotType of ["tonight-pick", "wildcard"]) {
    const s = day[slotType];
    if (!s || s.imageUrl) continue;

    const item = s.item || {};
    const venue = item.venue || item.title || item.name;
    if (!venue) continue;

    try {
      const query = item.cityName ? `${venue} ${item.cityName}` : venue;
      const pRes = await fetch(PLACES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "places.photos",
        },
        body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
        signal: AbortSignal.timeout(8000),
      });
      if (!pRes.ok) { console.log(date, slotType, "places API error"); continue; }
      const pData = await pRes.json();
      const photoRef = pData.places?.[0]?.photos?.[0]?.name;
      if (!photoRef) { console.log(date, slotType, venue.slice(0, 30), "no photo found"); continue; }

      const photoUrl = `https://places.googleapis.com/v1/${photoRef}/media?maxWidthPx=1080&maxHeightPx=1350&key=${apiKey}`;
      const imgRes = await fetch(photoUrl, { redirect: "follow", signal: AbortSignal.timeout(10000) });
      if (!imgRes.ok) continue;
      const buf = Buffer.from(await imgRes.arrayBuffer());

      const { put } = await import("@vercel/blob");
      const ct = imgRes.headers.get("content-type") || "image/jpeg";
      const ext = ct.includes("png") ? "png" : "jpg";
      const pathname = `posters/${date}-${slotType}-venue.${ext}`;
      const result = await put(pathname, buf, { access: "public", contentType: ct, allowOverwrite: true, token: blobToken });

      s.imageUrl = result.url;
      s.imageStyle = "venue-photo";
      s.imageApprovedAt = new Date().toISOString();
      count++;
      console.log(date, slotType, venue.slice(0, 30), "✅");

      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      console.log(date, slotType, venue.slice(0, 30), "error:", e.message);
    }
  }
}

writeFileSync(SCHEDULE, JSON.stringify(d, null, 2) + "\n");
console.log(`\nDone: ${count} photos added and auto-approved`);
