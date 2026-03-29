#!/usr/bin/env node
/**
 * generate-digests.mjs
 *
 * Pulls pre-ingested council meeting data from stoa.works/api/council-meetings,
 * summarizes the most recent meeting per city with Claude Haiku, and writes
 * results to src/data/south-bay/digests.json.
 *
 * Much faster than re-scraping Legistar/CivicEngage — Stoa already has the data.
 *
 * Usage:
 *   node --env-file=.env.local scripts/generate-digests.mjs
 */

import { writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "digests.json");

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

// ── City config (SBS city IDs → Stoa city names + schedule) ──

const CITIES = [
  { city: "campbell",      stoaCity: "Campbell",      cityName: "Campbell",      schedule: "1st and 3rd Tuesday",  agendaUrl: "https://www.cityofcampbell.com/271/City-Council-Meetings" },
  { city: "saratoga",      stoaCity: "Saratoga",      cityName: "Saratoga",      schedule: "1st and 3rd Wednesday", agendaUrl: "https://saratoga-ca.municodemeetings.com/" },
  { city: "los-altos",     stoaCity: "Los Altos",     cityName: "Los Altos",     schedule: "2nd and 4th Tuesday",  agendaUrl: "https://losaltos-ca.municodemeetings.com/" },
  { city: "los-gatos",     stoaCity: "Los Gatos",     cityName: "Los Gatos",     schedule: "1st and 3rd Monday",   agendaUrl: "https://losgatos-ca.municodemeetings.com/" },
  { city: "san-jose",      stoaCity: "San Jose",      cityName: "San José",      schedule: "1st and 3rd Tuesday",  agendaUrl: "https://sanjose.legistar.com/Calendar.aspx" },
  { city: "mountain-view", stoaCity: "Mountain View", cityName: "Mountain View", schedule: "2nd and 4th Tuesday",  agendaUrl: "https://mountainview.legistar.com/Calendar.aspx" },
  { city: "sunnyvale",     stoaCity: "Sunnyvale",     cityName: "Sunnyvale",     schedule: "2nd and 4th Tuesday",  agendaUrl: "https://sunnyvale.legistar.com/Calendar.aspx" },
  { city: "cupertino",     stoaCity: "Cupertino",     cityName: "Cupertino",     schedule: "1st and 3rd Tuesday",  agendaUrl: "https://cupertino.legistar.com/Calendar.aspx" },
  { city: "santa-clara",   stoaCity: "Santa Clara",   cityName: "Santa Clara",   schedule: "2nd and 4th Tuesday",  agendaUrl: "https://santaclara.legistar.com/Calendar.aspx" },
  { city: "milpitas",      stoaCity: "Milpitas",      cityName: "Milpitas",      schedule: "1st and 3rd Tuesday",  agendaUrl: "https://www.ci.milpitas.ca.gov/government/council/" },
  { city: "palo-alto",     stoaCity: "Palo Alto",     cityName: "Palo Alto",     schedule: "1st and 3rd Monday",   agendaUrl: "https://www.cityofpaloalto.org/Government/City-Clerk/Meetings-Agendas-Minutes" },
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
  return data.records; // MeetingRecord[]
}

// ── Claude summarization ──

