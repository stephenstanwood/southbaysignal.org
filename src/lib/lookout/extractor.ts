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

// Cities we cover. Morgan Hill + Gilroy excluded — outside our geo area
// as of 2026-04-15. Events from those cities will be dropped at normalize time.
const SBT_CITIES: Record<string, string> = {
  "campbell": "Campbell",
  "cupertino": "Cupertino",
  "los-altos": "Los Altos",
  "los-gatos": "Los Gatos",
  "milpitas": "Milpitas",
  "monte-sereno": "Monte Sereno",
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
      "cityName": "city this event is in — one of: Campbell, Cupertino, Los Altos, Los Gatos, Milpitas, Monte Sereno, Mountain View, Palo Alto, San Jose, Santa Clara, Saratoga, Sunnyvale, or null if not determinable"
    }
  ]
}

CRITERIA — only include events that meet BOTH:
1. **Open to the public** — anyone can show up. Skip private/internal/members-only events.
2. **Interesting** — would be worth telling a neighbor about. Skip routine procedural stuff.

INCLUDE these kinds of events:
- Festivals, fairs, markets, parades, block parties, public celebrations
- Free or ticketed cultural events: concerts, theater, art openings, exhibits, film screenings
- Family/kid events: egg hunts, story times, holiday celebrations, library kid programs
- Educational public events: lectures, classes that are open to anyone
- Community service: volunteer cleanups, food drives, donation events
- Sports events open to the public: races, tournaments, opening days
- Business openings (grand openings of restaurants, shops, venues)
- Town halls and listening sessions explicitly marked as community-facing
- Public art walks, gallery nights, food/wine events

EXCLUDE these kinds of events:
- Council meetings, commission meetings, committee meetings, board meetings, study sessions
- Public hearings, RFP/bid announcements, legal notices
- Deadlines, application windows, "save the date" without a confirmed date
- Welcome/confirmation/security emails (return {"events": []} for these entirely)
- School-internal events: PTA meetings, parent-teacher conferences, in-school assemblies, opportunity fairs only for enrolled students
- Members-only: chamber mixers, private galas, ticketed donor events
- Coffee chats / office hours / "meet the mayor" 1-on-1 slots
- Recognition / past events the newsletter is recapping
- Private parties, weddings, corporate events held at venues
- Recurring meetings without a specific named instance (e.g. "every first Monday")
- Vague announcements about ongoing programs without a specific event date

Other rules:
- Only return events with a CONCRETE date. Skip "ongoing", recurring weekly things unless the email announces a specific named instance, and vague "coming soon" items.
- Skip events past today's date.
- Deduplicate within one email.
- Do NOT invent fields. If a field is missing, use null (or empty string for description).
- Prefer the event's own page URL over the newsletter's main URL.
  - NEVER use a mailto: link as sourceUrl. If the only contact is an email address, set sourceUrl to null.
  - NEVER use Constant Contact / ccsend / click-tracking redirect URLs that don't point at a public event page. Prefer the venue or chamber's own URL.
