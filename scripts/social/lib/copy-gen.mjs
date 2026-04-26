// ---------------------------------------------------------------------------
// South Bay Signal — Copy Generation
// Uses Claude to write platform-specific social copy
// Single-item-per-post model
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_COPY_MODEL, CONFIG } from "./constants.mjs";
import { mentionInstructions, applyTagSubstitutions, recordUntaggedItem } from "./handle-lookup.mjs";

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

// Hosts that are aggregator/homepage-only — a URL with empty path here means
// "no real link", which produces "No URL provided" or a useless homepage in copy.
const COPY_GENERIC_HOSTS = new Set([
  "eventbrite.com", "www.eventbrite.com",
  "facebook.com", "www.facebook.com", "m.facebook.com",
  "instagram.com", "www.instagram.com",
  "twitter.com", "www.twitter.com", "x.com", "www.x.com",
  "meetup.com", "www.meetup.com",
  "google.com", "www.google.com",
  "linktr.ee", "linktree.com",
]);
export function isUsableSocialUrl(u) {
  if (!u || typeof u !== "string") return false;
  const trimmed = u.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  let parsed;
  try { parsed = new URL(trimmed); } catch { return false; }
  const path = parsed.pathname.replace(/\/$/, "");
  if (COPY_GENERIC_HOSTS.has(parsed.hostname.toLowerCase()) && path === "") return false;
  return true;
}

