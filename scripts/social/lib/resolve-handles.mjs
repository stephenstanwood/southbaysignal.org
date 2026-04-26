// ---------------------------------------------------------------------------
// Auto-resolve social handles.
//
// Tier 1 (deterministic): scrape URLs we already have. Most venues link
// X/Instagram/Facebook in their site footer or header. Most event pages
// (Eventbrite, venue calendars) link the venue's or performer's social.
// Pattern-matches HTML for known social-link shapes — no hallucination risk.
//
// Tier 2 (Claude + web search): when Tier 1 misses (no URL, deep page with
// no social links, or performer not on event page), call Claude with the
// web_search tool. Claude must cite a source URL for every handle it
// returns, and we verify the cited URL actually contains the handle before
// accepting. Slower + costs money, so it only runs when Tier 1 returns null.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FETCH_TIMEOUT_MS = 8000;
const CLAUDE_RESOLVER_MODEL = "claude-haiku-4-5-20251001";
const CLAUDE_RESOLVER_MAX_USES = 4; // web searches per name — cap for cost

const HANDLE_PATTERNS = {
  // Group 1 captures the handle. Anchored against ?, /, ", whitespace, end.
  x: [
    /(?:https?:)?\/\/(?:www\.)?twitter\.com\/(?!intent\b|share\b|home\b|search\b|hashtag\b)([A-Za-z0-9_]{1,15})(?=[/?"#\s]|$)/i,
    /(?:https?:)?\/\/(?:www\.)?x\.com\/(?!intent\b|share\b|home\b|search\b|hashtag\b)([A-Za-z0-9_]{1,15})(?=[/?"#\s]|$)/i,
  ],
  instagram: [
    /(?:https?:)?\/\/(?:www\.)?instagram\.com\/(?!p\/|reel\/|stories\/|explore\/|accounts\/)([A-Za-z0-9_.]{1,30})(?=[/?"#\s]|$)/i,
  ],
  threads: [
    /(?:https?:)?\/\/(?:www\.)?threads\.(?:net|com)\/@?([A-Za-z0-9_.]{1,30})(?=[/?"#\s]|$)/i,
  ],
  facebook: [
    /(?:https?:)?\/\/(?:www\.)?facebook\.com\/(?!sharer\b|dialog\b|tr\?|plugins\b|events\/|groups\/)((?:pages\/[^/]+\/[0-9]+)|[A-Za-z0-9.-]{1,50})(?=[/?"#\s]|$)/i,
  ],
  bluesky: [
    /(?:https?:)?\/\/(?:www\.)?bsky\.app\/profile\/([A-Za-z0-9.-]+\.(?:bsky\.social|[a-z]{2,}))(?=[/?"#\s]|$)/i,
  ],
  mastodon: [
    // mastodon.social/@user, fosstodon.org/@user, etc. Also the @user@instance form.
    /(?:https?:)?\/\/(?:www\.)?([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)\/@([A-Za-z0-9_]{1,30})(?=[/?"#\s]|$)/i,
  ],
};

// Hosts that aren't actually Mastodon (the regex above is too generous on
// the @-username pattern alone). Allow-list the well-known instances.
const KNOWN_MASTODON_HOSTS = new Set([
  "mastodon.social",
  "mastodon.online",
  "mas.to",
  "fosstodon.org",
  "hachyderm.io",
  "social.lol",
  "indieweb.social",
  "ravenation.club",
  "techhub.social",
  "infosec.exchange",
]);

function cleanHandle(raw) {
  if (!raw) return null;
  return raw.trim().replace(/[/?#"\s].*$/, "").replace(/^@/, "") || null;
}

/**
 * Run all platform regexes against a string of HTML/text and return the
 * first match per platform. Returns { x, instagram, threads, facebook,
 * bluesky, mastodon } — values are handle strings (no leading @) or null.
 */
export function extractHandlesFromText(text) {
  if (!text || typeof text !== "string") {
    return { x: null, instagram: null, threads: null, facebook: null, bluesky: null, mastodon: null };
  }
  const out = { x: null, instagram: null, threads: null, facebook: null, bluesky: null, mastodon: null };

  for (const [platform, patterns] of Object.entries(HANDLE_PATTERNS)) {
    if (platform === "mastodon") continue; // handled below
    for (const re of patterns) {
      const match = text.match(re);
      if (match) {
        const cleaned = cleanHandle(match[1]);
        if (cleaned) {
          out[platform] = cleaned;
          break;
        }
      }
    }
  }

  // Mastodon: only accept matches on known instance hosts (the regex pattern
  // is too broad on its own — `/@user` appears in many unrelated paths).
  for (const re of HANDLE_PATTERNS.mastodon) {
    const all = text.matchAll(new RegExp(re.source, "gi"));
    for (const m of all) {
      const host = (m[1] || "").toLowerCase();
      const user = cleanHandle(m[2]);
      if (host && user && KNOWN_MASTODON_HOSTS.has(host)) {
        out.mastodon = `${user}@${host}`;
        break;
      }
    }
    if (out.mastodon) break;
  }

  return out;
}

async function fetchHtml(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SouthBayToday/1.0; +https://southbaytoday.org)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 5_000_000) return null; // safety cap
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a URL and extract any social handles from the HTML. Returns null on
 * fetch error so the caller can fall through to other sources.
 */
export async function resolveHandlesFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const html = await fetchHtml(url);
  if (!html) return null;
  const handles = extractHandlesFromText(html);
  // Treat all-null as "found nothing useful" so callers can try the next URL.
  const anyFound = Object.values(handles).some((v) => v);
  return anyFound ? { handles, source: url } : null;
}

/**
 * Try a list of candidate URLs in order; return the FIRST one that yields
 * any handles. Lets callers fall through (event url → venue url → ...).
 */
export async function resolveHandlesFromUrls(urls) {
  const seen = new Set();
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const result = await resolveHandlesFromUrl(url);
    if (result) return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 2: Claude + web search
// ---------------------------------------------------------------------------

function loadEnv() {
  if (process.env.ANTHROPIC_API_KEY) return;
  try {
    const envPath = join(__dirname, "..", "..", "..", ".env.local");
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const RESOLVER_PROMPT = `Find the official social media handles for this entity. Use web search — do NOT rely on memory.

ENTITY: {{NAME}}
KIND: {{KIND}}
{{HINTS}}

Return ONLY a single JSON object on the last line of your response, exactly this shape:
{
  "x": "<twitter/X handle without @, or null>",
  "instagram": "<instagram handle without @, or null>",
  "threads": "<threads handle without @, or null>",
  "bluesky": "<full bsky handle e.g. user.bsky.social, or null>",
  "facebook": "<page name or username, or null>",
  "mastodon": "<user@instance form, or null>",
  "_evidence": "<one URL from search results that mentions at least one of the handles you returned>",
  "_confidence": "<\"high\" | \"medium\" | \"low\">"
}

Strict rules:
- Only return a handle if you found it on a page from the search results. If you cannot verify a handle, return null for that platform.
- Do not invent handles. Do not guess based on the entity name. Memory is not evidence.
- _evidence must be a URL that appeared in your search results AND that contains at least one of the handles you're returning.
- If you cannot verify ANY handle, return all null values, _evidence: null, _confidence: "low".
- "high" confidence means you saw multiple handles on an official-looking source. "low" means you found something but aren't sure it's the right entity.
`;

function buildPrompt(name, kind, hints) {
  const hintLines = [];
  if (hints?.city) hintLines.push(`CITY: ${hints.city}`);
  if (hints?.category) hintLines.push(`CATEGORY: ${hints.category}`);
  if (hints?.venue && hints.venue !== name) hintLines.push(`VENUE: ${hints.venue}`);
  if (hints?.url) hintLines.push(`KNOWN URL: ${hints.url}`);
  hintLines.push("REGION: South Bay (San Jose / Silicon Valley / Santa Clara County, California)");
  return RESOLVER_PROMPT
    .replace("{{NAME}}", name)
    .replace("{{KIND}}", kind || "entity")
    .replace("{{HINTS}}", hintLines.join("\n"));
}

function extractJsonFromText(text) {
  if (!text) return null;
  // Look for the LAST JSON object in the text (Claude may write reasoning first)
  const matches = [...text.matchAll(/\{[\s\S]*?\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i][0]);
      if (parsed && typeof parsed === "object" && "x" in parsed) return parsed;
    } catch {}
  }
  return null;
}

/**
 * Verify Claude's claim by fetching the cited evidence URL and checking
 * that at least one of the returned handles actually appears on the page.
 * Filters hallucinated handles by re-running the regex extractor on the
 * source page and intersecting with what Claude returned.
 */
async function verifyAgainstEvidence(claudeHandles, evidenceUrl) {
  if (!evidenceUrl) return null;
  const html = await fetchHtml(evidenceUrl);
  if (!html) return null;
  const found = extractHandlesFromText(html);
  // For each platform Claude returned, only keep it if the source page has
  // the same handle (case-insensitive). This filters hallucination.
  const verified = { x: null, instagram: null, threads: null, facebook: null, bluesky: null, mastodon: null };
  let anyVerified = false;
  for (const platform of Object.keys(verified)) {
    const claimed = claudeHandles?.[platform];
    if (!claimed) continue;
    const pageHandle = found[platform];
    if (pageHandle && pageHandle.toLowerCase() === String(claimed).toLowerCase()) {
      verified[platform] = claimed;
      anyVerified = true;
    }
  }
  return anyVerified ? verified : null;
}

/**
 * Resolve handles by asking Claude to web-search. Verifies handles against
 * Claude's cited source URL before accepting (filters hallucination).
 * Returns null on failure — caller falls through to gap log.
 *
 * @param {string} name - venue / performer / org name
 * @param {string} kind - "venue" | "performer" | "org"
 * @param {object} [hints] - { city, category, venue, url }
 */
export async function resolveHandlesViaClaude(name, kind, hints = {}) {
  loadEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!name) return null;

  const prompt = buildPrompt(name, kind, hints);

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_RESOLVER_MODEL,
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: CLAUDE_RESOLVER_MAX_USES }],
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let data;
  try { data = await res.json(); } catch { return null; }

  // Claude's response may include tool_use, server_tool_use, web_search_tool_result,
  // and finally a text block with the JSON answer. Concatenate all text blocks.
  const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "");
  const fullText = textBlocks.join("\n");
  const claimed = extractJsonFromText(fullText);
  if (!claimed) return null;
  if (!claimed._evidence) return null;
  if (claimed._confidence === "low") return null; // don't accept low-confidence

  const verified = await verifyAgainstEvidence(claimed, claimed._evidence);
  if (!verified) return null;

  return { handles: verified, source: `claude+web-search via ${claimed._evidence}` };
}