- If the city is Morgan Hill or Gilroy, return cityName: null (we don't cover those).
- Return ONLY the JSON object, no markdown code fences, no commentary.

FLYER PARSING — chamber newsletters often include event flyers. Details can appear in two places:
  1. HTML tables / side-by-side cells (date on one side, time + address on the other) — pull the time and location from the adjacent cells, not just the headline.
  2. **EMBEDDED IMAGES** — ribbon cuttings, grand openings, and mixers are frequently rendered entirely as a flyer image, with the date/time/address/venue name baked into the image. The message includes these images after the text block. READ THEM. Match each image to its event by surrounding context (adjacent RSVP links, "Ribbon Cutting" headers, nearby dates). If a flyer image shows "3:00 PM / 45 W Main Street, Los Gatos, CA", use those values — do NOT return null for location or leave startsAt at T00:00:00.

If a time is given anywhere (HTML or image), include it in startsAt as "T15:00:00-07:00" (or the correct offset), never "T00:00:00".`;

export async function extractEvents(
  email: InboundEmail,
  opts: { anthropicKey: string }
): Promise<ExtractedEvent[]> {
  const client = new Anthropic({ apiKey: opts.anthropicKey });

  // Prefer HTML when available — flyer layouts lose their date/time/location
  // adjacency when flattened to plain text.
  const htmlForModel = email.html ? compactHtml(email.html) : "";
  const bodyBlock = htmlForModel
    ? `HTML (structure preserved; strip styling but read cell adjacency):\n${truncate(htmlForModel, 60_000)}`
    : `BODY:\n${truncate(email.body, 30_000)}`;

  const textBlock = `FROM: ${email.from}
SUBJECT: ${email.subject}
RECEIVED: ${email.receivedAt}

${bodyBlock}`;

  // Pull embedded flyer images so the model can OCR ribbon cuttings /
  // grand openings where all the date/time/address info is baked into an
  // image rather than HTML text. Capped to keep token cost bounded.
  const imageUrls = email.html ? extractFlyerImageUrls(email.html) : [];

  const userBlocks: Anthropic.MessageParam["content"] = [
    { type: "text", text: textBlock },
  ];
  for (const url of imageUrls) {
    userBlocks.push({
      type: "image",
      source: { type: "url", url },
    });
  }

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userBlocks }],
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
  return events.filter(isValidExtractedEvent).map(sanitizeExtractedEvent);
}

/**
 * Null out tracker / click-redirect sourceUrls that sneak past the prompt.
 * These URLs break our "sourceUrl must be a public event page" invariant
 * and can expire when the campaign ends.
 */
const TRACKER_HOST_RE = /\b(cc\.rs6\.net|ccsend\.com|constantcontact\.com|click\.mlsend\.com|mailchi\.mp|click\.mailerlite\.com|utm_|trk\.klclick|links\.mkt|click\.e\.|eml\.|t\.co)\b/i;

function sanitizeExtractedEvent(e: ExtractedEvent): ExtractedEvent {
  const cleaned = { ...e };
  if (cleaned.sourceUrl) {
    if (TRACKER_HOST_RE.test(cleaned.sourceUrl) || cleaned.sourceUrl.startsWith("mailto:")) {
      cleaned.sourceUrl = null;
    }
  }
  return cleaned;
}

/**
 * Pull <img src> URLs from the email HTML that are plausibly event flyers.
 * Skips tiny tracking pixels, data: URIs, icons, and known non-flyer assets.
 * Caps the list so we don't blow token budget on a newsletter with 40+ images.
 */
function extractFlyerImageUrls(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const re = /<img\b[^>]*?\ssrc=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const url = m[1].trim();
    if (!url || seen.has(url)) continue;
    if (url.startsWith("data:")) continue;
    if (!/^https?:\/\//i.test(url)) continue;

    // Skip obvious non-flyers: tracking pixels, logos, social icons, spacers.
    if (/\b(pixel|tracker|open\.gif|spacer|logo|icon|social|facebook|twitter|instagram|linkedin|youtube)\b/i.test(url)) continue;

    // Heuristic: tiny declared dimensions → tracking pixel or spacer.
    const wMatch = tag.match(/\bwidth=["']?(\d+)/i);
    const hMatch = tag.match(/\bheight=["']?(\d+)/i);
    if (wMatch && parseInt(wMatch[1], 10) > 0 && parseInt(wMatch[1], 10) < 80) continue;
    if (hMatch && parseInt(hMatch[1], 10) > 0 && parseInt(hMatch[1], 10) < 80) continue;

    seen.add(url);
    urls.push(url);
    if (urls.length >= 8) break;
  }
  return urls;
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

/**
 * Strip noisy HTML that doesn't help extraction (style/script/head/CSS-only
 * attributes) while preserving tag structure so the model can see which
 * text cells sit next to each other in a flyer table.
 */
function compactHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\s(style|class|width|height|align|valign|bgcolor|cellpadding|cellspacing|border)="[^"]*"/gi, "")
    .replace(/\s(style|class|width|height|align|valign|bgcolor|cellpadding|cellspacing|border)='[^']*'/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
