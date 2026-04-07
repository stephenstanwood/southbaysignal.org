// ---------------------------------------------------------------------------
// South Bay Signal — Copy Generation
// Uses Claude to write platform-specific social copy
// Single-item-per-post model
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_MODEL, CONFIG } from "./constants.mjs";

const __copygen_dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  if (!process.env.ANTHROPIC_API_KEY) {
    try {
      const envPath = join(__copygen_dirname, "..", "..", "..", ".env.local");
      const lines = readFileSync(envPath, "utf8").split("\n");
      for (const line of lines) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {}
  }
}

const SYSTEM_PROMPT = `You are the social voice of The South Bay Signal, a hyperlocal community tool for the South Bay (San Jose, Palo Alto, Campbell, Los Gatos, Saratoga, Cupertino, Sunnyvale, Mountain View, Santa Clara, Los Altos, Milpitas). Always refer to us as "The South Bay Signal" (with "The") when using our name.

VOICE:
- Sound like a friend who went there and liked it, NOT marketing copy
- Warm, specific, natural rhythm, slightly playful
- 1-3 emojis placed naturally, adding warmth not replacing words
- We INFORM, we don't ENDORSE — excited is fine, ad copy is not
- Never generic ("your Saturday is fully booked"), never forced ("stacked", "huge"), never vague ("got options")
- Never sound like the venue's PR team or homepage copy
- No permit/construction jargon ("new build", "finish interior", "TI work")

STRUCTURE:
- ONE item per post. Full detail. ONE direct link.
- The link goes to the EVENT/SOURCE (ticketmaster, venue site, agenda PDF), NOT to southbaysignal.org
- Keep within platform character limits
- The URL is part of the character count

TRUST MODEL:
- We do the legwork so people don't have to
- If we consistently deliver useful info, people seek us out
- We don't need to mention our site — it's in the bio

THINGS TO NEVER DO:
- Don't claim things you aren't sure about (don't say "home opener" unless told it is)
- Don't use permit/construction language
- Don't combine multiple unrelated items
- Don't promote events that have already happened
- Don't link to generic homepages

LINKS:
- Always use full URLs with https:// — bare domains (e.g. "southbaysignal.org") don't become clickable on Bluesky or Threads
- The URL in the post must be exactly the one provided in the item data`;

/**
 * Generate copy for a SINGLE item.
 *
 * @param {object} item - The candidate item with title, city, venue, time, url, summary, category
 * @param {string} timeOfDay - "morning" | "afternoon" | "evening"
 * @returns {Promise<{x: string, threads: string, bluesky: string, facebook: string}>}
 */
export async function generateSingleItemCopy(item, timeOfDay = "morning") {
  loadEnv();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const now = new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    dateStyle: "full",
    timeStyle: "short",
  });

  const prompt = `Write a social post about this ONE item. Current time: ${now}. Time of day: ${timeOfDay}.

ITEM:
- Title: ${item.title}
- City: ${item.cityName || item.city || ""}
- Venue: ${item.venue || ""}
- Date: ${item.date || ""}
- Time: ${item.time || ""}
- Category: ${item.category || ""}
- Summary: ${item.summary ? item.summary.slice(0, 300) : ""}
- Cost: ${item.cost || ""}
- URL (MUST include this exact URL): ${item.url}

Write four variants:
1. X (max 270 chars including URL) — punchy, clean, no hashtags
2. Threads (max 470 chars including URL + hashtags) — slightly warmer, can breathe more. End with 2-3 relevant hashtags (e.g. #SanJose #LiveMusic #ThingsToDo)
3. Bluesky (max 270 chars including URL + hashtags) — similar to X, can be slightly looser. End with 2-3 relevant hashtags (e.g. #SouthBay #SanJose #LocalNews). These hashtags are important for Bluesky discovery and Surf.social aggregation.
4. Facebook (max 500 chars including URL) — conversational, can include a bit more context, similar warmth to Threads, no hashtags

Each variant must include the exact URL provided above.
Use time-appropriate framing ("tonight", "this afternoon", "tomorrow", "this weekend" etc. based on current time).

HASHTAG RULES (for Bluesky and Threads only):
- Always include a city hashtag: #SanJose, #Campbell, #LosGatos, #PaloAlto, #Cupertino, #Sunnyvale, #MountainView, #SantaClara, #Milpitas, #Saratoga, #LosAltos
- Add 1-2 topic hashtags based on category: #LiveMusic, #LocalNews, #ThingsToDo, #FreeEvents, #SouthBay, #SiliconValley, #BayArea, #LocalArts, #CityHall, #YouthSports
- Max 3 hashtags total. Place them at the very end, space-separated.
- Hashtags count toward the character limit.

Return ONLY a JSON object with keys "x", "threads", "bluesky", "facebook" — each a string. No other text.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? "";

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to extract JSON from Claude response: ${text.slice(0, 200)}`);
  }

  const variants = JSON.parse(jsonMatch[0]);

  if (!variants.x || !variants.threads || !variants.bluesky || !variants.facebook) {
    throw new Error("Missing platform variant in Claude response");
  }

  return variants;
}