async function summarize(config, meeting) {
  const isYouTubeTranscript = meeting.source === "youtube-transcript";
  // Strip the VTT metadata prefix that appears in YouTube transcript records
  const rawExcerpt = (meeting.excerpt || "").replace(/^Kind:\s*captions\s+Language:\s*\w+\s*/i, "").trim();

  const contentBlock = isYouTubeTranscript
    ? `Meeting transcript (partial — opening segment only): ${rawExcerpt}`
    : `Agenda highlights: ${rawExcerpt}`;

  const transcriptNote = isYouTubeTranscript
    ? `Note: the content above is the opening segment of the meeting transcript. It may only capture roll call and procedural items. Summarize what you can and be honest if the substantive agenda items aren't captured.`
    : "";

  const prompt = `Summarize this ${config.cityName}, CA City Council meeting for residents in plain English.

Meeting date: ${meeting.date}
${contentBlock}
Keywords: ${meeting.keywords.join(", ")}
${transcriptNote}

Return JSON with:
- "summary": 2-3 sentence plain-English overview of what was discussed (no jargon)
- "keyTopics": array of 3-5 short bullet strings (specific topics, not generic)

Be concrete. Write for someone who wants to know what's happening in their city.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_HAIKU,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status} ${await res.text()}`);

  const msg = await res.json();
  const text = msg.content?.find((c) => c.type === "text")?.text ?? "";
  // Extract the first JSON object from the response (handles trailing text/preamble)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in Claude response: ${text.substring(0, 100)}`);
  return JSON.parse(jsonMatch[0]);
}

// ── Main ──

async function main() {
  const records = await fetchStoaMeetings();

  // Group by city name (keep most recent City Council meeting per city)
  const today = new Date().toISOString().split("T")[0];
  const PLACEHOLDER_EXCERPTS = [
    "meeting agenda available",
    "search for specific items",
    "no items",
  ];
  function hasRealContent(r) {
    const ex = (r.excerpt || "").toLowerCase().trim();
    return ex.length > 80 && !PLACEHOLDER_EXCERPTS.some((p) => ex.includes(p));
  }

  // Group by city — prefer most recent meeting with real content
  const byCity = {};
  for (const r of records) {
    if (r.date > today) continue;
    if (r.meetingType !== "City Council") continue;
    const existing = byCity[r.city];
    // Prefer records with real content; among those, take most recent
    if (!existing) { byCity[r.city] = r; continue; }
    const rReal = hasRealContent(r);
    const exReal = hasRealContent(existing);
    if (rReal && !exReal) { byCity[r.city] = r; continue; }
    if (!rReal && exReal) continue;
    if (r.date > existing.date) byCity[r.city] = r;
  }

  // Don't show meetings older than 9 months — stale data is worse than no data
  const STALE_CUTOFF = new Date();
  STALE_CUTOFF.setMonth(STALE_CUTOFF.getMonth() - 9);
  const staleIso = STALE_CUTOFF.toISOString().split("T")[0];

  const digests = {};

  for (const config of CITIES) {
    const meeting = byCity[config.stoaCity];
    if (!meeting) {
      console.log(`  ⚠️  ${config.cityName}: no recent City Council meeting in Stoa data`);
      continue;
    }
    if (meeting.date < staleIso) {
      console.log(`  ⏭️  ${config.cityName}: most recent record is ${meeting.date} (>9 months old, skipping)`);
      continue;
    }

    console.log(`  ⏳ ${config.cityName} (${meeting.date})...`);
    try {
      const parsed = await summarize(config, meeting);

      const meetingDateFormatted = new Date(meeting.date + "T12:00:00").toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric",
      });

      digests[config.city] = {
        city: config.city,
        cityName: config.cityName,
        body: "City Council",
        meetingDate: meetingDateFormatted,
        meetingDateIso: meeting.date,
        title: `${config.cityName} City Council — ${meetingDateFormatted}`,
        summary: parsed.summary ?? "",
        keyTopics: parsed.keyTopics ?? meeting.keywords.slice(0, 5),
        schedule: config.schedule,
        sourceUrl: config.agendaUrl,
        generatedAt: new Date().toISOString(),
      };

      console.log(`  ✅ ${config.cityName}: ${meetingDateFormatted}`);
    } catch (err) {
      console.error(`  ❌ ${config.cityName}: ${err.message}`);
    }

    // Be polite — small delay between Claude calls
    await new Promise((r) => setTimeout(r, 300));
  }

  writeFileSync(OUT_PATH, JSON.stringify(digests, null, 2) + "\n");
  console.log(`\nDone — ${Object.keys(digests).length} digests written to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
