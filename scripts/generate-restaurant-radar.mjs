#!/usr/bin/env node
/**
 * generate-restaurant-radar.mjs
 *
 * Fetches recent restaurant-related building permits from San Jose's open data
 * to surface new buildouts, major renovations, and demolitions as opening/closing signals.
 *
 * Run: node scripts/generate-restaurant-radar.mjs
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "restaurant-radar.json");

const API_BASE = "https://data.sanjoseca.gov/api/3/action/datastore_search";
// "Last 30 days building permits" dataset
const RESOURCE_ID = "045b3678-e923-4002-b696-300955bc6d06";

// Food service subtypes to search for
const FOOD_TERMS = ["restaurant", "café", "cafe", "bakery", "food service", "bar", "brewery", "winery", "kitchen"];

// Work types that signal new/opening activity
const OPENING_WORK_TYPES = new Set([
  "tenant improvement",
  "finish interior",
  "new construction",
  "addition",
  "alteration",
  "change of occupancy",
]);

// Work types that signal closure/removal
const CLOSING_WORK_TYPES = new Set(["demolition"]);

function parseDate(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)\/(\d+)\/(\d{4})/);
  if (!match) return null;
  const [, m, d, y] = match;
  return new Date(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T12:00:00-08:00`);
}

function formatAddress(raw) {
  if (!raw) return "";
  const clean = raw.replace(/\s+/g, " ").trim();
  const parts = clean.split(",");
  const street = parts[0]?.trim() ?? clean;
  return street
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .replace(/ (\d+)$/, " #$1")
    .trim();
}

/**
 * Try to extract a business name from a San Jose permit FOLDERNAME.
 * Permit names follow patterns like:
 *   "(Bepm100%) Flora Ti"
 *   "(Bepm100%) Srp La Victoria Ti"
 *   "Srp (Bemp100%) Fomo Ti #A16"
 *   "Jc'S Bbq (Bepm 100%) Interior Ti"
 *   "Taco Bell (E 100%) Sign"
 *   "(Bp100%) Demo Restaurant"  ← no real name, return null
 */
function extractName(raw) {
  if (!raw) return null;
  let s = raw.trim();

  // Remove ALL parenthetical expressions (permit codes, completion %)
  s = s.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();

  // Strip "Srp " prefix (placeholder owner code used by SJ)
  s = s.replace(/^Srp\s+/i, "").trim();

  // Strip trailing noise: "Ti", "#A16", "#1808 Restaurant Ti", "Interior", etc.
  s = s.replace(/\s+#\s*\d+.*$/, "").trim();
  s = s.replace(/\s+(Interior|Restaurant|Tenant|Improvement|Ti|Demo|Sign|Tbd)\b.*$/i, "").trim();

  // Strip trailing punctuation/spaces
  s = s.replace(/[,\s]+$/, "").trim();

  // Too short or too generic → no name
  if (!s || s.length < 3) return null;
  const generic = /^(demo|demolition|n\/a|restaurant|kitchen|bar|cafe|bakery|food)$/i;
  if (generic.test(s)) return null;

  // Title-case the result
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bBbq\b/gi, "BBQ")
    .replace(/\bJc\b/gi, "JC")
    .replace(/\bJcs\b/gi, "JC's");
}

function signalFromWork(workType) {
  const w = workType.toLowerCase();
  if (CLOSING_WORK_TYPES.has(w)) return "closing";
  if (OPENING_WORK_TYPES.has(w)) return "opening";
  return "activity";
}

function labelFromSignal(signal, workType, valuation) {
  if (signal === "closing") return "Possible Closure";
  if (workType.toLowerCase().includes("finish interior") || workType.toLowerCase().includes("new construction")) {
    return "New Build";
  }
  if (workType.toLowerCase() === "tenant improvement") {
    if (valuation >= 500_000) return "Major Buildout";
    if (valuation >= 100_000) return "New Buildout";
    return "Renovation";
  }
  return "Permit Activity";
}

