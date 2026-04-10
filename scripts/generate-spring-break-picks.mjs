#!/usr/bin/env node
/**
 * generate-spring-break-picks.mjs
 *
 * Curates family-friendly spring break activity picks from upcoming-events.json
 * using Claude. Covers both spring break windows (Apr 6-10 and Apr 13-17).
 *
 * Run: node --env-file=.env.local scripts/generate-spring-break-picks.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVENTS_PATH = join(__dirname, "..", "src", "data", "south-bay", "upcoming-events.json");
const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "spring-break-picks.json");

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

function cityLabel(city) {
  return city.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
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
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  return data.content[0].text;
}

async function main() {
  const { events } = JSON.parse(readFileSync(EVENTS_PATH, "utf8"));

  // Cover both spring break windows
  // Easter 2026 was Sunday Apr 5 (Good Friday Apr 3) — already past for most of this window
  // SJUSD/PAUSD/MVWSD/LGSUHSD/MVLA: Apr 6-10
  // FUHSD/CUSD/Campbell USD: Apr 13-17
  const BREAK_START = "2026-04-03";
  const BREAK_END = "2026-04-17";

  const breakEvents = events.filter(
    (e) => !e.ongoing && e.date >= BREAK_START && e.date <= BREAK_END
  );

  console.log(`Found ${breakEvents.length} events Apr 3-17 (spring break)`);

  // Also include ongoing exhibits (museums, parks) that are active during break
  const ongoingDuring = events.filter(
    (e) => e.ongoing && e.date <= BREAK_END
  ).slice(0, 20);

  console.log(`+ ${ongoingDuring.length} ongoing exhibits/series`);

  const allCandidates = [...breakEvents, ...ongoingDuring];

  // Filter out noise: admin events, clinical, university-internal
  const NOISE_PATTERNS = [
    /clinical/i, /study recruit/i, /commission regular meeting/i,
    /council regular meeting/i, /dev review committee/i, /cancelled/i,
    /advisory committee/i, /information session/i, /board meeting/i,
  ];
  const filtered = allCandidates.filter(
    (e) => !NOISE_PATTERNS.some((p) => p.test(e.title))
  );

  console.log(`${filtered.length} after filtering noise`);

  const sample = filtered.slice(0, 120);
  const eventList = sample.map((e, i) =>
    `${i + 1}. [${e.date}${e.ongoing ? " ONGOING" : ` ${e.time || "all day"}`}] ${e.title} — ${cityLabel(e.city)}${e.venue ? `, ${e.venue}` : ""} (${e.cost || "free"}) — ${(e.description || "").slice(0, 120)}`
  ).join("\n");

  const prompt = `You are the editorial voice of South Bay Signal, a local news site for Silicon Valley residents.

Spring break runs April 3–17, 2026. Easter Sunday was April 5 (already past). Week 1 (Apr 3–10) is the SJUSD/PAUSD/MVWSD break. Week 2 (Apr 13–17) is the FUHSD/Cupertino USD/Campbell USD break. Here are ${sample.length} events and exhibits:

${eventList}

Pick exactly 12 things a South Bay family or resident would genuinely enjoy during spring break. Rules:
- At least 4 picks from Week 1 (Apr 3–10) and at least 4 from Week 2 (Apr 13–17)
- Include 2–3 ongoing exhibits/museums that are great for families
- Family-friendly or all-ages (kids are out of school!)
- Prefer free or affordable, but don't exclude major events (USWNT soccer, live music, etc.) just because they're paid — note them honestly
- Mix of types: outdoor, cultural/museum, arts, hands-on/workshop, sports
- Geographic spread: aim for at least 4 different cities
- Avoid: university admin events, meetings, clinical studies, routine weekly library programs

Return ONLY a JSON array of 12 objects, no other text:
[
  {
    "eventIndex": <1-based index from the list above>,
    "why": "1 sentence — why a family should go during spring break. Specific, vivid, under 22 words."
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
    breakStart: BREAK_START,
    breakEnd: BREAK_END,
    label: "Spring Break 2026",
    subtitle: "Apr 3–17 · spring break",
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
        ongoing: e.ongoing || false,
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
  console.log(`\n✅ ${output.picks.length} spring break picks written to spring-break-picks.json (target: 12)`);
  output.picks.forEach((p) => console.log(`  • [${p.date}] ${p.title} — ${p.why}`));
}

main().catch((err) => { console.error(err); process.exit(1); });
