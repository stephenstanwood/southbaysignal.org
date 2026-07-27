/**
 * Event extractor — single Claude Sonnet call per inbound email.
 *
 * Routes through the Mini Claude proxy (Stephen's Max subscription) instead
 * of the metered Anthropic API when available. Falls back to the Anthropic API
 * if the proxy is down/misconfigured so inbound mail does not silently stop
 * producing events.
 */

import { MiniClaude } from "../miniClaude.js";
import type { InboundEmail } from "./types.js";

type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock;
type AnthropicMessageResponse = { content: AnthropicTextBlock[] };

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
  - In multi-event newsletters (JAMsj, chamber roundups, etc.), bind each sourceUrl to the link nearest that event's title/block — never reuse a neighboring event's ticket link.
  - Prefer the venue or chamber's own URL. If the only event-specific link is a newsletter click-tracking URL, return it; the pipeline will unwrap it later.
- If the city is Morgan Hill or Gilroy, return cityName: null (we don't cover those).
- Return ONLY the JSON object, no markdown code fences, no commentary.

FLYER PARSING — chamber newsletters often include event flyers. Details can appear in two places:
  1. HTML tables / side-by-side cells (date on one side, time + address on the other) — pull the time and location from the adjacent cells, not just the headline.
  2. **EMBEDDED IMAGES** — ribbon cuttings, grand openings, and mixers are frequently rendered entirely as a flyer image, with the date/time/address/venue name baked into the image. The message includes these images after the text block. READ THEM. Match each image to its event by surrounding context (adjacent RSVP links, "Ribbon Cutting" headers, nearby dates). If a flyer image shows "3:00 PM / 45 W Main Street, Los Gatos, CA", use those values — do NOT return null for location or leave startsAt at T00:00:00.

If a time is given anywhere (HTML or image), include it in startsAt as "T15:00:00-07:00" (or the correct offset), never "T00:00:00".`;

export async function extractEvents(
  email: InboundEmail,
  // anthropicKey is preserved in the signature so callers don't have to change.
  // Prefer this key for direct API fallback, else ANTHROPIC_API_KEY.
  _opts?: { anthropicKey?: string }
): Promise<ExtractedEvent[]> {
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
  // Fetch bytes ourselves and pass as base64 — Anthropic's URL fetcher
  // respects robots.txt, which Constant Contact's CDN disallows. We're the
  // recipient of the email (not a crawler), so fetching images directly is
  // normal email-client behavior.
  const imageUrls = email.html ? extractFlyerImageUrls(email.html) : [];
  const imageBlocks = await Promise.all(imageUrls.map(fetchImageAsBase64));

  const userBlocks: AnthropicContentBlock[] = [
    { type: "text", text: textBlock },
  ];
  for (const block of imageBlocks) {
    if (block) userBlocks.push(block);
  }

  const response = await createClaudeMessage({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userBlocks }],
  }, _opts);

  const text = (response.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
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

const URL_TITLE_STOP = new Set([
  "about", "annual", "avenue", "california", "community", "event", "events",
  "friday", "game", "games", "heritage", "monday", "night", "saturday",
  "sunday", "thursday", "ticket", "tickets", "tuesday", "wednesday",
  "2026", "2027", "free", "jose", "san", "the", "with", "from", "your",
]);

const OPAQUE_TICKET_VENDOR = /(?:^|\.)(?:ticketmaster|mlb\.tickets|tickets\.com|milb|gofevo)(?:\.|$)/i;

function significantUrlTitleTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length >= 5 && !URL_TITLE_STOP.has(word));
}

/** Reject cross-wired newsletter links whose slug clearly names another event. */
export function sourceUrlAlignsWithTitle(title: string, url: string | null): boolean {
  if (!url) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (OPAQUE_TICKET_VENDOR.test(parsed.hostname)) return true;

  const haystack = `${parsed.hostname} ${parsed.pathname} ${parsed.search}`.toLowerCase();
  const titleTokens = significantUrlTitleTokens(title);
  if (titleTokens.length === 0) return true;

  const urlTokens = significantUrlTitleTokens(haystack.replace(/\//g, " "));
  if (urlTokens.length === 0) return true;

  return titleTokens.some((token) =>
    urlTokens.some((candidate) =>
      candidate === token || candidate.includes(token) || token.includes(candidate),
    ),
  );
}

/**
 * Null out non-web source URLs that sneak past the prompt. Tracker links are
 * intentionally preserved: pull-inbound-events.mjs unwraps them before
 * generate-events.mjs tries to backfill missing times from canonical pages.
 */
export function sanitizeExtractedEvent(e: ExtractedEvent): ExtractedEvent {
  const cleaned = { ...e };
  if (cleaned.sourceUrl) {
    if (cleaned.sourceUrl.startsWith("mailto:")) {
      cleaned.sourceUrl = null;
    } else if (!sourceUrlAlignsWithTitle(cleaned.title, cleaned.sourceUrl)) {
      cleaned.sourceUrl = null;
    }
  }
  return cleaned;
}

async function createClaudeMessage(
  params: Parameters<MiniClaude["messages"]["create"]>[0],
  opts?: { anthropicKey?: string }
): Promise<AnthropicMessageResponse> {
  const errors: string[] = [];
  const miniUrl = envValue("MINI_CLAUDE_URL");
  const miniToken = envValue("MINI_CLAUDE_TOKEN");
  if (miniUrl && miniToken) {
    try {
      const client = new MiniClaude({ url: miniUrl, token: miniToken });
      return await client.messages.create(params);
    } catch (err) {
      errors.push((err as Error).message);
      console.error("[extractor] Mini Claude failed; trying Anthropic fallback:", (err as Error).message);
    }
  }

  const anthropicKey = opts?.anthropicKey || envValue("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    if (errors.length > 0) throw new Error(errors.join("; "));
    throw new Error("No extractor backend configured: set MINI_CLAUDE_URL/MINI_CLAUDE_TOKEN or ANTHROPIC_API_KEY");
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": anthropicKey,
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const prefix = errors.length ? ` after Mini failure (${errors.join("; ")})` : "";
    throw new Error(`Anthropic fallback ${res.status}${prefix}: ${body.slice(0, 300)}`);
  }

  return (await res.json()) as AnthropicMessageResponse;
}

function envValue(key: string): string {
  const fromImport = typeof import.meta !== "undefined"
    ? (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.[key]
    : undefined;
  const fromProcess = typeof process !== "undefined"
    ? process.env?.[key]
    : undefined;
  return (fromImport ?? fromProcess ?? "") || "";
}

/**
 * Pull <img src> URLs from the email HTML that are plausibly event flyers.
 * Skips tiny tracking pixels, data: URIs, icons, and known non-flyer assets.
 * Caps the list so we don't blow token budget on a newsletter with 40+ images.
 */
type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string };
};

async function fetchImageAsBase64(url: string): Promise<ImageBlock | null> {
  try {
    const res = await fetch(url, {
      headers: {
        // Look like a normal email client, not a bot
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const headerMediaType = normalizeMediaType(contentType);
    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    const mediaType = sniffMediaType(buf) || headerMediaType;
    if (!mediaType) return null;
    // Anthropic's image limit is applied after base64 encoding. Keep raw bytes
    // well below 5MB so the encoded payload cannot cross the API limit.
    if (buf.byteLength > 3.5 * 1024 * 1024) return null;
    const data = buf.toString("base64");
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  } catch {
    return null;
  }
}

function normalizeMediaType(ct: string): ImageBlock["source"]["media_type"] | null {
  const lc = ct.toLowerCase();
  if (lc.includes("jpeg") || lc.includes("jpg")) return "image/jpeg";
  if (lc.includes("png")) return "image/png";
  if (lc.includes("gif")) return "image/gif";
  if (lc.includes("webp")) return "image/webp";
  return null;
}

function sniffMediaType(buf: Buffer): ImageBlock["source"]["media_type"] | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

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

export function isValidExtractedEvent(e: unknown): e is ExtractedEvent {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.title === "string" &&
    o.title.length > 0 &&
    typeof o.startsAt === "string" &&
    o.startsAt.length > 0
  );
}

export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1];
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "");
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) return trimmed.slice(first, last + 1);
  return text;
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
