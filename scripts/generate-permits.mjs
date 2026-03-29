/**
 * generate-permits.mjs
 * Fetches building permits issued in the last 7 days from San Jose's open data portal.
 * Outputs permit-pulse.json for the PermitPulseCard component.
 */

import { writeFileSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OUTPUT_PATH = join(
  __dirname,
  "../src/data/south-bay/permit-pulse.json"
);

const RESOURCE_ID = "045b3678-e923-4002-b696-300955bc6d06"; // Last 30 days permits
const API_BASE = "https://data.sanjoseca.gov/api/3/action/datastore_search";
const WINDOW_DAYS = 7;

function parseDate(str) {
  if (!str) return null;
  // Format: "3/28/2026 12:00:00 AM"
  const match = str.match(/^(\d+)\/(\d+)\/(\d{4})/);
  if (!match) return null;
  const [, m, d, y] = match;
  return new Date(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00-08:00`);
}

function toIsoDate(d) {
  if (!d) return null;
  return d.toISOString().split("T")[0];
}

function formatAddress(raw) {
  if (!raw) return "";
  // "1234  MAIN ST  , SAN JOSE CA 95110-1234" -> "1234 Main St"
  const clean = raw.replace(/\s+/g, " ").trim();
  const parts = clean.split(",");
  const street = parts[0]?.trim() ?? clean;
  // Title-case
  return street
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .replace(/ (\d+)$/, " #$1") // trailing unit number: "1234 Main St 2" -> "1234 Main St #2"
    .trim();
}

function cleanDescription(raw, workType, subtype) {
  if (!raw) return workType ?? "";
  let s = raw.trim();
  // Strip "(BEPM100%)", "(BEPM 80%)" etc.
  s = s.replace(/\(BEPM\s*\d+%\)\s*/gi, "");
  // Strip "(STAR)" flag
  s = s.replace(/\(STAR\)\s*/gi, "");
  // Strip "(B)" or "(E)" standalone flags
  s = s.replace(/^\([A-Z]\)\s*/, "");
  // Strip "UNOCCUPIED" standalone
  s = s.replace(/^UNOCCUPIED\s*/i, "");
  // Clean up double spaces
  s = s.replace(/\s+/g, " ").trim();
  // If empty after stripping, fall back
  if (!s) return subtype || workType || "";
  // Title-case
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b(Adu|Adu's|Ti|Of|At|And|Or|The|A|In|To|For)\b/g, (m) => m.toLowerCase())
    .replace(/^(\w)/, (c) => c.toUpperCase());
}

function categorize(record) {
  const desc = (record.FOLDERDESC ?? "").toLowerCase();
  const work = (record.WORKDESCRIPTION ?? "").toLowerCase();
  const name = (record.FOLDERNAME ?? "").toLowerCase();
  const val = parseInt(record.PERMITVALUATION ?? "0", 10) || 0;
  const units = parseInt(record.DWELLINGUNITS ?? "0", 10) || 0;

  const isResidential =
    desc.includes("family") ||
    desc.includes("dwelling") ||
    desc.includes("residential") ||
    desc.includes("accessory");
  const isMultiFamily =
    desc.includes("multiple") || desc.includes("multi") || units > 2;
  const isCommercial = desc.includes("commercial") || desc.includes("industrial");
  const isNewConstruction =
    work.includes("new construction") || work.includes("new constr");
  const isAddition = work.includes("addition") || work.includes("alteration");

  if (isResidential && isNewConstruction) {
    return isMultiFamily ? "multi-family-new" : "residential-new";
  }
  if (isCommercial && val >= 200_000) {
    return "commercial-large";
  }
  if (isResidential && val >= 200_000) {
    return "residential-large";
  }
  if (isNewConstruction) {
    return "new-construction";
  }
  if (isCommercial && val >= 50_000) {
    return "commercial";
  }
  return null; // not interesting enough
}

const CATEGORY_LABELS = {
  "multi-family-new": "New Multi-Family",
  "residential-new": "New Home",
  "commercial-large": "Commercial Project",
  "residential-large": "Major Renovation",
  "new-construction": "New Construction",
  commercial: "Commercial",
};

async function fetchAllPermits() {
  const limit = 500;
  let offset = 0;
  let all = [];

  while (true) {
    const url = `${API_BASE}?resource_id=${RESOURCE_ID}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "southbaysignal.org/permits-bot (+https://southbaysignal.org)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from permits API`);
    const body = await res.json();
    const records = body.result?.records ?? [];
    all = all.concat(records);
    if (records.length < limit) break;
    offset += limit;
    // Respect rate limits
    await new Promise((r) => setTimeout(r, 200));
  }

  return all;
}

function formatDateRange(cutoff, now) {
  const opts = { month: "short", day: "numeric", timeZone: "America/Los_Angeles" };
  const start = cutoff.toLocaleDateString("en-US", opts);
  const end = now.toLocaleDateString("en-US", opts);
  return `${start} – ${end}`;
}

async function main() {
  console.log("🏗️  Fetching San Jose building permits...");

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);

  let records;
  try {
    records = await fetchAllPermits();
  } catch (err) {
    console.error("  ❌ Failed to fetch permits:", err.message);
    process.exit(1);
  }

  console.log(`  📋 Fetched ${records.length} total records from last-30-days dataset`);

  // Filter to window
  const recent = records.filter((r) => {
    const d = parseDate(r.ISSUEDATE);
    return d && d >= cutoff;
  });

  console.log(`  📅 ${recent.length} permits issued in last ${WINDOW_DAYS} days`);

  // Categorize and filter for interesting permits
  const notable = [];
  let newUnits = 0;
  let totalValuation = 0;

  for (const r of recent) {
    const cat = categorize(r);
    const val = parseInt(r.PERMITVALUATION ?? "0", 10) || 0;
    const units = parseInt(r.DWELLINGUNITS ?? "0", 10) || 0;
    const work = (r.WORKDESCRIPTION ?? "").toLowerCase();
    const isNewConstr = work.includes("new construction") || work.includes("new constr");

    totalValuation += val;

    if (isNewConstr && units > 0) {
      newUnits += units;
    }

    if (cat) {
      notable.push({
        id: r.FOLDERNUMBER ?? r.FOLDERRSN,
        address: formatAddress(r.gx_location),
        category: cat,
        categoryLabel: CATEGORY_LABELS[cat] ?? cat,
        workType: r.WORKDESCRIPTION ?? "",
        description: cleanDescription(r.FOLDERNAME, r.WORKDESCRIPTION, r.SUBTYPEDESCRIPTION),
        valuation: val,
        units: parseInt(r.DWELLINGUNITS ?? "0", 10) || 0,
        issueDate: toIsoDate(parseDate(r.ISSUEDATE)),
        subtype: r.SUBTYPEDESCRIPTION ?? "",
      });
    }
  }

  // Sort: new construction first, then by valuation desc
  const CATEGORY_PRIORITY = {
    "multi-family-new": 0,
    "residential-new": 1,
    "new-construction": 2,
    "commercial-large": 3,
    "residential-large": 4,
    commercial: 5,
  };
  notable.sort((a, b) => {
    const pa = CATEGORY_PRIORITY[a.category] ?? 99;
    const pb = CATEGORY_PRIORITY[b.category] ?? 99;
    if (pa !== pb) return pa - pb;
    return b.valuation - a.valuation;
  });

  const top = notable.slice(0, 10);

  const cityEntry = {
    generatedAt: now.toISOString(),
    city: "San Jose",
    source: "data.sanjoseca.gov",
    sourceUrl: "https://data.sanjoseca.gov/dataset/last-30-days-building-permits",
    windowDays: WINDOW_DAYS,
    dateRange: formatDateRange(cutoff, now),
    stats: {
      total: recent.length,
      notable: notable.length,
      newUnits,
      totalValuation,
    },
    permits: top,
  };

  // Load existing data to preserve other cities, then upsert san-jose
  let existing = { cities: {} };
  try {
    existing = JSON.parse(readFileSync(OUTPUT_PATH, "utf-8"));
  } catch {}
  const output = { cities: { ...existing.cities, "san-jose": cityEntry } };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(
    `  ✅ Done — ${recent.length} permits this week, ${notable.length} notable, ${newUnits} new units → permit-pulse.json`
  );
  if (top.length > 0) {
    console.log("  Top permits:");
    for (const p of top.slice(0, 5)) {
      console.log(
        `    [${p.categoryLabel}] ${p.address} — $${(p.valuation / 1000).toFixed(0)}k ${p.workType}`
      );
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
