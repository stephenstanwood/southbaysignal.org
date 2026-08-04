#!/usr/bin/env node
/**
 * generate-tech-briefing.mjs
 *
 * Generates a weekly "This Week in South Bay Tech" editorial briefing using
 * Claude Sonnet. Pulls from recently-funded startups in tech-companies.ts and
 * upcoming tech events from upcoming-events.json.
 *
 * Output: src/data/south-bay/tech-briefing.json
 *
 * Run: node scripts/generate-tech-briefing.mjs
 */

import { readFileSync } from "fs";
import { writeFileAtomic } from "./lib/io.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnvLocal } from "./lib/env.mjs";
import { callClaude as callClaudeApi } from "./lib/claude.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TECH_TS_PATH   = join(__dirname, "..", "src", "data", "south-bay", "tech-companies.ts");
const EVENTS_PATH    = join(__dirname, "..", "src", "data", "south-bay", "upcoming-events.json");
const OUT_PATH       = join(__dirname, "..", "src", "data", "south-bay", "tech-briefing.json");

loadEnvLocal();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set");
  process.exit(1);
}


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
  const text = await callClaudeApi(prompt, { maxTokens: 800, label: "tech-briefing" });
  return text.trim();
}

const TECH_EVENT_KEYWORDS = [
  "artificial intelligence", "machine learning", "robot", "silicon",
  "chip", "semiconductor", "startup", "computer history museum", "chm",
  "hackathon", "neural", "venture capital", "autonomous", "physical ai",
];

// Exclude events where "tech" only appears in the venue name (e.g. "Tech CU Arena")
// and generic library help sessions
const TECH_EVENT_EXCLUDES = /\btech cu\b|tech help|computer help|digital skills|1-on-1|one-on-one|\btech assist/i;

function isTechEvent(event) {
  const title = event.title.toLowerCase();
  const venue = (event.venue ?? "").toLowerCase();
  const haystack = `${title} ${venue}`;
  if (TECH_EVENT_EXCLUDES.test(haystack)) return false;
  // Title-only match for broad terms
  const titleMatch = /\b(ai|tech|chip|software|data|cloud|cyber|coding|engineering|developer)\b/.test(title);
  const deepMatch = TECH_EVENT_KEYWORDS.some((kw) => haystack.includes(kw));
  return titleMatch || deepMatch;
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

  // Only include recent funding (last 45 days), sorted newest first so the
  // prompt's "lead with the freshest" instruction has the latest rounds at top.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 45);
  const cutoffStr = cutoff.toISOString().split("T")[0];
  const recentFunded = funded
    .filter((f) => f.date >= cutoffStr)
    .sort((a, b) => b.date.localeCompare(a.date));

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

Write a concise "This Week in South Bay Tech" briefing for the week of ${label}. It should be 2–3 sentences (50–80 words total). Tone: crisp, grounded, local — like a smart colleague summarizing what's happening right now over coffee. Focus on what's newsworthy for residents who work in or care about local tech. Mention company names and cities when relevant. No hype or jargon.

CRITICAL — structure and timing:
- LEAD with what's happening this week: the tech events below, or the freshest funding (rounds dated within the last 14 days of today). Do not open the briefing with a backward-looking month recap ("April saw…") when there's fresher news available.
- The funding rounds below span up to 45 days. Older rounds belong in a supporting sentence at the END, not the lede. Never say "this week" or "today" about rounds that are weeks old — say "earlier this spring", "over the past month", or just give the company name with no time claim.
- Only the events list represents "this week" — funding rounds do not.

CRITICAL — editorial voice:
- Never characterize the week or its calendar as quiet, slow, thin, light, sparse, sleepy, soft, or weak, and never apologize for what isn't happening. There is always something worth a resident's time; lead with the strongest thing on the list instead of grading the list.
- Describe what IS on, not what is missing. "Light on marquee events but steady on community programming" is exactly the framing to avoid — open on the community programming itself.

Recent funding rounds in the South Bay (last 45 days, newest first):
${fundedLines}

Hiring pulse: ${trends.up} South Bay companies actively growing headcount, ${trends.flat} stable, ${trends.down} pulling back.

Tech events in the South Bay this week (${label}):
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

  writeFileAtomic(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`✅ tech-briefing.json written`);
}

main().catch((err) => { console.error(err); process.exit(1); });
