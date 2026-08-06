// ---------------------------------------------------------------------------
// eventBlurbs — shared ingest-time blurb resolver for events.
//
// Parallel to eventImages.mjs: run once at ingest (generate-events.mjs) so
// every event gets a stable 1-sentence "what to do here today" blurb that
// survives across regens and shuffles. Replaces the per-shuffle Claude
// improvisation that drifted toward "Swing by X and see what's going on".
//
// Flow:
//   Tier 1: Event already has a blurb (cache hit carried in the event obj).
//   Tier 2: Persistent cache hit (event-blurb-cache.json, keyed by a
//           title+venue+description fingerprint — see eventBlurbCacheKey for
//           why the description has to be in there). Free.
//   Tier 3: Sonnet batch generation — 30 events per call, cached across runs.
//           Behind RESOLVE_EVENT_BLURBS=1 env flag so
//           local dev runs don't burn Sonnet credits.
//
// Output field: event.blurb (1 sentence, planner voice — matches the tone
// rules already in plan-day.ts so card-level consumers can use it directly).
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { writeFileAtomic } from "../../../scripts/lib/io.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CACHE_PATH = join(REPO_ROOT, "src", "data", "south-bay", "event-blurb-cache.json");

const MODEL = "claude-sonnet-5";
const BATCH_SIZE = 30;
const MAX_TOKENS = 3000;

// ---------------------------------------------------------------------------
// Persistent cache
// ---------------------------------------------------------------------------

function loadCache() {
  if (!existsSync(CACHE_PATH)) return { byKey: {}, generatedAt: null };
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return { byKey: {}, generatedAt: null };
  }
}

