/**
 * Event extractor — single Claude Haiku call per inbound email.
 *
 * Returns an array of concrete events with dates. Uses the Anthropic SDK
 * already in this repo (no new dep). Falls back to an empty array on any
 * parse error — the intake endpoint logs and moves on.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { InboundEmail } from "./types.js";

export interface ExtractedEvent {
  title: string;
  startsAt: string; // ISO 8601 with America/Los_Angeles offset
  endsAt: string | null;
  location: string | null;
  description: string;
  sourceUrl: string | null;
  cityName: string | null;
}

const SBT_CITIES: Record<string, string> = {
  "campbell": "Campbell",
  "cupertino": "Cupertino",
  "gilroy": "Gilroy",
  "los-altos": "Los Altos",
  "los-gatos": "Los Gatos",
  "milpitas": "Milpitas",
  "monte-sereno": "Monte Sereno",
  "morgan-hill": "Morgan Hill",
  "mountain-view": "Mountain View",
  "palo-alto": "Palo Alto",
  "san-jose": "San Jose",
  "santa-clara": "Santa Clara",
  "saratoga": "Saratoga",
  "sunnyvale": "Sunnyvale",
};

export function normalizeCityKey(cityName: string | null): string | null {
  if (!cityName) return null;
  const lc = cityName.toLowerCase().trim().replace(/\s+/g, "-");
  if (lc in SBT_CITIES) return lc;
  // Try without dashes
  const alt = lc.replace(/-/g, " ");
  const match = Object.entries(SBT_CITIES).find(([, v]) => v.toLowerCase() === alt);
  return match ? match[0] : null;
}

const SYSTEM_PROMPT = `You extract community events from city newsletter emails sent to South Bay Today, a San Francisco Bay Area local news aggregator covering Santa Clara County.

Return strict JSON matching this schema:
{
  "events": [
    {
      "title": "short descriptive event name (no marketing fluff, no ALL CAPS)",
      "startsAt": "ISO 8601 timestamp with -07:00 or -08:00 offset (America/Los_Angeles)",
      "endsAt": "ISO 8601 or null if not specified",
      "location": "venue name + address if given, else null",
      "description": "1-2 sentence plain-English summary, no marketing fluff",
      "sourceUrl": "primary 'more info' link, else null",
      "cityName": "city this event is in — one of: Campbell, Cupertino, Gilroy, Los Altos, Los Gatos, Milpitas, Monte Sereno, Morgan Hill, Mountain View, Palo Alto, San Jose, Santa Clara, Saratoga, Sunnyvale, or null if not determinable"
    }
  ]
}

Rules:
- Only return events with a CONCRETE date. Skip "ongoing" classes, recurring weekly things unless the email announces a specific instance, and vague "coming soon" items.
- If the email has zero concrete events (e.g. RFP notification, bid announcement, council agenda, meeting invitation, welcome email, confirmation email), return {"events": []}.
- Skip events past today's date.
- Deduplicate within one email.
- Do NOT invent fields. If a field is missing, use null (or empty string for description).
- Prefer the event's own page URL over the newsletter's main URL.
- Return ONLY the JSON object, no markdown code fences, no commentary.`;

export async function extractEvents(
  email: InboundEmail,
  opts: { anthropicKey: string }
): Promise<ExtractedEvent[]> {
  const client = new Anthropic({ apiKey: opts.anthropicKey });

  const userContent = `FROM: ${email.from}
SUBJECT: ${email.subject}
RECEIVED: ${email.receivedAt}

BODY:
${truncate(email.body, 30_000)}`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const jsonText = stripCodeFence(text).trim();
  let parsed: { events?: ExtractedEvent[] };
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.error("[extractor] JSON parse failed:", (err as Error).message);
    console.error("[extractor] raw response:", text.slice(0, 500));
    return [];
  }

  const events = Array.isArray(parsed.events) ? parsed.events : [];
  return events.filter(isValidExtractedEvent);
}

function isValidExtractedEvent(e: unknown): e is ExtractedEvent {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.title === "string" &&
    o.title.length > 0 &&
    typeof o.startsAt === "string" &&
    o.startsAt.length > 0
  );
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1] : text;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n\n[...truncated]";
}