/**
 * Generate copy for an SV History milestone post.
 *
 * @param {object} milestone - TechMilestone object from tech-companies.ts
 * @param {Date} ptTime - current Pacific Time
 * @returns {Promise<{x: string, threads: string, bluesky: string, facebook: string}>}
 */
export async function generateSvHistoryCopy(milestone, ptTime) {
  loadEnv();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const age = ptTime.getFullYear() - milestone.foundedYear;
  const now = ptTime.toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "short",
  });

  const ordinal = (n) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  const defunctNote = milestone.defunct
    ? `\nNote: ${milestone.company} no longer exists as an independent company.`
    : "";
  const chmNote = milestone.chmExhibit
    ? `\nComputer History Museum exhibit: "${milestone.chmExhibit}"`
    : "";

  const prompt = `Write an "On This Day in Silicon Valley" social post about this tech milestone. Current date: ${now}.

MILESTONE:
- Company: ${milestone.company}
- City: ${milestone.city}
- Founded/Occurred: ${milestone.month}/${milestone.day}/${milestone.foundedYear}
- Age: ${age} years (${ordinal(age)} anniversary)
- Tagline: ${milestone.tagline}
- Anniversary context: ${milestone.anniversaryNote}
- URL (MUST include this exact URL): ${milestone.url}${defunctNote}${chmNote}

TONE FOR THIS POST TYPE:
- This is a "Silicon Valley history" post, not a breaking news item
- Lead with the anniversary angle: "${age} years ago today..." or "On this day in ${milestone.foundedYear}..."
- Be reverent but not stuffy — these are origin stories, not textbook entries
- Connect the past to why it matters NOW in the South Bay
- If the company still exists locally, nod to its current presence
- If defunct, frame it as legacy/influence, not loss

Write four variants:
1. X (max 270 chars including URL) — punchy, clean, no hashtags
2. Threads (max 470 chars including URL + hashtags) — slightly warmer, can breathe more. End with 2-3 relevant hashtags
3. Bluesky (max 270 chars including URL + hashtags) — similar to X, can be slightly looser. End with 2-3 relevant hashtags
4. Facebook (max 500 chars including URL) — conversational, can include a bit more context, no hashtags

Each variant must include the exact URL provided above.

HASHTAG RULES (for Bluesky and Threads only):
- Always include #SiliconValley
- Add a city hashtag: #${milestone.city.replace(/\s+/g, "")}
- Add 1 topic hashtag: #TechHistory, #OnThisDay, or #SouthBay
- Max 3 hashtags total. Place them at the very end, space-separated.

Return ONLY a JSON object with keys "x", "threads", "bluesky", "facebook" — each a string. No other text.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? "";

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to extract JSON from Claude response: ${text.slice(0, 200)}`);
  }

  const variants = JSON.parse(jsonMatch[0]);

  if (!variants.x || !variants.threads || !variants.bluesky || !variants.facebook) {
    throw new Error("Missing platform variant in Claude response");
  }

  return variants;
}

// Keep the old function for backward compat during transition
export async function generateCopy(format, items, url) {
  if (items.length === 1) {
    return generateSingleItemCopy(items[0]);
  }
  // Fallback to old behavior for multi-item (will be removed)
  return generateSingleItemCopy(items[0]);
}