const SYSTEM_PROMPT = `You are the social voice of South Bay Today, a hyperlocal community tool for the South Bay (San Jose, Palo Alto, Campbell, Los Gatos, Saratoga, Cupertino, Sunnyvale, Mountain View, Santa Clara, Los Altos, Milpitas). Always refer to us as "South Bay Today" when using our name.

VOICE:
- Sound like a friend who went there and liked it, NOT marketing copy
- Warm, specific, natural rhythm, slightly playful
- 1-3 emojis placed naturally, adding warmth not replacing words
- We INFORM, we don't ENDORSE — excited is fine, ad copy is not
- Always capitalize the first word of every sentence and post. Proper grammar throughout.
- Never generic ("your Saturday is fully booked"), never forced ("stacked", "huge"), never vague ("got options")
- Never sound like the venue's PR team or homepage copy
- No permit/construction jargon ("new build", "finish interior", "TI work")

STRUCTURE:
- ONE item per post. Full detail. ONE direct link.
- The link goes to the EVENT/SOURCE (ticketmaster, venue site, agenda PDF), NOT to southbaytoday.org
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
- NEVER say "right now", "happening right now", "right this minute", "as we speak", or any variant. These phrases are banned.
- NEVER invent specific clock times (e.g. "9 AM", "7 PM") that weren't in the source data.

LINKS:
- Always use full URLs with https:// — bare domains (e.g. "southbaytoday.org") don't become clickable on Bluesky or Threads
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

  const nowPT = new Date();
  const now = nowPT.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    dateStyle: "full",
    timeStyle: "short",
  });

  // Compute relative time distance for the event so we can give the model
  // explicit guidance about when a bare weekday name is OK vs. ambiguous.
  const todayStr = nowPT.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  let dateContext = "";
  if (item.date) {
    const eventD = new Date(item.date + "T12:00:00");
    const todayD = new Date(todayStr + "T12:00:00");
    const daysOut = Math.round((eventD - todayD) / 86400000);
    const eventWeekday = eventD.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Los_Angeles" });
    const eventMonthDay = eventD.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/Los_Angeles" });
    if (daysOut === 0) {
      dateContext = `The event is TODAY (${eventWeekday}, ${eventMonthDay}). Use "today" or "tonight".`;
    } else if (daysOut === 1) {
      dateContext = `The event is TOMORROW (${eventWeekday}, ${eventMonthDay}). Use "tomorrow".`;
    } else if (daysOut >= 2 && daysOut <= 7) {
      dateContext = `The event is ${daysOut} days away, on ${eventWeekday}, ${eventMonthDay}. You MAY use the bare weekday name "${eventWeekday}" (it's the next ${eventWeekday} from today). Also fine: "this ${eventWeekday}" or "${eventMonthDay}".`;
    } else if (daysOut >= 8 && daysOut <= 14) {
      dateContext = `The event is ${daysOut} days away, on ${eventWeekday}, ${eventMonthDay}. This is NEXT week's ${eventWeekday}, NOT this week's — so the bare word "${eventWeekday}" is ambiguous and FORBIDDEN. You MUST qualify it as "next ${eventWeekday}", "${eventWeekday} the ${eventD.getDate()}th", or just "${eventMonthDay}".`;
    } else {
      dateContext = `The event is ${daysOut} days away, on ${eventWeekday}, ${eventMonthDay}. Use the specific date "${eventMonthDay}" — bare weekday names are too ambiguous this far out.`;
    }
  }

  // When a plan URL exists, link to the full day plan instead of the raw event URL
  const postUrl = item.planUrl || item.url;
  const hasPlanLink = !!item.planUrl;
  const urlNote = hasPlanLink
    ? `- URL (MUST include this exact URL): ${postUrl}\n- This URL links to a full day plan built around this event. Frame the link as "here's a whole day plan" or "we built a day around it" — don't just say "get tickets". The plan page shows this event plus surrounding activities.`
    : `- URL (MUST include this exact URL): ${postUrl}`;

  // Build mention instructions from handle database
  const mentions = mentionInstructions(item);

  const prompt = `Write a social post about this ONE item. Current time: ${now}. Time of day: ${timeOfDay}.

DATE CONTEXT: ${dateContext}

ITEM:
- Title: ${item.title}
- City: ${item.cityName || item.city || ""}
- Venue: ${item.venue || ""}
- Date: ${item.date || ""}
- Time: ${item.time || ""}
- Category: ${item.category || ""}
- Summary: ${item.summary ? item.summary.slice(0, 300) : ""}
- Cost: ${item.cost || ""}
${urlNote}
${mentions}
Write five variants:
1. X (max 270 chars including URL) — punchy, clean, no hashtags
2. Threads (max 470 chars including URL + hashtags) — slightly warmer, can breathe more. End with 2-3 relevant hashtags (e.g. #SanJose #LiveMusic #ThingsToDo)
3. Bluesky (max 270 chars including URL + hashtags) — similar to X, can be slightly looser. End with 2-3 relevant hashtags (e.g. #SouthBay #SanJose #LocalNews). These hashtags are important for Bluesky discovery and Surf.social aggregation.
4. Facebook (max 500 chars including URL) — conversational, can include a bit more context, similar warmth to Threads, no hashtags
5. Instagram (max 2000 chars including URL + hashtags) — warmest, most descriptive. This is a caption for a photo post. Include 8-15 relevant hashtags at the end (city, topic, discovery tags like #ThingsToDoInSanJose #SouthBayEvents #BayAreaEvents #SiliconValleyLife). Instagram captions have room to breathe — add a line break before hashtags. @mention the venue/org if a handle is available.

Each variant must include the exact URL provided above.

TIME ACCURACY (critical):
- ONLY reference a time of day ("morning", "afternoon", "evening", "9 AM", "tonight") if the Time field above has a specific time. NEVER invent one.
- If Time is empty, omit time-of-day references entirely. Frame by date only.
- FOLLOW THE DATE CONTEXT above exactly. A bare weekday name (e.g. "Saturday") refers ONLY to the NEXT occurrence of that weekday — at most 7 days away. If the event is 8+ days away, you MUST qualify it ("next Saturday", "Saturday the 18th", or "April 18"). Saying "Saturday" to mean "Saturday a week from now" is WRONG and forbidden.
- Do NOT say "this week" for events 4+ days out.
- Never fabricate opening hours, start times, or end times not present in the data.

HASHTAG RULES:
- Bluesky/Threads: Always include a city hashtag (#SanJose, #Campbell, etc.) + 1-2 topic hashtags. Max 3 total. Place at the very end.
- Instagram: 8-15 hashtags. Include city, topic, and discovery hashtags. Place after a line break at the end.
- X/Facebook: no hashtags.
- Hashtags count toward the character limit.

MENTION RULES:
- If tagging instructions were provided above, use the correct @handle for each platform variant.
- @mentions count toward the character limit.
- Work mentions into the sentence naturally (e.g. "Catch @SJBarracuda tonight at SAP Center").
- Skip the mention if it doesn't fit naturally or would push over the char limit.

Return ONLY a JSON object with keys "x", "threads", "bluesky", "facebook", "instagram" — each a string. No other text.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_COPY_MODEL,
      max_tokens: 2048,
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

  // Mastodon reuses Bluesky copy (similar char limits, hashtag-friendly)
  variants.mastodon = variants.bluesky;

  // Instagram fallback — if Claude didn't generate it, derive from Facebook copy + hashtags
  if (!variants.instagram) {
    variants.instagram = variants.facebook;
  }

  // Banned phrase scrub — retry once if Claude slips past the prompt
  const BANNED = /\b(right now|happening right now|right this minute|as we speak|this very moment)\b/i;
  const hasBanned = Object.values(variants).some((v) => BANNED.test(v));
  if (hasBanned) {
    // Strip and let downstream decide; log warning
    for (const key of Object.keys(variants)) {
      variants[key] = variants[key]
        .replace(/happening right now[,.]?/gi, "")
        .replace(/right now[,.]?/gi, "")
        .replace(/right this minute[,.]?/gi, "")
        .replace(/as we speak[,.]?/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
  }

  applyTagSubstitutions(variants, item);
  recordUntaggedItem(item, { slot: "single" });

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

  // Calculate explicit char budgets so the model knows exactly how much room it has
  const urlLen = milestone.url.length;
  const hashtagEstimate = 45; // ~"#SiliconValley #SantaClara #TechHistory"
  const xBudget = 280 - urlLen - 2;           // 2 for newline/space before URL
  const bskyBudget = 300 - urlLen - 2 - hashtagEstimate;
  const threadsBudget = 500 - urlLen - 2 - hashtagEstimate;
  const fbBudget = 500 - urlLen - 2;

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

CHARACTER BUDGETS — these are HARD LIMITS. The URL is ${urlLen} chars. You must stay under these totals (text + URL + hashtags combined):
1. X: max 280 chars total. You have ${xBudget} chars for text, then the URL. No hashtags.
2. Threads: max 500 chars total. You have ~${threadsBudget} chars for text, then URL + 3 hashtags.
3. Bluesky: max 300 chars total. You have ~${bskyBudget} chars for text, then URL + 3 hashtags.
4. Facebook: max 500 chars total. You have ${fbBudget} chars for text, then the URL. No hashtags.

CRITICAL: Count your characters carefully. The URL "${milestone.url}" is ${urlLen} characters and MUST be included exactly as-is in every variant. If your text is too long, CUT WORDS rather than exceeding the limit.

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
      model: CLAUDE_COPY_MODEL,
      max_tokens: 2048,
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

  // Mastodon reuses Bluesky copy
  variants.mastodon = variants.bluesky;

  // Enforce hard character limits
  enforceHardLimits(variants);

  return variants;
}

const HARD_LIMITS = { x: 280, threads: 500, bluesky: 300, facebook: 500, instagram: 2200, mastodon: 300 };

/** Enforce hard character limits on all platform variants. */
function enforceHardLimits(variants) {
  for (const [platform, limit] of Object.entries(HARD_LIMITS)) {
    if (variants[platform] && variants[platform].length > limit) {
      variants[platform] = trimToLimit(variants[platform], limit);
    }
  }
}

/**
 * Trim a social post to fit within a character limit.
 * Preserves the URL and hashtags at the end, trims body sentences.
 */
export function trimToLimit(text, limit) {
  if (text.length <= limit) return text;

  // Split off trailing hashtags (lines starting with #)
  const lines = text.split("\n");
  let hashtagSuffix = "";
  while (lines.length > 1 && /^#/.test(lines[lines.length - 1].trim())) {
    hashtagSuffix = "\n" + lines.pop().trim() + hashtagSuffix;
  }
  let body = lines.join("\n").trim();

  // Extract URL from body
  const urlMatch = body.match(/(https?:\/\/\S+)\s*$/);
  let urlSuffix = "";
  if (urlMatch) {
    urlSuffix = " " + urlMatch[1];
    body = body.slice(0, urlMatch.index).trim();
  }

  // Also check for inline hashtags at end of body (space-separated #tags)
  const inlineHashMatch = body.match(/(\s+#\S+(?:\s+#\S+)*)$/);
  if (inlineHashMatch) {
    hashtagSuffix = inlineHashMatch[1] + hashtagSuffix;
    body = body.slice(0, inlineHashMatch.index).trim();
  }

  const suffix = urlSuffix + hashtagSuffix;

  // Trim sentences from the end until it fits
  while (body.length + suffix.length > limit && body.includes(". ")) {
    const lastSentence = body.lastIndexOf(". ");
    body = body.slice(0, lastSentence + 1).trim();
  }

  // If still too long, hard truncate with ellipsis
  const maxBody = limit - suffix.length - 1;
  if (body.length > maxBody) {
    body = body.slice(0, maxBody - 1).trim() + "…";
  }

  return (body + suffix).trim();
}

// Keep the old function for backward compat during transition
export async function generateCopy(format, items, url) {
  if (items.length === 1) {
    return generateSingleItemCopy(items[0]);
  }
  return generateSingleItemCopy(items[0]);
}

// ── New 3-slot content type generators ─────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Generate copy for a full DAY PLAN post (7:15 AM signature slot).
 *
 * @param {object} plan - Plan object with cards array from default-plans.json
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} [planUrl] - Shareable plan link
 * @returns {Promise<{x: string, threads: string, bluesky: string, facebook: string, instagram: string, mastodon: string}>}
 */
export async function generateDayPlanCopy(plan, dateStr, planUrl) {
  loadEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const date = new Date(dateStr + "T12:00:00");
  const dayName = DAY_NAMES[date.getDay()];

  const cities = [...new Set(plan.cards.map((c) => c.city).filter(Boolean))];
  const cityDisplay = cities.map((c) => {
    const parts = c.split("-");
    return parts.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  }).join(", ");

  let stopsText = "";
  const allMentions = [];
  for (const card of plan.cards) {
    const time = card.timeBlock?.split(" - ")[0] || "";
    stopsText += `- ${time}: ${card.name}\n  ${(card.blurb || "").slice(0, 100)}\n`;
    // Collect handle mentions for all stops
    const m = mentionInstructions({ venue: card.name, title: card.name });
    if (m) allMentions.push(m);
  }
  // Include all unique handle matches so the LLM can @mention multiple stops
  const uniqueMentions = [...new Set(allMentions.filter(Boolean))];
  const mentionBlock = uniqueMentions.length > 0 ? uniqueMentions.join("\n") : "";

  const url = planUrl || `https://southbaytoday.org`;

  const prompt = `Write a social post promoting a FULL DAY PLAN for ${dayName} in the South Bay. This is our signature daily post — it should feel like an invitation to an awesome day.

DAY: ${dayName}, ${date.toLocaleDateString("en-US", { month: "long", day: "numeric" })}
CITIES: ${cityDisplay}

STOPS:
${stopsText}

URL (MUST include this exact URL): ${url}
${mentionBlock}

LINKS:
- Always use full URLs with https:// — bare domains don't become clickable on Bluesky or Threads
- The URL in the post must be exactly the one provided above
${url.includes('/plan/') ? "- This URL links to a full day plan. Frame the link as \"here's a whole day plan\" or \"we built a day around it\" — the plan page shows all stops." : ''}

This is NOT a single event — it's a curated day plan with ${plan.cards.length} stops. Frame it as "here's your ${dayName}" or "we planned your ${dayName}". The tone should be: we did the work so you don't have to.

Write five variants:
1. X (max 270 chars including URL) — punchy hook, no hashtags
2. Threads (max 470 chars including URL + hashtags) — warmer, list a couple highlights. 2-3 hashtags.
3. Bluesky (max 270 chars including URL + hashtags) — similar to X. 2-3 hashtags.
4. Facebook (max 500 chars including URL) — conversational, can mention more stops. No hashtags.
5. Instagram (max 2000 chars including URL + hashtags) — full caption, mention all stops briefly, 8-15 hashtags at end.

Return ONLY a JSON object with keys "x", "threads", "bluesky", "facebook", "instagram". No other text.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_COPY_MODEL,
      max_tokens: 2048,
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
  if (!jsonMatch) throw new Error("Failed to extract JSON from Claude response");

  const variants = JSON.parse(jsonMatch[0]);
  variants.mastodon = variants.bluesky;
  if (!variants.instagram) variants.instagram = variants.facebook;

  applyTagSubstitutions(variants, plan);
  recordUntaggedItem(plan, { slot: "day-plan" });

  // Enforce hard character limits
  enforceHardLimits(variants);

  return variants;
}

/**
 * Generate copy for a TONIGHT PICK post (11:45 AM slot).
 *
 * @param {object} item - Single event/restaurant item
 * @returns {Promise<{x: string, threads: string, bluesky: string, facebook: string, instagram: string, mastodon: string}>}
 */
export async function generateTonightPickCopy(item) {
  loadEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const mentions = mentionInstructions(item);
  const postUrl = item.planUrl || item.url;
  // Defense-in-depth: bail loudly instead of letting Claude write
  // "No URL provided" or splice in a generic homepage. Caller should pick
  // a different candidate.
  if (!isUsableSocialUrl(postUrl)) {
    throw new Error(`tonight-pick "${item.title || item.name}" has no usable URL (got "${postUrl}") — caller must filter`);
  }

  const prompt = `Write a social post recommending ONE thing to do TONIGHT in the South Bay. This is our midday "tonight pick" — make people excited about their evening.

