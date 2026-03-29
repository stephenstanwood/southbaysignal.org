#!/usr/bin/env node
/**
 * generate-around-town.mjs
 *
 * Reads recent city council meeting data from Stoa, asks Claude to identify
 * genuinely interesting agenda items (not routine procedural stuff), and
 * writes plain-English summaries to src/data/south-bay/around-town.json.
 *
 * "Around the South Bay" is original writing derived from public records —
 * city council agendas and minutes. We link to official sources only.
 *
 * Usage:
 *   node --env-file=.env.local scripts/generate-around-town.mjs
 */

import { writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "around-town.json");

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
  { stoaCity: "Campbell",      cityId: "campbell",      cityName: "Campbell",      agendaUrl: "https://www.cityofcampbell.com/271/City-Council-Meetings" },
  { stoaCity: "Saratoga",      cityId: "saratoga",      cityName: "Saratoga",      agendaUrl: "https://saratoga-ca.municodemeetings.com/" },
  { stoaCity: "Los Altos",     cityId: "los-altos",     cityName: "Los Altos",     agendaUrl: "https://losaltos-ca.municodemeetings.com/" },
  { stoaCity: "Los Gatos",     cityId: "los-gatos",     cityName: "Los Gatos",     agendaUrl: "https://losgatos-ca.municodemeetings.com/" },
  { stoaCity: "San Jose",      cityId: "san-jose",      cityName: "San José",      agendaUrl: "https://sanjose.legistar.com/Calendar.aspx" },
  { stoaCity: "Mountain View", cityId: "mountain-view", cityName: "Mountain View", agendaUrl: "https://mountainview.legistar.com/Calendar.aspx" },
  { stoaCity: "Sunnyvale",     cityId: "sunnyvale",     cityName: "Sunnyvale",     agendaUrl: "https://sunnyvale.legistar.com/Calendar.aspx" },
  { stoaCity: "Cupertino",     cityId: "cupertino",     cityName: "Cupertino",     agendaUrl: "https://cupertino.legistar.com/Calendar.aspx" },
  { stoaCity: "Santa Clara",   cityId: "santa-clara",   cityName: "Santa Clara",   agendaUrl: "https://santaclara.legistar.com/Calendar.aspx" },
  { stoaCity: "Milpitas",      cityId: "milpitas",      cityName: "Milpitas",      agendaUrl: "https://www.ci.milpitas.ca.gov/government/council/" },
  { stoaCity: "Palo Alto",     cityId: "palo-alto",     cityName: "Palo Alto",     agendaUrl: "https://www.cityofpaloalto.org/Government/City-Clerk/Meetings-Agendas-Minutes" },
];

// ── Fetch Stoa data ──

async function fetchStoaMeetings() {
  console.log("Fetching from stoa.works/api/council-meetings...");
  const res = await fetch("https://stoa.works/api/council-meetings", {
    headers: { "User-Agent": "SouthBaySignal/1.0 (stanwood.dev; internal data sharing)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Stoa API error: ${res.status}`);
  const data = await res.json();
  console.log(`  Got ${data.count} records\n`);
  return data.records;
}

// ── Claude: find interesting items ──

async function findInterestingItems(config, meetings) {
  // Build a digest of recent meeting content to evaluate
  const content = meetings.map((m) => {
    const excerpt = (m.excerpt || "")
      .replace(/^Kind:\s*captions\s+Language:\s*\w+\s*/i, "")
      .trim();
    return `Date: ${m.date}\nTitle: ${m.title || ""}\nAgenda: ${excerpt}\nKeywords: ${(m.keywords || []).join(", ")}`;
  }).join("\n\n---\n\n");

  const prompt = `You are reading recent ${config.cityName}, CA City Council meeting agendas and minutes.

Your job: identify items that a South Bay resident would genuinely find interesting, surprising, or worth knowing about. Write each as a brief, plain-English item.

SKIP anything that is:
- Routine (approving previous minutes, consent calendar, financial reports, committee appointments)
- Procedural (closed sessions, public comments with no outcome)
- Generic ("budget discussion", "staff report")
- Too vague to be useful
- A YouTube transcript intro with just roll call/pledge of allegiance

KEEP items that are:
- A notable development project (housing, commercial, controversial permit)
- A policy change that affects residents
- Something unusual or unexpected
- A vote that was contested or close
- A new program, service, or ordinance being adopted
- Something that changes the physical character of the city
- A zoning or land use decision people would care about

Meeting data:
${content}

Return a JSON array (may be empty if nothing is interesting). Each item:
{
  "date": "YYYY-MM-DD",
  "headline": "short plain-English headline (max 12 words, no jargon)",
  "summary": "1-2 sentences. What happened, why it matters. Written for a resident, not a bureaucrat."
}

Return [] if nothing is genuinely interesting. Do not force items. Quality over quantity.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_HAIKU,
      max_tokens: 1024,
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

// ── Main ──

async function main() {
  const records = await fetchStoaMeetings();

  const today = new Date().toISOString().split("T")[0];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 10); // last 10 days
  const cutoffIso = cutoff.toISOString().split("T")[0];

  const SKIP_TYPES = new Set(["closed session", "special meeting"]);
  const PLACEHOLDER_EXCERPTS = ["meeting agenda available", "search for specific items", "no items", "translation:"];

  function hasRealContent(r) {
    const ex = (r.excerpt || "").toLowerCase().trim();
    if (ex.length < 60) return false;
    if (PLACEHOLDER_EXCERPTS.some((p) => ex.startsWith(p))) return false;
    return true;
  }

  const items = [];

  for (const config of CITIES) {
    // Get recent City Council meetings with real content
    const cityMeetings = records.filter((r) =>
      r.city === config.stoaCity &&
      r.meetingType === "City Council" &&
      r.date <= today &&
      r.date >= cutoffIso &&
      hasRealContent(r) &&
      !SKIP_TYPES.has((r.title || "").toLowerCase())
    ).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6); // max 6 recent meetings per city

    if (!cityMeetings.length) {
      console.log(`  ⏭️  ${config.cityName}: no recent meetings with content`);
      continue;
    }

    console.log(`  ⏳ ${config.cityName}: evaluating ${cityMeetings.length} meetings...`);

    try {
      const found = await findInterestingItems(config, cityMeetings);
      if (!found.length) {
        console.log(`  — ${config.cityName}: nothing interesting found`);
      } else {
        for (const item of found) {
          items.push({
            id: `${config.cityId}-${item.date}-${Buffer.from(item.headline).toString("base64").slice(0, 8)}`,
            cityId: config.cityId,
            cityName: config.cityName,
            date: item.date,
            headline: item.headline,
            summary: item.summary,
            sourceUrl: config.agendaUrl,
          });
          console.log(`  ✅ ${config.cityName} (${item.date}): ${item.headline}`);
        }
      }
    } catch (err) {
      console.error(`  ❌ ${config.cityName}: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  // Sort by date descending, cap at 6 items
  items.sort((a, b) => b.date.localeCompare(a.date));
  const topItems = items.slice(0, 6);

  const output = {
    items: topItems,
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nDone — ${topItems.length} items written to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
