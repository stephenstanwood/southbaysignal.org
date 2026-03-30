#!/usr/bin/env node
/**
 * generate-tech-briefing.mjs
 *
 * Generates a weekly "This Week in South Bay Tech" editorial briefing using
 * Claude Haiku. Pulls from recently-funded startups in tech-companies.ts and
 * upcoming tech events from upcoming-events.json.
 *
 * Output: src/data/south-bay/tech-briefing.json
 *
 * Run: node scripts/generate-tech-briefing.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TECH_TS_PATH   = join(__dirname, "..", "src", "data", "south-bay", "tech-companies.ts");
const EVENTS_PATH    = join(__dirname, "..", "src", "data", "south-bay", "upcoming-events.json");
const OUT_PATH       = join(__dirname, "..", "src", "data", "south-bay", "tech-briefing.json");

// Load env if needed
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const lines = readFileSync(join(__dirname, "..", ".env.local"), "utf8").split("\n");
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

function getWeekRange() {
  const now = new Date();
  const start = now.toISOString().split("T")[0];
  const end = new Date(now);
  end.setDate(end.getDate() + 7);
  const endStr = end.toISOString().split("T")[0];
  const label = `${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  return { start, end: endStr, label };
}

/**
 * Extract RECENTLY_FUNDED entries from tech-companies.ts using targeted regex.
 * Each entry has: name, city, round, amount, date
 */
function extractRecentlyFunded(tsContent) {
  // Find the RECENTLY_FUNDED block
  const startIdx = tsContent.indexOf("export const RECENTLY_FUNDED");
  if (startIdx === -1) return [];
  const endIdx = tsContent.indexOf("\n];", startIdx);
  if (endIdx === -1) return [];
  const block = tsContent.substring(startIdx, endIdx + 3);

  const entries = [];
  // Each entry is a { ... } object; extract key fields by regex
  const entryPattern = /\{[^}]*?name:\s*"([^"]+)"[^}]*?city:\s*"([^"]+)"[^}]*?(?:category:[^}]*?)?round:\s*"([^"]+)"[^}]*?amount:\s*"([^"]+)"[^}]*?date:\s*"([^"]+)"/gs;
  let match;
  while ((match = entryPattern.exec(block)) !== null) {
    entries.push({
      name: match[1],
      city: match[2],
      round: match[3],
      amount: match[4],
      date: match[5],
    });
  }
  return entries;
}

/**
 * Extract hiring trend counts from TECH_COMPANIES array in tech-companies.ts.
 */
function extractHiringTrends(tsContent) {
  // Only look in the TECH_COMPANIES block (before RECENTLY_FUNDED)
  const endIdx = tsContent.indexOf("export const RECENTLY_FUNDED");
  const block = endIdx !== -1 ? tsContent.substring(0, endIdx) : tsContent;

  const up   = (block.match(/trend:\s*"up"/g)   || []).length;
  const down = (block.match(/trend:\s*"down"/g) || []).length;
  const flat = (block.match(/trend:\s*"flat"/g) || []).length;
  return { up, down, flat };
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
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.content[0].text.trim();
}

const TECH_EVENT_KEYWORDS = [
  "ai", "artificial intelligence", "machine learning", "robot", "silicon",
  "tech", "chip", "semiconductor", "startup", "software", "computer",
  "data", "cloud", "cyber", "coding", "engineering", "developer",
  "hackathon", "computer history museum", "chm",
];

function isTechEvent(event) {
  const haystack = `${event.title} ${event.venue ?? ""} ${event.category ?? ""}`.toLowerCase();
  return TECH_EVENT_KEYWORDS.some((kw) => haystack.includes(kw));
}

async function main() {
  const { start, end, label } = getWeekRange();

  console.log(`Generating South Bay tech briefing for ${label}…\n`);

  // --- Data gathering ---
  const tsContent = readFileSync(TECH_TS_PATH, "utf8");
  const funded = extractRecentlyFunded(tsContent);
  const trends = extractHiringTrends(tsContent);

  const { events: allEvents } = JSON.parse(readFileSync(EVENTS_PATH, "utf8"));
  const techEvents = allEvents
    .filter((e) => !e.ongoing && e.date >= start && e.date <= end && isTechEvent(e))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);

  console.log(`  Found ${funded.length} recent funding rounds`);
  console.log(`  Hiring trends: ${trends.up} growing, ${trends.flat} stable, ${trends.down} reducing`);
  console.log(`  Tech events this week: ${techEvents.length}`);

  // Only include recent funding (last 45 days)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 45);
  const cutoffStr = cutoff.toISOString().split("T")[0];
  const recentFunded = funded.filter((f) => f.date >= cutoffStr);

  // --- Build prompt ---
  const fundedLines = recentFunded.length
    ? recentFunded.map((f) =>
        `- ${f.name} (${f.city}): ${f.round} ${f.amount} on ${f.date}`
      ).join("\n")
    : "No new funding rounds in the last 45 days.";

  const eventLines = techEvents.length
    ? techEvents.map((e) =>
        `- ${e.title}${e.venue ? ` at ${e.venue}` : ""}${e.date ? ` (${e.date})` : ""}${e.time ? ` @ ${e.time}` : ""}`
      ).join("\n")
    : "No tech events this week.";

  const prompt = `You are the editorial voice of South Bay Signal, a hyperlocal news site covering Silicon Valley's South Bay — the cities between San Jose and Palo Alto.

Write a concise "This Week in South Bay Tech" briefing. It should be 2–3 sentences (50–80 words total). Tone: crisp, grounded, local — like a smart colleague summarizing the week's highlights over coffee. Focus on what's newsworthy for residents who work in or care about local tech. Mention company names and cities when relevant. No hype or jargon.

Recent funding rounds in the South Bay (last 45 days):
${fundedLines}

Hiring pulse: ${trends.up} South Bay companies actively growing headcount, ${trends.flat} stable, ${trends.down} pulling back.

Tech events in the South Bay this week:
${eventLines}

Reply with ONLY the briefing text — no headline, no quotes, no preamble.`;

  const summary = await callClaude(prompt);
  console.log(`\n✓ Briefing: ${summary}\n`);

  // --- Output ---
  const output = {
    generatedAt: new Date().toISOString(),
    weekLabel: label,
    weekStart: start,
    weekEnd: end,
    summary,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`✅ tech-briefing.json written`);
}

main().catch((err) => { console.error(err); process.exit(1); });
