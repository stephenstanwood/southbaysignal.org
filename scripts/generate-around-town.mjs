#!/usr/bin/env node
/**
 * generate-around-town.mjs
 *
 * Generates "Around the South Bay" items from multiple public-record sources:
 *   1. City Council meetings (via Stoa API)
 *   2. Planning Commission meetings (via Stoa API)
 *   3. Notable building permits (from permit-pulse.json)
 *   4. Development tracker status changes (from development-data.ts)
 *
 * Usage:
 *   node --env-file=.env.local scripts/generate-around-town.mjs
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "around-town.json");
const DEV_CACHE_PATH = join(__dirname, "..", "src", "data", "south-bay", ".dev-status-cache.json");
const PERMIT_PATH = join(__dirname, "..", "src", "data", "south-bay", "permit-pulse.json");
const DEV_DATA_PATH = join(__dirname, "..", "src", "data", "south-bay", "development-data.ts");

// Load .env.local if ANTHROPIC_API_KEY not already in environment
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const envPath = join(__dirname, "..", ".env.local");
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const CLAUDE_HAIKU = "claude-haiku-4-5-20251001";

// ── City config ──

const CITIES = [
  { stoaCity: "Campbell",      cityId: "campbell",      cityName: "Campbell",      agendaUrl: "https://www.campbellca.gov/AgendaCenter/City-Council-10",              permitUrl: null },
  { stoaCity: "Saratoga",      cityId: "saratoga",      cityName: "Saratoga",      agendaUrl: "https://saratoga-ca.municodemeetings.com/",                            permitUrl: null },
  { stoaCity: "Los Altos",     cityId: "los-altos",     cityName: "Los Altos",     agendaUrl: "https://losaltos-ca.municodemeetings.com/",                            permitUrl: null },
  { stoaCity: "Los Gatos",     cityId: "los-gatos",     cityName: "Los Gatos",     agendaUrl: "https://losgatos-ca.municodemeetings.com/",                            permitUrl: null },
  { stoaCity: "San Jose",      cityId: "san-jose",      cityName: "San José",      agendaUrl: "https://sanjose.legistar.com/Calendar.aspx",      legistar: "sanjose",      permitUrl: "https://sjpermits.org/" },
  { stoaCity: "Mountain View", cityId: "mountain-view", cityName: "Mountain View", agendaUrl: "https://mountainview.legistar.com/Calendar.aspx", legistar: "mountainview",  permitUrl: null },
  { stoaCity: "Sunnyvale",     cityId: "sunnyvale",     cityName: "Sunnyvale",     agendaUrl: "https://sunnyvale.legistar.com/Calendar.aspx",    legistar: "sunnyvale",     permitUrl: null },
  { stoaCity: "Cupertino",     cityId: "cupertino",     cityName: "Cupertino",     agendaUrl: "https://cupertino.legistar.com/Calendar.aspx",    legistar: "cupertino",     permitUrl: null },
  { stoaCity: "Santa Clara",   cityId: "santa-clara",   cityName: "Santa Clara",   agendaUrl: "https://santaclara.legistar.com/Calendar.aspx",   legistar: "santaclara",    permitUrl: null },
  { stoaCity: "Milpitas",      cityId: "milpitas",      cityName: "Milpitas",      agendaUrl: "https://www.ci.milpitas.ca.gov/government/council/",                   permitUrl: null },
  { stoaCity: "Palo Alto",     cityId: "palo-alto",     cityName: "Palo Alto",     agendaUrl: "https://www.cityofpaloalto.org/Government/City-Clerk/Meetings-Agendas-Minutes", legistar: "paloalto", permitUrl: "https://www.cityofpaloalto.org/Gov/Depts/PW/Permits/Permits.asp" },
];

const CITY_BY_STOA = Object.fromEntries(CITIES.map((c) => [c.stoaCity, c]));

// ── Helpers ──

async function claudeJson(prompt, maxTokens = 1024) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_HAIKU,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
  const msg = await res.json();
  const text = msg.content?.find((c) => c.type === "text")?.text ?? "";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  return JSON.parse(jsonMatch[0]);
}

function makeId(cityId, date, headline) {
  return `${cityId}-${date}-${Buffer.from(headline).toString("base64").slice(0, 8)}`;
}

/** For Legistar cities, construct a calendar URL filtered to a specific meeting date. */
function legistarMeetingUrl(subdomain, date) {
  const [year, month, day] = date.split("-");
  const d = `${parseInt(month)}%2F${parseInt(day)}%2F${year}`;
  return `https://${subdomain}.legistar.com/Calendar.aspx?From=${d}&To=${d}`;
}