async function main() {
  console.log("Fetching restaurant permit activity from San Jose open data…");

  const allRecords = [];

  for (const term of FOOD_TERMS) {
    const url = `${API_BASE}?resource_id=${RESOURCE_ID}&q=${encodeURIComponent(term)}&limit=200`;
    const res = await fetch(url, {
      headers: { "User-Agent": "SouthBaySignal/1.0 (southbaysignal.org; public data)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.warn(`  HTTP ${res.status} for "${term}"`);
      continue;
    }
    const data = await res.json();
    const records = data.result?.records ?? [];
    allRecords.push(...records);
    console.log(`  "${term}": ${records.length} permits`);
  }

  // Deduplicate by permit folder number
  const seen = new Set();
  const unique = allRecords.filter((r) => {
    const key = r.FOLDERNUMBER ?? r._id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  ${unique.length} unique permits after dedup`);

  // Filter + enrich
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 45);

  const items = unique
    .map((r) => {
      const date = parseDate(r.ISSUEDATE);
      if (!date || date < cutoffDate) return null;

      // Skip residential permits (kitchen remodel in houses, condos, etc.)
      const folderDesc = (r.FOLDERDESC ?? "").toLowerCase();
      const subDesc = (r.SUBTYPEDESCRIPTION ?? "").toLowerCase();
      const isResidential =
        folderDesc.includes("family") ||
        folderDesc.includes("dwelling") ||
        folderDesc.includes("residential") ||
        subDesc.includes("single-family") ||
        subDesc.includes("condo") ||
        subDesc.includes("duplex");
      if (isResidential) return null;

      const workType = (r.WORKDESCRIPTION ?? "").trim();
      const subtype = (r.SUBTYPEDESCRIPTION ?? r.FOLDERDESC ?? "").trim();
      const valuation = parseInt(r.PERMITVALUATION ?? "0", 10) || 0;
      const signal = signalFromWork(workType);
      const label = labelFromSignal(signal, workType, valuation);

      // Skip very minor work (sub-trades, re-roofs, signage) unless demolition
      const workLower = workType.toLowerCase();
      if (
        signal !== "closing" &&
        (workLower.includes("sub-trade") ||
          workLower.includes("reroof") ||
          workLower.includes("re-roof") ||
          workLower.includes("sign") ||
          workLower === "plumbing only" ||
          workLower === "electrical only" ||
          workLower === "mechanical only")
      ) {
        return null;
      }

      const rawName = r.FOLDERNAME ?? null;
      const name = extractName(rawName);

      return {
        id: r.FOLDERNUMBER ?? String(r._id),
        address: formatAddress(r.gx_location),
        name: name ?? null,
        description: rawName
          ? rawName.trim()
              .toLowerCase()
              .replace(/\b\w/g, (c) => c.toUpperCase())
          : workType,
        workType,
        subtype,
        signal,
        label,
        valuation,
        date: date.toISOString().slice(0, 10),
      };
    })
    .filter(Boolean);

  // Sort: closing first (most newsworthy), then by valuation desc, then date desc
  items.sort((a, b) => {
    if (a.signal === "closing" && b.signal !== "closing") return -1;
    if (b.signal === "closing" && a.signal !== "closing") return 1;
    if (b.valuation !== a.valuation) return b.valuation - a.valuation;
    return b.date.localeCompare(a.date);
  });

  // Enrich items missing names using Google Places (best-effort)
  const topItems = items.slice(0, 20);
  if (GOOGLE_PLACES_API_KEY) {
    const unnamed = topItems.filter((it) => !it.name);
    if (unnamed.length > 0) {
      console.log(`\n  🔍 Looking up ${unnamed.length} unnamed permit locations via Google Places…`);
      for (const item of unnamed) {
        try {
          const query = `restaurant ${item.address}, San Jose, CA`;
          const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=name,formatted_address,business_status&key=${GOOGLE_PLACES_API_KEY}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) continue;
          const data = await res.json();
          const candidate = data.candidates?.[0];
          if (candidate?.name) {
            item.name = candidate.name;
            const status = candidate.business_status;
            if (status === "CLOSED_PERMANENTLY" || status === "CLOSED_TEMPORARILY") {
              item.description = `${candidate.name} (${status === "CLOSED_PERMANENTLY" ? "permanently closed" : "temporarily closed"})`;
            }
            console.log(`    ✓ ${item.address} → ${candidate.name}${status ? ` [${status}]` : ""}`);
          }
          await new Promise((r) => setTimeout(r, 200)); // rate limit
        } catch (err) {
          console.log(`    ⚠️ ${item.address}: ${err.message}`);
        }
      }
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    city: "San Jose",
    windowDays: 45,
    source: "data.sanjoseca.gov",
    sourceUrl: "https://data.sanjoseca.gov/dataset/last-30-days-building-permits",
    items: topItems,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n✅ ${items.length} restaurant permit signals → restaurant-radar.json`);
  items.forEach((it) =>
    console.log(`  [${it.label}] ${it.address} — ${it.workType}${it.valuation ? ` ($${it.valuation.toLocaleString()})` : ""}`)
  );
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
