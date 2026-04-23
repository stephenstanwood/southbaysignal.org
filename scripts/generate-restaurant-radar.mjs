#!/usr/bin/env node
/**
 * generate-restaurant-radar.mjs
 *
 * Fetches recent restaurant-related building permits from:
 *   - San Jose (data.sanjoseca.gov CKAN API)
 *   - Palo Alto (gis.cityofpaloalto.org PermitView)
 * to surface new buildouts, openings, and closures.
 *
 * Run: node scripts/generate-restaurant-radar.mjs
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const PA_PERMIT_VIEW = "https://gis.cityofpaloalto.org/PermitView";

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";

/**
 * Manual overrides — keyed by "city:address" (lowercase, normalized).
 * These survive regeneration and fill in name/blurb when permit text is ambiguous.
 * city: the city id (e.g. "san-jose", "palo-alto")
 * address: the formatted address string as it appears in the output
 */
/**
 * Addresses to exclude entirely — keyed by "city:address".
 * Use for non-food false positives that slip through the keyword filter.
 */
const SKIP_ADDRESSES = new Set([
  "palo-alto:220 Hamilton Av", // Palo Alto Eyes — eyewear store, not food
]);

const MANUAL_OVERRIDES = {
  // Palo Alto: name inside quotes in description, not caught by extractor
  "palo-alto:121 Lytton Av": { name: "Rikyu", blurb: "Japanese restaurant fitting out a new space on Lytton Ave" },
  // Palo Alto: name in all-caps before colon in description
  "palo-alto:338 University Av": { name: "Zhangling Malatang", blurb: "Sichuan-style malatang — customizable spicy hot pot — coming to University Ave" },
  // San Jose: known blurbs for named spots
  "san-jose:2855 Stevens Creek Bl": { blurb: "Korean BBQ chain known for tabletop charcoal grilling and premium cuts" },
  "san-jose:355 Santana Row": { blurb: "California seasonal cuisine with a botanical-inspired menu, opening on Santana Row" },
  "san-jose:233 W Santa Clara St": { blurb: "Historic cocktail lounge inside the Hotel De Anza, a downtown San Jose landmark since 1931" },
  "san-jose:22 N White Rd": { blurb: "Mexican tortilleria and taqueria on the east side" },
  "palo-alto:407 Lytton Av": { blurb: "Japanese bistro opening in downtown Palo Alto" },
  "palo-alto:401 Webster St": { blurb: "Neighborhood American restaurant on Webster St undergoing a kitchen remodel" },
  "palo-alto:388 Cambridge Av": { blurb: "SF-famous bakery known for its flaky croissants, fitting out 2,150 SF on Cambridge Ave in Palo Alto" },
  "palo-alto:552 Waverley St": { name: "Bon Broth SF", blurb: "San Francisco bone broth and Vietnamese soup restaurant fitting out a new space on Waverley St" },
  "san-jose:1725 Branham Ln": { name: "El Pollo Loco", blurb: "Mexican-style chicken chain on Branham Lane near Almaden Valley getting updated signage" },
  "san-jose:1200 El Paseo De Saratoga": { name: "Sweetgreen", blurb: "National salad chain adding signage at El Paseo de Saratoga shopping center near West San Jose" },
  "san-jose:2040 N 1st St": { blurb: "Longtime nightclub and restaurant near SAP Center filed a full demolition permit — may be permanently closing" },
  "san-jose:3062 Story Rd": { blurb: "New coffee shop fitting out a $350K space on Story Road in East San Jose" },
  "san-jose:2549 S King Rd": { blurb: "New restaurant fitting out a space on South King Road in East San Jose" },
  "san-jose:1080 Saratoga Av": { blurb: "BBQ joint on Saratoga Avenue in west San Jose renovating its interior" },
  "san-jose:3243 S White Rd": { blurb: "Round Table Pizza franchise fitting out a new location on South White Road in East San Jose" },
};

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
  // Strip dangling permit words left after previous stripping (e.g. "Pollo Loco New" ← from "New Sign")
  s = s.replace(/\s+(New|Old|Existing|Remodel)\s*$/i, "").trim();

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

// ── Palo Alto PermitView helpers ──────────────────────────────────────────────

const PA_FOOD_KEYWORDS = ["restaurant", "cafe", "café", "bakery", "food", "kitchen", "dining", "bistro", "brew", "bar ", "brewery", "winery", "eatery", "pizza", "sushi", "taco", "boba"];