// ── Boilerplate detection (shared with generate-digests.mjs) ──

const PLACEHOLDER_EXCERPTS = ["meeting agenda available", "search for specific items", "no items", "translation:"];
const BOILERPLATE_PHRASES = [
  "how to observe the meeting",
  "cable channel",
  "live translations in over",
  "wordly.ai",
  "americans with disabilities act",
  "scroll to the end for information about",
  "rules of conduct of the meeting",
  "anyone wishing to address",
  "this meeting is being conducted",
  "this portion of the meeting is reserved",
];

function hasRealContent(r) {
  const ex = (r.excerpt || "").toLowerCase().trim();
  if (ex.length < 60) return false;
  if (PLACEHOLDER_EXCERPTS.some((p) => ex.startsWith(p))) return false;
  const boilerplateHits = BOILERPLATE_PHRASES.filter((p) => ex.includes(p)).length;
  if (boilerplateHits >= 2) return false;
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 1 + 2: Council + Planning Commission meetings from Stoa
// ══════════════════════════════════════════════════════════════════════════════

async function fetchStoaMeetings(meetingType) {
  const label = meetingType.replace("+", " ");
  console.log(`\n📋 Fetching ${label} meetings from Stoa...`);
  const allRecords = [];
  for (const config of CITIES) {
    const url = `https://www.stoa.works/api/council-meetings?city=${encodeURIComponent(config.stoaCity)}&type=${meetingType}&limit=10`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "SouthBaySignal/1.0 (stanwood.dev; internal data sharing)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      allRecords.push(...(data.records ?? []));
    } catch {}
  }
  console.log(`  Got ${allRecords.length} ${label} records`);
  return allRecords;
}

async function findInterestingItems(config, meetings, bodyType) {
  const content = meetings.map((m) => {
    const excerpt = (m.excerpt || "")
      .replace(/^Kind:\s*captions\s+Language:\s*\w+\s*/i, "")
      .trim();
    return `Date: ${m.date}\nBody: ${bodyType}\nTitle: ${m.title || ""}\nAgenda: ${excerpt}\nKeywords: ${(m.keywords || []).join(", ")}`;
  }).join("\n\n---\n\n");

  const bodyNote = bodyType === "Planning Commission"
    ? "These are Planning Commission meetings — focus on development projects, zoning decisions, design review, and land use changes."
    : "";

  const prompt = `You are reading recent ${config.cityName}, CA ${bodyType} meeting agendas and minutes.
${bodyNote}

Your job: identify items that a South Bay resident would genuinely find interesting, surprising, or worth knowing about.

SKIP: routine approvals, consent calendar, minutes approval, procedural items, public comment with no outcome, generic budget discussions, YouTube/Zoom instructions.

KEEP: notable development projects (housing, commercial, controversial permits), policy changes affecting residents, contested votes, new programs/ordinances, zoning/land use decisions, physical changes to the city.

Meeting data:
${content}

Return a JSON array (may be empty if nothing is interesting). Each item:
{
  "date": "YYYY-MM-DD",
  "headline": "short plain-English headline (max 12 words, no jargon)",
  "summary": "1-2 sentences. What happened, why it matters. Written for a resident. NEVER use relative time words (tonight, today, this week) — use date or day name."
}

Return [] if nothing is genuinely interesting. Quality over quantity.`;

  return claudeJson(prompt);
}