ITEM:
- Title: ${item.title || item.name}
- City: ${item.cityName || item.city || ""}
- Venue: ${item.venue || ""}
- Time: ${item.time || "tonight"}
- Category: ${item.category || ""}
- Summary: ${(item.summary || item.blurb || "").slice(0, 300)}
- Cost: ${item.costNote || item.cost || ""}
- URL (MUST include): ${postUrl}
${mentions}

Frame this as a TONIGHT recommendation. "Tonight in the South Bay..." energy. One great thing, full enthusiasm.

Write five variants:
1. X (max 270 chars including URL) — punchy, no hashtags
2. Threads (max 470 chars including URL + hashtags) — warmer. 2-3 hashtags.
3. Bluesky (max 270 chars including URL + hashtags) — 2-3 hashtags.
4. Facebook (max 500 chars including URL) — conversational. No hashtags.
5. Instagram (max 2000 chars including URL + hashtags) — full caption, 8-15 hashtags.

Return ONLY a JSON object with keys "x", "threads", "bluesky", "facebook", "instagram". No other text.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_COPY_MODEL,
      max_tokens: 2048,
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
  if (!jsonMatch) throw new Error("Failed to extract JSON from Claude response");

  const variants = JSON.parse(jsonMatch[0]);
  variants.mastodon = variants.bluesky;
  if (!variants.instagram) variants.instagram = variants.facebook;

  applyTagSubstitutions(variants, item);
  recordUntaggedItem(item, { slot: "tonight-pick" });

  // Enforce hard character limits
  enforceHardLimits(variants);

  return variants;
}

/**
 * Generate copy for a WILDCARD post (4:30 PM slot).
 * Dispatches based on content subtype.
 *
 * @param {object} item - Content item
 * @param {string} subtype - "sv-history" | "restaurant" | "general"
 * @returns {Promise<{x: string, threads: string, bluesky: string, facebook: string, instagram: string, mastodon: string}>}
 */
export async function generateWildcardCopy(item, subtype = "general") {
  // SV History has its own generator
  if (subtype === "sv-history" && item.foundedYear) {
    const ptTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const variants = await generateSvHistoryCopy(item, ptTime);
    if (!variants.instagram) variants.instagram = variants.facebook;
    return variants;
  }

  // Restaurant openings and general items use the single-item generator
  // with a subtype-aware framing
  return generateSingleItemCopy(item, "afternoon");
}
