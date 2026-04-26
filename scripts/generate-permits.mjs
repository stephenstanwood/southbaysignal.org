/**
 * generate-permits.mjs
 * Fetches building permits issued in the last 7 days from:
 *   - San Jose (data.sanjoseca.gov CKAN API)
 *   - Palo Alto (gis.cityofpaloalto.org PermitView API)
 * Outputs permit-pulse.json for the PermitPulseCard component.
 *
 * Cities investigated but blocked (as of April 2026):
 *   - Mountain View: developmentpermits.mountainview.gov → 403 (blocked by server)
 *                    epermits.mountainview.gov → React SPA for permit applications, no data API
 *                    data-mountainview.opendata.arcgis.com → 22 geographic datasets, no permit data
 *                    data.mountainview.gov → ECONNREFUSED (dead)
 *                    Mountain View uses an internal permit system with no public API.
 *   - Sunnyvale: data.sunnyvale.ca.gov, epermits.sunnyvale.ca.gov → all ECONNREFUSED/timeout
 *                No Socrata or ArcGIS public permit dataset found.
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

  // Skip boring residential maintenance — reroofs, HVAC, water heaters, etc.
  const isRoutineMaintenance =
    work.includes("reroof") ||
    work.includes("re-roof") ||
    work.includes("roofing") ||
    work.includes("roof replacement") ||
    work.includes("hvac") ||
    work.includes("water heater") ||
    work.includes("furnace") ||
    work.includes("solar panel") ||
    work.includes("electrical panel") ||
    work.includes("sewer") ||
    work.includes("plumbing");
  if (isResidential && isRoutineMaintenance) return null;

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
      headers: { "User-Agent": "southbaytoday.org/permits-bot (+https://southbaytoday.org)" },
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

// ── Palo Alto ──────────────────────────────────────────────────────────────

const PA_PERMIT_VIEW = "https://gis.cityofpaloalto.org/PermitView";

// Categories we surface (Palo Alto has no valuation data, so we focus on type)
const PA_INTERESTING_CATEGORIES = new Set([
  "Building Permit",
  "Building",
  "Entitlement",
  "Zoning",
  "Web - Kitchen or Bath Remodel",
]);

function parsePaDate(str) {
  if (!str) return null;
  // "2026-03-25 00:00:00.0000000"
  const m = str.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function formatPaAddress(raw) {
  if (!raw) return "";
  // "3173 SOUTH CT, PALO ALTO, CA 94306" — strip city/state/zip
  const parts = raw.split(",");
  const street = (parts[0] ?? raw).trim();
  return street
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ");
}

function categorizePa(record) {
  const cat = record.RECORD_TYPE_CATEGORY ?? "";
  const desc = (record.DESCRIPTION ?? "").toLowerCase();

  // Residential signal — covers "RES:" / "Res:" prefix, "Residential -", "single family",
  // "single-family", "ADU", "duplex". PermitView descriptions lead with these consistently.
  const isResidential =
    /^\s*res(?:idential)?\s*[-:]/.test(desc) ||
    desc.includes("single family") ||
    desc.includes("single-family") ||
    desc.includes("\badu\b") ||
    /\badu\b/.test(desc) ||
    desc.includes("duplex");

  // Mirror San Jose: skip boring residential maintenance so the card highlights real changes.
  const isRoutineMaintenance =
    desc.includes("heat pump") ||
    desc.includes("water heater") ||
    desc.includes("hvac") ||
    desc.includes("furnace") ||
    desc.includes("ev charger") ||
    desc.includes("electrical panel") ||
    desc.includes("main panel") ||
    desc.includes("sub panel") ||
    desc.includes("subpanel") ||
    desc.includes("solar panel") ||
    desc.includes("solar pv") ||
    desc.includes("re-roof") ||
    desc.includes("reroof") ||
    /\broof\w*\b/.test(desc) ||
    desc.includes("sewer") ||
    desc.includes("plumbing") ||
    desc.includes("window replacement") ||
    desc.includes("water service");
  if (isResidential && isRoutineMaintenance) return null;

  const isNew =
    desc.includes("new") && (desc.includes("construction") || desc.includes("dwelling") || desc.includes("adu") || desc.includes("sfr") || desc.includes("multi"));
  const isCommercial =
    desc.includes("ti:") || desc.includes("tenant improvement") || desc.includes("commercial") || desc.includes("office");
  const isRemodel = desc.includes("remodel") || desc.includes("kitchen") || desc.includes("bath");
  const isAddition = desc.includes("addition");
  const isEntitlement = cat === "Entitlement" || cat === "Zoning";

  if (isEntitlement) return "entitlement";
  if (isNew) return "new-construction";
  if (isCommercial && !isResidential) return "commercial";
  if (isResidential && isAddition) return "residential-large";
  if (isResidential && isRemodel) return "residential-remodel";
  // Drop everything else — generic residential maintenance shouldn't take a slot.
  return null;
}

const PA_CATEGORY_LABELS = {
  "new-construction": "New Construction",
  commercial: "Commercial Project",
  "residential-large": "Addition",
  "residential-remodel": "Home Remodel",
  entitlement: "Entitlement / Zoning",
};

async function fetchPaloAltoPermits(cutoffStr) {
  // 1. Get session + CSRF token
  const page = await fetch(`${PA_PERMIT_VIEW}/`, {
    headers: { "User-Agent": "southbaytoday.org/permits-bot (+https://southbaytoday.org)" },
  });
  if (!page.ok) throw new Error(`PermitView page HTTP ${page.status}`);

  const allCookies = page.headers.getSetCookie
    ? page.headers.getSetCookie()
    : [page.headers.get("set-cookie")].filter(Boolean);
  const cookieParts = allCookies.map((c) => c.split(";")[0]).join("; ");
  const xsrfMatch = cookieParts.match(/XSRF-TOKEN=([^;]+)/);
  const xsrfDecoded = xsrfMatch ? decodeURIComponent(xsrfMatch[1]) : "";

  const html = await page.text();
  const csrf = html.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1] ?? "";

  // 2. Query permits opened since cutoff
  const formData = new URLSearchParams();
  formData.append("where", `p.DATE_OPENED >= '${cutoffStr}' AND p.ADDR_FULL_LINE != 'NULL'`);

  const res = await fetch(`${PA_PERMIT_VIEW}/get-remote-data`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-TOKEN": csrf,
      "X-XSRF-TOKEN": xsrfDecoded,
      "X-Requested-With": "XMLHttpRequest",
      Cookie: cookieParts,
      Referer: `${PA_PERMIT_VIEW}/`,
      "User-Agent": "southbaytoday.org/permits-bot (+https://southbaytoday.org)",
    },
    body: formData.toString(),
  });
  if (!res.ok) throw new Error(`PermitView data HTTP ${res.status}`);
  const body = await res.json();
  return body.data ?? [];
}

async function mainPaloAlto() {
  console.log("\n🏗️  Fetching Palo Alto building permits...");

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  let records;
  try {
    records = await fetchPaloAltoPermits(cutoffStr);
  } catch (err) {
    console.error("  ❌ Palo Alto fetch failed:", err.message);
    return null;
  }

  console.log(`  📋 ${records.length} permits opened since ${cutoffStr}`);

  // Only show "Issued" or "Over the Counter Approved" permits as confirmed issued
  const issued = records.filter((r) =>
    ["Permit Issued", "Over the Counter Approved", "Finaled"].includes(r.RECORD_STATUS)
  );
  console.log(`  📅 ${issued.length} permits with issued/approved status`);

  const notable = [];
  for (const r of issued) {
    const cat = categorizePa(r);
    if (!cat) continue;
    notable.push({
      id: r.RECORD_ID,
      address: formatPaAddress(r.ADDR_FULL_LINE),
      category: cat,
      categoryLabel: PA_CATEGORY_LABELS[cat] ?? cat,
      workType: r.RECORD_TYPE_CATEGORY ?? "",
      description: (r.DESCRIPTION ?? "").replace(/\s*\n\s*/g, " ").trim(),
      valuation: 0, // not available from PermitView
      units: 0,
      issueDate: parsePaDate(r.DATE_OPENED),
      subtype: r.RECORD_STATUS ?? "",
    });
  }

  const PA_CAT_PRIORITY = { "new-construction": 0, commercial: 1, "residential-large": 2, "residential-remodel": 3, entitlement: 4 };
  notable.sort((a, b) => (PA_CAT_PRIORITY[a.category] ?? 9) - (PA_CAT_PRIORITY[b.category] ?? 9));
  const top = notable.slice(0, 10);

  const opts = { month: "short", day: "numeric", timeZone: "America/Los_Angeles" };
  const dateRange = `${cutoff.toLocaleDateString("en-US", opts)} – ${now.toLocaleDateString("en-US", opts)}`;

  console.log(`  ✅ Done — ${issued.length} issued, ${notable.length} notable`);
  if (top.length > 0) {
    for (const p of top.slice(0, 5)) {
      console.log(`    [${p.categoryLabel}] ${p.address} — ${p.description.slice(0, 60)}`);
    }
  }

  return {
    generatedAt: now.toISOString(),
    city: "Palo Alto",
    source: "gis.cityofpaloalto.org",
    sourceUrl: "https://gis.cityofpaloalto.org/PermitView/",
    windowDays: WINDOW_DAYS,
    dateRange,
    stats: {
      total: records.length,
      notable: notable.length,
      newUnits: 0,
      totalValuation: 0,
    },
    permits: top,
  };
}

async function mainAll() {
  await main();

  const paEntry = await mainPaloAlto();
  if (paEntry) {
    let existing = { cities: {} };
    try { existing = JSON.parse(readFileSync(OUTPUT_PATH, "utf-8")); } catch {}
    const output = { cities: { ...existing.cities, "palo-alto": paEntry } };
    writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log("  ✅ Palo Alto written to permit-pulse.json");
  }
}

mainAll().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