function saveCache(cache) {
  cache.generatedAt = new Date().toISOString();
  writeFileAtomic(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Short content hash of the per-occurrence source text a blurb is derived
 *  from. Empty string when the event carries no description — that's a stable
 *  value, not a hash collision risk, and it keeps description-less events on
 *  one key instead of thrashing. */
function descFingerprint(event) {
  const d = norm(event?.description);
  if (!d) return "";
  return createHash("sha1").update(d).digest("hex").slice(0, 12);
}

/**
 * Cache key for one event's blurb.
 *
 * Title + venue keeps date variants of a recurring event on one entry, AND
 * keeps different events that share a URL apart (all MLS Earthquakes home
 * games shared sjearthquakes.com/schedule, which used to map every game to
 * whichever game's blurb got cached first — every team showed the same
 * opponent).
 *
 * The description fingerprint is the third component because title+venue
 * alone is NOT identity for a recurring series whose particulars change every
 * occurrence. Kepler's Books runs a monthly "Story Is the Thing" with a new
 * author lineup each month; the blurb generated 2026-04-26 named that April's
 * four authors and was then served for every later month, so the August 6
 * issue published four real people as appearing at an event they were not at.
 * A changed description now misses the cache and regenerates.
 *
 * Format: `fp:<title>|<venue>|d:<descFp>`. The `|d:` marker is what
 * distinguishes this from the legacy two-component `fp:<title>|<venue>` key,
 * so parseFpKey can read both without guessing.
 */
export function eventBlurbCacheKey(event) {
  return `fp:${norm(event?.title)}|${norm(event?.venue)}|d:${descFingerprint(event)}`;
}

const cacheKey = eventBlurbCacheKey;

/** The pre-description key an event would have had. Only used to find legacy
 *  entries worth migrating. */
function legacyCacheKey(event) {
  return `fp:${norm(event?.title)}|${norm(event?.venue)}`;
}

/** Reverse of cacheKey() for `fp:` keys — recovers the (normalized) title,
 *  venue and description fingerprint so a cache entry can be given Sonnet
 *  context even when the source event has aged out of upcoming-events.json.
 *  Reads legacy two-component keys too (descFp comes back ""). */
export function parseFpKey(key) {
  if (typeof key !== "string" || !key.startsWith("fp:")) return { title: "", venue: "", descFp: "" };
  let rest = key.slice(3);
  let descFp = "";
  // Split the description component off first — titles may themselves contain
  // "|", which is why venue is recovered with lastIndexOf below.
  const dIdx = rest.lastIndexOf("|d:");
  if (dIdx !== -1) {
    descFp = rest.slice(dIdx + 3);
    rest = rest.slice(0, dIdx);
  }
  const pipe = rest.lastIndexOf("|");
  if (pipe === -1) return { title: rest, venue: "", descFp };
  return { title: rest.slice(0, pipe), venue: rest.slice(pipe + 1), descFp };
}

/** True when two cache keys describe the same title+venue and differ only in
 *  their description fingerprint — i.e. two occurrences of one recurring
 *  series, not two different events. */
export function isSameSeriesKey(a, b) {
  if (a === b) return false;
  const x = parseFpKey(a), y = parseFpKey(b);
  if (!x.title || !y.title) return false;
  return x.title === y.title && x.venue === y.venue;
}

/**
 * Migrate legacy `fp:<title>|<venue>` entries written before the description
 * fingerprint joined the key.
 *
 * A legacy entry records no description, so there is no way to tell whether
 * its blurb still matches the event's current particulars. Adopting it under
 * the new key would preserve exactly the bug this change exists to fix, so:
 *
 *   • event currently has NO description → nothing per-occurrence could have
 *     drifted, so move the blurb onto the new key and keep the work.
 *   • event HAS a description → drop the entry and let it regenerate against
 *     the text that's actually true today.
 *
 * Legacy keys with no matching current event are left alone. Pruning them off
 * the live event list would delete blurbs for anything outside this run's
 * window — the partial-regen data-loss shape.
 */
export function migrateLegacyFingerprintKeys(cache, events) {
  let migrated = 0, dropped = 0;
  for (const e of events || []) {
    const oldKey = legacyCacheKey(e);
    const entry = cache?.byKey?.[oldKey];
    if (!entry) continue;
    if (!descFingerprint(e)) {
      const newKey = cacheKey(e);
      if (!cache.byKey[newKey]) cache.byKey[newKey] = entry;
      migrated++;
    } else {
      dropped++;
    }
    delete cache.byKey[oldKey];
  }
  if (migrated || dropped) {
    console.log(`[eventBlurbs] description-key migration: ${migrated} carried forward, ${dropped} dropped for regeneration`);
  }
  return { migrated, dropped };
}

function dayOfWeek(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { weekday: "long" });
}

/** Migrate legacy `url:<URL>` cache entries.
 *  Where exactly one current event uses a given URL, copy its blurb to the
 *  new fingerprint key — preserves work. Where multiple events share the
 *  URL, drop the cached blurb (it was wrong for all but one of them). */
function migrateUrlKeys(cache, currentEvents) {
  const eventsByUrl = new Map();
  for (const e of currentEvents) {
    if (!e.url) continue;
    if (!eventsByUrl.has(e.url)) eventsByUrl.set(e.url, []);
    eventsByUrl.get(e.url).push(e);
  }
  let migrated = 0, dropped = 0;
  for (const oldKey of Object.keys(cache.byKey)) {
    if (!oldKey.startsWith("url:")) continue;
    const url = oldKey.slice(4);
    const matches = eventsByUrl.get(url) || [];
    if (matches.length === 1) {
      const newKey = cacheKey(matches[0]);
      if (!cache.byKey[newKey]) cache.byKey[newKey] = cache.byKey[oldKey];
      delete cache.byKey[oldKey];
      migrated++;
    } else {
      delete cache.byKey[oldKey];
      dropped++;
    }
  }
  if (migrated || dropped) {
    console.log(`[eventBlurbs] cache migration: ${migrated} migrated, ${dropped} dropped (URL collisions)`);
  }
}

// ---------------------------------------------------------------------------
// Sonnet batch generation
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You write one-sentence blurbs for local events in a South Bay day-planner app (South Bay Today).

Each blurb describes what someone would actually DO at the event — catch the talk, browse the exhibit, watch the match, taste the samples, meet the author. Plural "you" voice, like a friend texting a plan.

Strict rules:
- Exactly one sentence, 10–20 words.
- Describe what happens THERE (specific action, not generic "swing by").
- Lead with a concrete action verb (See, Hear, Tour, Walk, Make, Watch, Taste, Learn). Avoid the vague openers "explore" and "discover" — name what visitors actually do.
- If a description is given, rewrite its substance in planner voice — don't copy marketing prose.
- NEVER say: "real event", "only today", "one-time", "unforgettable", "anchor event", "right now".
- NEVER use AI-marketing tone words: "legendary", "iconic", "magical", "whimsical", "cozy", "laid-back", "charming", "delightful", "must-see", "world-class", "hidden gem", "nestled", "tucked away", "quaint", "powerhouse", "vibrant", "bustling", "immersive", "tapestry", "delve". State what the act/event is concretely instead (e.g. "Grammy-winning vocalist", "six-piece Hawaiian reggae band").
- NEVER mention distance, travel time, "near", "nearby", "close to", "minutes from".
- NEVER mention star ratings or review scores.
- NEVER include a specific date or month — the card displays those separately. No "June 14th", "May 21", "Saturday, June 14", "two May sessions", "today", "tomorrow", "tonight", etc. Recurring weekly patterns are fine ("Friday mornings", "every Tuesday"); specific calendar dates are not.
- Do not hedge ("might", "perhaps"). Recommend confidently.
- Do not use em dashes in every sentence — vary sentence structure.
- No hype. No exclamation points.`;

// Date/day/month references that the card already shows separately. Narrow
// patterns only — recurring-event copy like "Friday mornings" or "this
// month's book pick" is informative for repeats, and band/event proper
// nouns ("Taking Back Sunday", "Start Today") shouldn't trip the filter.
// We additionally suppress matches whose text appears in the event's title
// or venue (band-name and event-name leaks).
const BLURB_LEAK_PATTERNS = [
  // Relative-day anchors — almost always wrong on a future-dated event.
  /\b(today|tomorrow|yesterday|tonight)\b/i,
  // Month + day-number: "Saturday, June 14th".
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?\b/i,
  // Day-of-week + month: "Saturday, June 14th" caught by both rules — belt
  // and suspenders for cases where the year inserts itself between them.
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i,
  // "across two May sessions" / "in May sessions" — month name as a temporal
  // adjective for sessions/programs. "May" alone is ambiguous (modal verb),
  // so require the program-noun context.
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:session|sessions|class|classes|workshop|workshops|meeting|meetings|event|events)\b/i,
];

function blurbLeaksDateContext(blurb, event) {
  if (!blurb) return false;
  // Suppress hits that appear in the event's title or venue — band names
  // ("Start Today"), event names ("Museums on Us Weekend"), etc.
  const ctx = `${event?.title || ""} ${event?.venue || ""}`.toLowerCase();
  for (const re of BLURB_LEAK_PATTERNS) {
    const m = blurb.match(re);
    if (!m) continue;
    if (ctx.includes(m[0].toLowerCase())) continue;
    return true;
  }
  return false;
}

// Guards the uniqueness-retry path specifically: given only a title/venue
// (no description, sometimes no venue at all), Sonnet will sometimes refuse
// or ask a clarifying question instead of producing a blurb. Those refusals
// pass the date-leak filter fine (they're not lying about dates) so they
// need their own check before landing in the cache.
function isPlausibleBlurb(text) {
  if (!text) return false;
  if (text.includes("\n")) return false;
  if (text.length > 220) return false;
  if (/\?\s*$/.test(text)) return false;
  const lower = text.toLowerCase();
  const refusalPhrases = [
    "i don't have", "i do not have", "i can't", "i cannot",
    "could you", "please provide", "as an ai", "i'm not able", "i am not able",
  ];
  return !refusalPhrases.some((p) => lower.includes(p));
}

function buildUserPrompt(events) {
  const lines = events.map((e, i) => {
    const parts = [`${i + 1}. ${e.title || "Untitled"}`];
    if (e.category) parts.push(`cat: ${e.category}`);
    if (e.venue) parts.push(`venue: ${e.venue}`);
    if (e.city) parts.push(`city: ${e.city}`);
    if (e.ongoing) parts.push(`ongoing-exhibit`);
    if (e.description) {
      const d = String(e.description).replace(/\s+/g, " ").trim().slice(0, 280);
      if (d) parts.push(`desc: ${d}`);
    }
    return parts.join(" | ");
  });

  // Indexed objects so we can match blurbs to events even if the model returns
  // them out of order or drops one — we previously trusted positional order
  // and ended up with cross-event blurb swaps (a flower-drawing class got the
  // chronic-pain blurb, etc.).
  return `Write one blurb per event. Return a JSON array where each object has the event's index ("i") and its "blurb". No markdown fences, no commentary.

Events:
${lines.join("\n")}

Output format (one object per event, index matches the number above):
[{"i": 1, "blurb": "..."}, {"i": 2, "blurb": "..."}]`;
}

/** Parse a blurb response. Returns an array of length `expectedLen` where
 *  index k holds the blurb for event k (or null if missing/invalid). Robust
 *  to out-of-order arrays and missing entries. */
function parseBlurbArray(raw, expectedLen) {
  let cleaned = String(raw || "").trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  let arr;
  try { arr = JSON.parse(cleaned); } catch { return null; }
  if (!Array.isArray(arr)) return null;

  const out = new Array(expectedLen).fill(null);

  // New shape: array of {i, blurb} objects
  if (arr.length > 0 && typeof arr[0] === "object" && arr[0] !== null && "blurb" in arr[0]) {
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const idx = Number(item.i);
      if (!Number.isInteger(idx) || idx < 1 || idx > expectedLen) continue;
      const b = typeof item.blurb === "string" ? item.blurb.trim() : null;
      if (b) out[idx - 1] = b;
    }
    const got = out.filter(Boolean).length;
    if (got !== expectedLen) {
      console.warn(`[eventBlurbs] batch returned ${got}/${expectedLen} indexed blurbs`);
    }
    return out;
  }

  // Legacy shape: array of strings — fall back to positional assignment.
  for (let i = 0; i < expectedLen; i++) {
    const v = arr[i];
    if (typeof v === "string" && v.trim()) out[i] = v.trim();
  }
  if (arr.length !== expectedLen) {
    console.warn(`[eventBlurbs] batch length mismatch: expected ${expectedLen}, got ${arr.length}`);
  }
  return out;
}

function buildUniqueUserPrompt(event, conflictBlurbs) {
  const parts = [`Event: ${event.title || "Untitled"}`];
  if (event.category) parts.push(`cat: ${event.category}`);
  if (event.venue) parts.push(`venue: ${event.venue}`);
  if (event.city) parts.push(`city: ${event.city}`);
  const dow = dayOfWeek(event.date);
  if (dow) parts.push(`day: ${dow}`);
  if (event.ongoing) parts.push(`ongoing-exhibit`);
  if (event.description) {
    const d = String(event.description).replace(/\s+/g, " ").trim().slice(0, 280);
    if (d) parts.push(`desc: ${d}`);
  }
  const line = parts.join(" | ");
  const conflictList = conflictBlurbs.map((b) => `- "${b}"`).join("\n");

  return `Write one blurb for this event.

${line}

This event is one of several similar listings (e.g. a recurring series across different venues) that already share this blurb, which is now too generic and interchangeable:
${conflictList}

Write a NEW blurb for THIS event that reads as clearly distinct from the ones above — name its specific venue, neighborhood, city, or the day of the week it runs, using only the facts given above. Do not invent vendors, features, or details that aren't present in the data. If nothing else distinguishes it, lead with the venue or city name.

Output just the one-sentence blurb — no markdown, no quotes, no commentary.`;
}

export function extractAnthropicText(response) {
  return response?.content?.find(
    (block) => block?.type === "text" && typeof block.text === "string",
  )?.text ?? "";
}

async function sonnetUniqueBlurb(client, event, conflictBlurbs) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    output_config: { effort: "low" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUniqueUserPrompt(event, conflictBlurbs) }],
  });
  const text = extractAnthropicText(response);
  return text.trim().replace(/^["']|["']$/g, "");
}

async function sonnetBatch(client, events) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: "low" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(events) }],
  });
  const text = extractAnthropicText(response);
  const parsed = parseBlurbArray(text, events.length);
  if (!parsed) {
    console.warn(`[eventBlurbs] parse fail (batch of ${events.length}). raw: ${text.slice(0, 200)}`);
    return new Array(events.length).fill(null);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Public API: resolveEventBlurbs
// ---------------------------------------------------------------------------

/**
 * Resolve blurbs for a batch of events in place. Each event that lands a
 * blurb gets `event.blurb` set.
 *
 * Options:
 *   - enabled:   override the env flag (default: RESOLVE_EVENT_BLURBS === "1")
 *   - batchSize: events per Sonnet call (default 30)
 *   - dryRun:    don't mutate events or write cache; return stats only.
 */
export async function resolveEventBlurbs(events, opts = {}) {
  const enabled = opts.enabled ?? (process.env.RESOLVE_EVENT_BLURBS === "1");
  const dryRun = !!opts.dryRun;
  const batchSize = opts.batchSize ?? BATCH_SIZE;

  const stats = {
    total: events.length,
    preexisting: 0,
    cache_hits: 0,
    generated: 0,
    deduped: 0,
    failed: 0,
    skipped: 0,
  };

  const cache = loadCache();
  migrateUrlKeys(cache, events);
  migrateLegacyFingerprintKeys(cache, events);

  // Sweep stale entries whose blurb leaks date/day/month context. The card
  // shows the date separately, so these are always wrong — drop and let the
  // regen below produce a clean replacement. Cache keys are
  // `fp:<title>|<venue>`, so we reconstruct just enough event context for
  // the proper-noun suppression (band names, event names).
  let leakDropped = 0;
  for (const k of Object.keys(cache.byKey)) {
    const blurb = cache.byKey[k]?.blurb;
    if (!blurb) continue;
    const { title, venue } = parseFpKey(k);
    if (blurbLeaksDateContext(blurb, { title, venue })) {
      delete cache.byKey[k];
      leakDropped++;
    }
  }
  if (leakDropped) console.log(`[eventBlurbs] swept ${leakDropped} date-leak blurb(s) from cache`);

  // Track every blurb currently in the cache so newly-generated blurbs can
  // be checked against OTHER events' blurbs, not just their own. Sonnet tends
  // to produce identical boilerplate for near-identical listings (e.g. every
  // farmers market got "Shop for local produce, artisan goods, and
  // ready-to-eat food weekly.") — this catches that at generation time
  // instead of letting it ship.
  const usedBlurbs = new Map(); // norm(blurb) -> owning cache key
  for (const [k, entry] of Object.entries(cache.byKey)) {
    if (entry?.blurb) usedBlurbs.set(norm(entry.blurb), k);
  }

  // --- Pass 1: apply preexisting + cache hits ------------------------------
  const todo = [];
  for (const e of events) {
    if (e.blurb && String(e.blurb).trim()) {
      stats.preexisting++;
      continue;
    }
    const key = cacheKey(e);
    const hit = cache.byKey[key];
    if (hit?.blurb) {
      if (!dryRun) e.blurb = hit.blurb;
      stats.cache_hits++;
      continue;
    }
    todo.push({ event: e, key });
  }

  if (todo.length === 0) return stats;

  // --- Pass 2: generate (gated by env flag + API key) ----------------------
  if (!enabled) {
    stats.skipped = todo.length;
    return stats;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[eventBlurbs] ANTHROPIC_API_KEY not set — skipping generation");
    stats.skipped = todo.length;
    return stats;
  }
  const client = new Anthropic({ apiKey });

  for (let start = 0; start < todo.length; start += batchSize) {
    const batch = todo.slice(start, start + batchSize);
    if (dryRun) { stats.skipped += batch.length; continue; }
    try {
      const blurbs = await sonnetBatch(client, batch.map((b) => b.event));
      for (let i = 0; i < batch.length; i++) {
        let blurb = blurbs[i];
        if (!blurb || blurb.length === 0) {
          stats.failed++;
          continue;
        }
        if (blurbLeaksDateContext(blurb, batch[i].event)) {
          console.warn(`[eventBlurbs] dropped (date leak): "${blurb}" for ${batch[i].event.title}`);
          stats.failed++;
          continue;
        }

        // Cross-event duplicate check: if this exact blurb is already used
        // by a DIFFERENT event/venue, ask Sonnet to make it distinct instead
        // of shipping the same boilerplate twice.
        const key = batch[i].key;
        let owner = usedBlurbs.get(norm(blurb));
        // A prior occurrence of the SAME series (same title+venue, older
        // description fingerprint) is not a boilerplate collision — it's last
        // month's entry for this very event, which the description component
        // now keys separately. Forcing a contrived difference against it would
        // burn a retry to make two blurbs for one activity read as unrelated.
        if (owner && isSameSeriesKey(owner, key)) owner = null;
        if (owner && owner !== key) {
          const conflictBlurbs = [blurb];
          let deduped = false;
          for (let attempt = 0; attempt < 2 && !deduped; attempt++) {
            let candidate;
            try {
              candidate = await sonnetUniqueBlurb(client, batch[i].event, conflictBlurbs);
            } catch (err) {
              console.warn(`[eventBlurbs] dedup retry failed for ${batch[i].event.title}: ${err.message}`);
              break;
            }
            if (!candidate || !isPlausibleBlurb(candidate) || blurbLeaksDateContext(candidate, batch[i].event)) {
              if (candidate) conflictBlurbs.push(candidate);
              continue;
            }
            const candidateOwner = usedBlurbs.get(norm(candidate));
            if (candidateOwner && candidateOwner !== key) {
              conflictBlurbs.push(candidate);
              continue;
            }
            blurb = candidate;
            deduped = true;
          }
          if (deduped) {
            stats.deduped++;
          } else {
            console.warn(`[eventBlurbs] could not de-duplicate blurb for "${batch[i].event.title}" (${batch[i].event.venue}) — shares blurb with ${owner}`);
          }
        }

        batch[i].event.blurb = blurb;
        cache.byKey[key] = { blurb, generatedAt: new Date().toISOString() };
        usedBlurbs.set(norm(blurb), key);
        stats.generated++;
      }
      // Periodic save so a crash mid-run doesn't cost everything.
      if ((start / batchSize) % 5 === 4) saveCache(cache);
    } catch (err) {
      console.warn(`[eventBlurbs] batch failed (${start}-${start + batch.length}): ${err.message}`);
      stats.failed += batch.length;
    }
  }

  if (!dryRun) saveCache(cache);
  return stats;
}

// ---------------------------------------------------------------------------
// Public API: regenerateDuplicateCacheEntries — one-time (or periodic) sweep
// ---------------------------------------------------------------------------

/**
 * Find blurbs in the persistent cache that are identical across events at
 * DIFFERENT venues (boilerplate collisions like every farmers market getting
 * "Shop for local produce, artisan goods, and ready-to-eat food weekly.")
 * and regenerate each affected entry with a uniqueness nudge.
 *
 * Same-venue clusters (a recurring instance of ONE event — monthly museum
 * tours, training-camp dates, multiple performances of one show) are left
 * alone on purpose: that's the same real-world activity repeated, not a
 * templated-boilerplate bug.
 *
 * `events` supplies live context (description/city/date) for entries whose
 * event still exists in the current data; entries for expired events fall
 * back to the title/venue recovered from the cache key itself.
 *
 * Options:
 *   - dryRun: don't call Sonnet or write the cache; return the cluster list only.
 */
export async function regenerateDuplicateCacheEntries(events, opts = {}) {
  const dryRun = !!opts.dryRun;

  const cache = loadCache();
  const eventsByKey = new Map();
  for (const e of events) {
    const key = cacheKey(e);
    if (!eventsByKey.has(key)) eventsByKey.set(key, e);
  }

  const byBlurb = new Map();
  for (const [key, entry] of Object.entries(cache.byKey)) {
    const blurb = entry?.blurb;
    if (!blurb) continue;
    if (!byBlurb.has(blurb)) byBlurb.set(blurb, []);
    byBlurb.get(blurb).push(key);
  }

  const clusters = [];
  for (const [blurb, keys] of byBlurb) {
    if (keys.length < 2) continue;
    const venues = new Set(keys.map((k) => parseFpKey(k).venue));
    if (venues.size > 1) clusters.push({ blurb, keys });
  }

  const report = [];
  if (dryRun) {
    for (const { blurb, keys } of clusters) {
      for (const key of keys) report.push({ key, before: blurb, after: blurb, changed: false });
    }
    return report;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("[eventBlurbs] ANTHROPIC_API_KEY not set — cannot regenerate");
  const client = new Anthropic({ apiKey });

  const usedBlurbs = new Map();
  for (const [k, entry] of Object.entries(cache.byKey)) {
    if (entry?.blurb) usedBlurbs.set(norm(entry.blurb), k);
  }

  for (const { blurb, keys } of clusters) {
    for (const key of keys) {
      const parsed = parseFpKey(key);
      const event = eventsByKey.get(key) || { title: parsed.title, venue: parsed.venue };

      const conflictBlurbs = [blurb];
      let finalBlurb = null;
      for (let attempt = 0; attempt < 2 && !finalBlurb; attempt++) {
        let candidate;
        try {
          candidate = await sonnetUniqueBlurb(client, event, conflictBlurbs);
        } catch (err) {
          console.warn(`[eventBlurbs] dedup regen failed for ${key}: ${err.message}`);
          break;
        }
        if (!candidate || !isPlausibleBlurb(candidate) || blurbLeaksDateContext(candidate, event)) {
          if (candidate) conflictBlurbs.push(candidate);
          continue;
        }
        const owner = usedBlurbs.get(norm(candidate));
        if (owner && owner !== key) {
          conflictBlurbs.push(candidate);
          continue;
        }
        finalBlurb = candidate;
      }

      if (!finalBlurb) {
        console.warn(`[eventBlurbs] could not de-duplicate "${key}" — leaving as-is`);
        report.push({ key, before: blurb, after: blurb, changed: false });
        continue;
      }

      report.push({ key, before: blurb, after: finalBlurb, changed: true });
      cache.byKey[key] = { blurb: finalBlurb, generatedAt: new Date().toISOString() };
      usedBlurbs.set(norm(finalBlurb), key);
    }
  }

  saveCache(cache);
  return report;
}
