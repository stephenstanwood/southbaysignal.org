#!/usr/bin/env node
/**
 * generate-weekend-picks.mjs
 *
 * Reads upcoming-events.json, asks Claude to pick the 3 most compelling
 * weekend events, and writes editorial picks to weekend-picks.json.
 *
 * Run: node --env-file=.env.local scripts/generate-weekend-picks.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnvLocal } from "./lib/env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVENTS_PATH = join(__dirname, "..", "src", "data", "south-bay", "upcoming-events.json");
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "weekend-picks.json");

loadEnvLocal();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const CLAUDE_HAIKU = "claude-haiku-4-5-20251001";

// ── Helpers ──

function cityLabel(city) {
  return city.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function getWeekendRange() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  // Next Friday (or today if it's Fri/Sat/Sun)
  let daysToFri;
  if (day === 5) daysToFri = 0;
  else if (day === 6) daysToFri = -1; // Sat → use yesterday's Fri
  else if (day === 0) daysToFri = -2; // Sun → use 2 days ago Fri
  else daysToFri = 5 - day;           // Mon-Thu → upcoming Fri

  const fri = new Date(now);
  fri.setDate(now.getDate() + daysToFri);
  const sun = new Date(fri);
  sun.setDate(fri.getDate() + 2);

  // Use local date string (en-CA gives YYYY-MM-DD) so start/end match the label's local dates
  const toLocalIso = (d) => d.toLocaleDateString("en-CA");
  return {
    start: toLocalIso(fri),
    end: toLocalIso(sun),
    label: `${fri.toLocaleDateString("en-US", { month: "long", day: "numeric" })} – ${sun.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`,
  };
}

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_HAIKU,
      max_tokens: 1536,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  return data.content[0].text;
}

// ── Main ──

async function main() {
  const { events } = JSON.parse(readFileSync(EVENTS_PATH, "utf8"));
  const { start, end, label } = getWeekendRange();

  console.log(`Weekend: ${label} (${start} → ${end})`);

  // Filter to weekend, non-ongoing events
  const weekend = events.filter(
    (e) => !e.ongoing && e.date >= start && e.date <= end
  );

  console.log(`Found ${weekend.length} weekend events`);

  if (weekend.length === 0) {
    writeFileSync(OUT_PATH, JSON.stringify({ weekendLabel: label, generatedAt: new Date().toISOString(), picks: [] }, null, 2) + "\n");
    console.log("No weekend events — wrote empty picks.");
    return;
  }

  // Summarize events for Claude (cap to 150 to keep prompt reasonable)
  const sample = weekend.slice(0, 150);
  const eventList = sample.map((e, i) =>
    `${i + 1}. [${e.date} ${e.time || "all day"}] ${e.title} — ${cityLabel(e.city)}${e.venue ? `, ${e.venue}` : ""} (${e.cost}) — ${(e.description || "").slice(0, 120)}`
  ).join("\n");

  const prompt = `You are the editorial voice of South Bay Signal, a local news site for Silicon Valley residents.

The upcoming weekend is ${label}. Here are ${sample.length} events happening across the South Bay:

${eventList}

Pick exactly 5 events that a real South Bay resident would genuinely want to attend. Prioritize:
- Events that are unique, annual, or rare (not things you can do any weekend)
- Free or affordable events
- Broad appeal across different types of residents
- Geographic diversity across cities if possible
- Day diversity: you MUST pick at least 2 events on Saturday AND at least 2 events on Sunday (check the date field carefully)

Avoid: university admin events, clinical studies, internal community meetings, things open every week (farmers markets are fine if especially notable)

IMPORTANT: Check the date on each event. Spread picks across both Saturday and Sunday.

Return ONLY a JSON array of 5 objects, no other text:
[
  {
    "eventIndex": <1-based index from the list above>,
    "why": "1 sentence — why a resident should go. Specific, vivid, no jargon. Under 20 words."
  }
]`;

  let picks;
  try {
    const raw = await callClaude(prompt);
    const json = raw.match(/\[[\s\S]*\]/)?.[0];
    if (!json) throw new Error("No JSON array in response");
    picks = JSON.parse(json);
  } catch (err) {
    console.error("Claude error:", err.message);
    process.exit(1);
  }

  const output = {
    weekendLabel: label,
    weekendStart: start,
    weekendEnd: end,
    generatedAt: new Date().toISOString(),
    picks: picks.map(({ eventIndex, why }) => {
      const e = sample[eventIndex - 1];
      if (!e) return null;
      return {
        id: e.id,
        title: e.title,
        date: e.date,
        displayDate: e.displayDate,
        time: e.time,
        endTime: e.endTime,
        city: e.city,
        venue: e.venue,
        cost: e.cost,
        url: e.url,
        category: e.category,
        why,
      };
    }).filter(Boolean),
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n✅ ${output.picks.length} picks written to weekend-picks.json`);
  output.picks.forEach((p) => console.log(`  • ${p.title} — ${p.why}`));
}

main().catch((err) => { console.error(err); process.exit(1); });