async function gatherMeetingItems(meetingType) {
  const label = meetingType.replace("+", " ");
  const sourceTag = meetingType === "City+Council" ? "council" : "planning";
  const records = await fetchStoaMeetings(meetingType);

  const today = new Date().toISOString().split("T")[0];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const cutoffIso = cutoff.toISOString().split("T")[0];

  const SKIP_TYPES = new Set(["closed session", "special meeting"]);
  const items = [];

  for (const config of CITIES) {
    const cityMeetings = records.filter((r) =>
      r.city === config.stoaCity &&
      r.date <= today &&
      r.date >= cutoffIso &&
      hasRealContent(r) &&
      !SKIP_TYPES.has((r.title || "").toLowerCase())
    ).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);

    if (!cityMeetings.length) continue;

    console.log(`  ⏳ ${config.cityName} (${label}): evaluating ${cityMeetings.length} meetings...`);

    try {
      const found = await findInterestingItems(config, cityMeetings, label);
      for (const item of found) {
        const sourceUrl = config.legistar
          ? legistarMeetingUrl(config.legistar, item.date)
          : config.agendaUrl;
        items.push({
          id: makeId(config.cityId, item.date, item.headline),
          cityId: config.cityId,
          cityName: config.cityName,
          date: item.date,
          headline: item.headline,
          summary: item.summary,
          sourceUrl,
          source: sourceTag,
        });
        console.log(`  ✅ ${config.cityName}: ${item.headline}`);
      }
      if (!found.length) console.log(`  — ${config.cityName}: nothing interesting`);
    } catch (err) {
      console.error(`  ❌ ${config.cityName}: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return items;
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 3: Notable building permits from permit-pulse.json
// ══════════════════════════════════════════════════════════════════════════════

async function gatherPermitItems() {
  console.log("\n🏗️  Scanning permits...");
  if (!existsSync(PERMIT_PATH)) {
    console.log("  ⏭️  permit-pulse.json not found, skipping");
    return [];
  }

  const data = JSON.parse(readFileSync(PERMIT_PATH, "utf8"));
  const allNotable = [];

  for (const [cityId, cityData] of Object.entries(data.cities || {})) {
    const config = CITIES.find((c) => c.cityId === cityId);
    if (!config) continue;

    const PERMIT_BLOCKLIST = /\b(reroof|re-roof|roofing|roof replacement)\b/i;
    const permits = (cityData.permits || []).filter((p) => {
      // Skip boring permits
      if (PERMIT_BLOCKLIST.test(p.description || "")) return false;
      // Notable: high value, new construction, entitlements, or adds housing units
      if (p.valuation > 500_000) return true;
      if (["residential-new", "commercial-large", "entitlement"].includes(p.category)) return true;
      if (p.units > 0) return true;
      return false;
    });

    if (permits.length) {
      allNotable.push({ config, permits: permits.slice(0, 8) });
    }
  }

  if (!allNotable.length) {
    console.log("  — No notable permits found");
    return [];
  }

  // Batch all notable permits into one Claude call per city
  const items = [];
  for (const { config, permits } of allNotable) {
    const permitText = permits.map((p) =>
      `- ${p.categoryLabel || p.category}: ${p.description || "No description"} at ${p.address || "unknown address"} ($${(p.valuation || 0).toLocaleString()}, ${p.units || 0} units, issued ${p.issueDate})`
    ).join("\n");

    console.log(`  ⏳ ${config.cityName}: evaluating ${permits.length} notable permits...`);

    try {
      const found = await claudeJson(`These are recently issued building permits in ${config.cityName}, CA. Pick the 1-2 most interesting ones that a resident would care about (new businesses, significant housing, major construction). Skip routine renovations and ADUs unless they represent a notable trend.

Permits:
${permitText}

Return a JSON array. Each item:
{
  "date": "YYYY-MM-DD",
  "headline": "short plain-English headline (max 12 words)",
  "summary": "1-2 sentences. What's being built, where, why it matters."
}

Return [] if nothing is genuinely noteworthy.`, 512);

      for (const item of found) {
        items.push({
          id: makeId(config.cityId, item.date, item.headline),
          cityId: config.cityId,
          cityName: config.cityName,
          date: item.date,
          headline: item.headline,
          summary: item.summary,
          sourceUrl: config.permitUrl || config.agendaUrl,
          source: "permit",
        });
        console.log(`  ✅ ${config.cityName}: ${item.headline}`);
      }
      if (!found.length) console.log(`  — ${config.cityName}: no noteworthy permits`);
    } catch (err) {
      console.error(`  ❌ ${config.cityName} permits: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return items;
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 4: Development tracker status changes
// ══════════════════════════════════════════════════════════════════════════════

const STATUS_LABELS = {
  proposed: "Proposed",
  approved: "Approved",
  "under-construction": "Under Construction",
  "opening-soon": "Opening Soon",
  completed: "Completed",
  "on-hold": "On Hold",
};

function gatherDevItems() {
  console.log("\n🏢 Checking development tracker...");
  if (!existsSync(DEV_DATA_PATH)) {
    console.log("  ⏭️  development-data.ts not found, skipping");
    return [];
  }

  // Parse projects from the TS file using vm to eval the JS array literal
  const tsContent = readFileSync(DEV_DATA_PATH, "utf8");
  const arrayMatch = tsContent.match(/DevProject\[\]\s*=\s*(\[[\s\S]*?\n\])\s*;/);
  if (!arrayMatch) {
    console.log("  ⚠️  Could not find projects array in development-data.ts");
    return [];
  }

  let projects;
  try {
    // The array literal is valid JS — eval it directly (trusted local file)
    projects = eval(`(${arrayMatch[1]})`);
  } catch (err) {
    console.log(`  ⚠️  Could not parse projects: ${err.message}`);
    return [];
  }

  // Load previous status cache
  let prevCache = {};
  if (existsSync(DEV_CACHE_PATH)) {
    try {
      prevCache = JSON.parse(readFileSync(DEV_CACHE_PATH, "utf8"));
    } catch {}
  }

  const isFirstRun = Object.keys(prevCache).length === 0;
  const today = new Date().toISOString().split("T")[0];
  const items = [];

  // Build new cache and detect changes
  const newCache = {};
  for (const p of projects) {
    newCache[p.id] = p.status;

    if (isFirstRun) continue; // Seed run — don't generate items
    if (prevCache[p.id] === p.status) continue; // No change

    const oldLabel = STATUS_LABELS[prevCache[p.id]] || prevCache[p.id] || "New";
    const newLabel = STATUS_LABELS[p.status] || p.status;
    const headline = prevCache[p.id]
      ? `${p.name} moves to ${newLabel.toLowerCase()}`
      : `${p.name} added to development tracker`;
    const summary = prevCache[p.id]
      ? `${p.name} in ${p.city} has moved from ${oldLabel} to ${newLabel}.${p.scale ? ` The ${p.category} project is ${p.scale}.` : ""}`
      : `${p.name} in ${p.city} (${newLabel}) has been added to the development tracker.${p.scale ? ` Scale: ${p.scale}.` : ""}`;

    items.push({
      id: makeId(p.cityId, today, headline),
      cityId: p.cityId,
      cityName: p.city,
      date: today,
      headline,
      summary,
      sourceUrl: "", // no external source
      source: "development",
    });
    console.log(`  ✅ ${p.city}: ${headline}`);
  }

  // Save updated cache
  writeFileSync(DEV_CACHE_PATH, JSON.stringify(newCache, null, 2) + "\n");

  if (isFirstRun) {
    console.log(`  📦 First run — seeded cache with ${Object.keys(newCache).length} projects (no items generated)`);
  } else if (!items.length) {
    console.log("  — No status changes detected");
  }

  return items;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN: gather, merge, deduplicate, output
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  // Gather from all sources
  const [councilItems, planningItems, permitItems] = await Promise.all([
    gatherMeetingItems("City+Council"),
    gatherMeetingItems("Planning+Commission"),
    gatherPermitItems(),
  ]);
  const devItems = gatherDevItems(); // sync, no API calls

  const allItems = [...councilItems, ...planningItems, ...permitItems, ...devItems];
  console.log(`\n📊 Totals: ${councilItems.length} council, ${planningItems.length} planning, ${permitItems.length} permit, ${devItems.length} development`);

  // Sort by date descending
  allItems.sort((a, b) => b.date.localeCompare(a.date));

  // Simple dedup: if two items from the same city have very similar headlines, keep the first (higher priority source)
  const seen = new Set();
  const deduped = allItems.filter((item) => {
    const key = `${item.cityId}-${item.headline.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const topItems = deduped.slice(0, 8);

  const output = {
    items: topItems,
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n✅ Done — ${topItems.length} items written to ${OUT_PATH}`);
  for (const item of topItems) {
    console.log(`  [${item.source}] ${item.cityName} (${item.date}): ${item.headline}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