function isPaResidential(record) {
  const desc = (record.DESCRIPTION ?? "").trim();
  const cat = record.RECORD_TYPE_CATEGORY ?? "";
  if (cat === "Web - Kitchen or Bath Remodel") return true;
  // Descriptions that start with residential prefixes
  if (/^(RES:|Res:|C1-[A-Z\-\/]+\s*[-\s]+Res:|C1-[A-Z]+\s+Res:)/i.test(desc)) return true;
  if (/\bsingle.family\b|\bSFR\b|\bADU\b|\bsingle family\b/i.test(desc)) return true;
  // "Instant permit for a residential..." pattern
  if (/^Instant permit for a residential/i.test(desc)) return true;
  return false;
}

function extractPaName(desc) {
  if (!desc) return null;
  // "COM: Standalone U&O for 'Bistro Demiya'" or "COM: TI for 'Name'"
  const uoMatch = desc.match(/U&O for ['"]([^'"]+)['"]/i) ||
                  desc.match(/for ['"]([^'"]+)['"]/i);
  if (uoMatch) return uoMatch[1].trim();
  // '"ARSICAULT BAKERY" Tenant improvement...' — quoted name at start of description
  const quotedLeadMatch = desc.match(/^"([^"]{3,40})"\s/);
  if (quotedLeadMatch) {
    return quotedLeadMatch[1].trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // "FRONT PORCH: ..." — all-caps name before colon
  const colonMatch = desc.match(/^([A-Z][A-Z\s'&]+):/);
  if (colonMatch) {
    const name = colonMatch[1].trim();
    // Skip generic codes
    if (!/^(RES|COM|C1|REV|MEP|OTC|MFR|SFR)$/i.test(name) && name.length > 3 && name.length < 40) {
      return name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  // "BON BROTH SF Tenant Improvement ..." — all-caps name before noise keywords
  const allCapsLeadMatch = desc.match(/^([A-Z][A-Z\s'&]{2,39}?)\s+(Tenant|TI|Restaurant|Kitchen|Cafe|Bakery|Bar|Brew)/);
  if (allCapsLeadMatch) {
    const name = allCapsLeadMatch[1].trim();
    if (!/^(RES|COM|C1|REV|MEP|OTC|REQUEST)/i.test(name) && name.length > 3) {
      return name.toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .replace(/\bSf\b/g, "SF")
        .replace(/\bNyc\b/g, "NYC")
        .replace(/\bBbq\b/g, "BBQ");
    }
  }
  return null;
}

function labelPaPermit(record) {
  const desc = (record.DESCRIPTION ?? "").toLowerCase();
  const cat = record.RECORD_TYPE_CATEGORY ?? "";
  if (/u&o|use.and.occupancy|standalone u/i.test(desc) || /^new construction/i.test(desc)) return "New Opening";
  if (cat === "Entitlement" || /conditional use permit|cup to amend/i.test(desc)) return "Conditional Use";
  if (/tenant improvement|TI:/i.test(desc)) return "Renovation";
  if (/kitchen equipment|add.*equipment|new equipment/i.test(desc)) return "New Buildout";
  return "Permit Activity";
}

async function fetchPaloAltoFoodPermits() {
  console.log("\nFetching restaurant permit activity from Palo Alto PermitView…");

  let page;
  try {
    page = await fetch(`${PA_PERMIT_VIEW}/`, {
      headers: { "User-Agent": "SouthBaySignal/1.0 (southbaysignal.org; permits research)" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.warn(`  ⚠️ PA PermitView unavailable: ${err.message}`);
    return [];
  }
  if (!page.ok) {
    console.warn(`  ⚠️ PA PermitView HTTP ${page.status}`);
    return [];
  }

  const allCookies = page.headers.getSetCookie
    ? page.headers.getSetCookie()
    : [page.headers.get("set-cookie")].filter(Boolean);
  const cookieParts = allCookies.map((c) => c.split(";")[0]).join("; ");
  const xsrfMatch = cookieParts.match(/XSRF-TOKEN=([^;]+)/);
  const xsrfDecoded = xsrfMatch ? decodeURIComponent(xsrfMatch[1]) : "";
  const html = await page.text();
  const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  const csrf = csrfMatch ? csrfMatch[1] : "";

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  // Build SQL-style filter for food keywords in DESCRIPTION
  const foodLikes = PA_FOOD_KEYWORDS.map((k) => `LOWER(p.DESCRIPTION) LIKE '%${k}%'`).join(" OR ");
  const formData = new URLSearchParams();
  formData.append("where", `p.DATE_OPENED >= '${cutoffStr}' AND (${foodLikes})`);

  let res;
  try {
    res = await fetch(`${PA_PERMIT_VIEW}/get-remote-data`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRF-TOKEN": csrf,
        "X-XSRF-TOKEN": xsrfDecoded,
        "X-Requested-With": "XMLHttpRequest",
        Cookie: cookieParts,
        Referer: `${PA_PERMIT_VIEW}/`,
        "User-Agent": "SouthBaySignal/1.0 (southbaysignal.org; permits research)",
      },
      body: formData.toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.warn(`  ⚠️ PA PermitView data error: ${err.message}`);
    return [];
  }
  if (!res.ok) {
    console.warn(`  ⚠️ PA PermitView data HTTP ${res.status}`);
    return [];
  }

  const body = await res.json();
  const records = body.data ?? [];
  console.log(`  ${records.length} raw PA food permits`);

  const todayStr = new Date().toISOString().slice(0, 10);
  const items = records
    .filter((r) => !isPaResidential(r))
    .map((r) => {
      const desc = (r.DESCRIPTION ?? "").trim();
      const cat = r.RECORD_TYPE_CATEGORY ?? "";
      const rawAddr = (r.ADDR_FULL_LINE ?? "").split(",")[0].trim();
      const address = rawAddr
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .replace(/\s+/g, " ");
      const date = (r.DATE_OPENED ?? todayStr).slice(0, 10);
      const label = labelPaPermit(r);

      // Skip pure signage or MEP-only scopes with no food narrative
      if (label === "Permit Activity" && /^(OTC Architectural review for|RES MEP:|Res: Temporary|Res: Voluntary)/i.test(desc)) return null;

      const name = extractPaName(desc);
      return {
        id: `pa-${r.RECORD_NUMBER ?? address}-${date}`,
        city: "palo-alto",
        address,
        name,
        description: desc.length > 80 ? desc.slice(0, 77) + "…" : desc,
        workType: cat,
        signal: label === "Possible Closure" ? "closing" : label === "New Opening" ? "opening" : "activity",
        label,
        valuation: 0,
        date,
      };
    })
    .filter(Boolean);

  // Deduplicate by address+date (PA sometimes has multiple permit records per project)
  const seen = new Set();
  const unique = items.filter((it) => {
    const key = `${it.address}|${it.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Skip unnamed items (confusing in UI); only show items with a known name
  const notable = unique.filter((it) => it.name);
  console.log(`  ${notable.length} notable PA food permits`);
  notable.forEach((it) => console.log(`    [${it.label}] ${it.address}${it.name ? ` — ${it.name}` : ""}`));
  return notable;
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
          workLower.includes("temporary power") ||
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
        city: "san-jose",
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

  // Enrich SJ items missing names using Google Places (best-effort)
  const topSjItems = items.slice(0, 15);
  if (GOOGLE_PLACES_API_KEY) {
    const unnamed = topSjItems.filter((it) => !it.name);
    if (unnamed.length > 0) {
      console.log(`\n  🔍 Looking up ${unnamed.length} unnamed SJ permit locations via Google Places…`);
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

  // Fetch Palo Alto permits
  const paItems = await fetchPaloAltoFoodPermits();

  // Combine and sort: opening/closure signals first, then by date desc
  const allItems = [...topSjItems, ...paItems];
  allItems.sort((a, b) => {
    if (a.signal === "closing" && b.signal !== "closing") return -1;
    if (b.signal === "closing" && a.signal !== "closing") return 1;
    if (a.signal === "opening" && b.signal !== "opening") return -1;
    if (b.signal === "opening" && a.signal !== "opening") return 1;
    if (b.valuation !== a.valuation) return b.valuation - a.valuation;
    return b.date.localeCompare(a.date);
  });

  // Filter out known non-food false positives
  const filtered = allItems.filter((item) => {
    const key = `${item.city ?? ""}:${item.address}`;
    return !SKIP_ADDRESSES.has(key);
  });

  // Apply manual overrides (name, blurb) keyed by "city:address"
  for (const item of filtered) {
    const key = `${item.city ?? ""}:${item.address}`;
    const override = MANUAL_OVERRIDES[key];
    if (override) {
      if (override.name) item.name = override.name;  // name override always wins
      if (override.blurb) item.blurb = item.blurb ?? override.blurb;
    }
  }

  const allItems_final = filtered;

  const output = {
    generatedAt: new Date().toISOString(),
    cities: ["San Jose", "Palo Alto"],
    windowDays: 60,
    items: allItems_final,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n✅ ${allItems.length} restaurant permit signals (SJ: ${topSjItems.length}, PA: ${paItems.length}) → restaurant-radar.json`);
  allItems.forEach((it) =>
    console.log(`  [${it.city}][${it.label}] ${it.address}${it.name ? ` — ${it.name}` : ""}${it.valuation ? ` ($${it.valuation.toLocaleString()})` : ""}`)
  );
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
