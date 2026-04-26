// ---------------------------------------------------------------------------
// South Bay Today — Social Handle Lookup + Tagging
// Matches event items to known social handles for @mentioning.
//
// Strategy: soft-prompt the LLM with mention instructions, then run a
// deterministic post-processing pass (applyTagSubstitutions) that swaps
// venue/org names for @handles per-platform. This guarantees tagging
// happens even when the LLM ignores the prompt — and lets us be more
// surgical about format ("@handle" in place vs "Name (@handle)" parenthetical).
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANDLES_FILE = join(__dirname, "..", "..", "..", "src", "data", "south-bay", "social-handles.json");
const GAPS_FILE = join(__dirname, "..", "..", "..", "src", "data", "south-bay", "social-handles-gaps.json");

let _cache = null;

function loadHandles() {
  if (_cache) return _cache;
  try {
    const raw = JSON.parse(readFileSync(HANDLES_FILE, "utf8"));
    // Build a flat lookup: normalized key → { handles, displayName }
    const lookup = new Map();
    for (const section of ["venues", "orgs"]) {
      if (!raw[section]) continue;
      for (const [name, handles] of Object.entries(raw[section])) {
        lookup.set(normalizeText(name), { handles, displayName: name });
      }
    }
    _cache = lookup;
    return lookup;
  } catch {
    return new Map();
  }
}

/**
 * Normalize a name for matching: lowercase, strip accents, drop apostrophes
 * and other punctuation, collapse whitespace. Used on both DB keys and
 * user-supplied names so "Kepler's Books" matches DB key "keplers books"
 * and "San José Museum of Art" matches "san jose museum of art".
 */
function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritics
    .replace(/['’‘]/g, "") // straight + curly apostrophes
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Match a string against known venue/org names. Returns the LONGEST DB key
 * that overlaps (so "san jose jazz" beats "san jose" if both exist).
 */
function findMatch(text) {
  if (!text) return null;
  const norm = normalizeText(text);
  if (!norm) return null;

  const lookup = loadHandles();

  if (lookup.has(norm)) {
    return { ...lookup.get(norm), key: norm };
  }

  let best = null;
  for (const [key, entry] of lookup) {
    if (norm.includes(key) || key.includes(norm)) {
      if (!best || key.length > best.key.length) {
        best = { ...entry, key };
      }
    }
  }
  return best;
}

/**
 * Look up social handles for an event item.
 * Checks venue name and title against the handle database.
 */
export function lookupHandles(item) {
  const venueMatch = findMatch(item.venue);
  if (venueMatch) {
    return { handles: venueMatch.handles, matchedName: item.venue, displayName: venueMatch.displayName };
  }
  const titleMatch = findMatch(item.title);
  if (titleMatch) {
    return { handles: titleMatch.handles, matchedName: item.title, displayName: titleMatch.displayName };
  }
  return { handles: null, matchedName: null, displayName: null };
}

/**
 * Format an @mention for a specific platform. Bluesky handles are stored
 * in full *.bsky.social form; Mastodon handles in user@instance form.
 * Both already include their qualifier — we just prepend "@".
 */
export function formatMention(handle, platform) {
  if (!handle) return null;
  return `@${handle}`;
}

export function mentionFor(handles, platform) {
  if (!handles || !handles[platform]) return null;
  return formatMention(handles[platform], platform);
}

// ---------------------------------------------------------------------------
// Deterministic tag substitution
// ---------------------------------------------------------------------------

/**
 * Decide whether a handle is "obvious enough" to substitute in place of the
 * displayed name, vs needing a parenthetical "Name (@handle)" so readers
 * can still tell what's being referenced.
 *
 * Obvious: handle is the name (case/space/apostrophe collapsed) OR the name
 *   contains the handle as a substring (truncation).
 *   — "@sapcenter" for "SAP Center" → name fully contains handle → obvious
 *   — "@sanjoseimprov" for "San Jose Improv" → equal → obvious
 *   — "@shorelineamph" for "Shoreline Amphitheatre" → name contains handle → obvious
 *
 * Non-obvious (parenthetical):
 *   — "@sjmusart" for "San Jose Museum of Art" → no overlap → "San Jose Museum of Art (@sjmusart)"
 *   — "@SPSMarket" for "San Pedro Square Market" → no overlap → parenthetical
 */
function isHandleObvious(handle, displayedName) {
  if (!handle || !displayedName) return false;
  // Strip platform-specific suffixes before comparing — readers tune out
  // ".bsky.social" and "@mastodon.social" boilerplate, so the check should
  // focus on the user-portion of the handle.
  const nh = String(handle)
    .toLowerCase()
    .replace(/\.bsky\.social$/, "")
    .replace(/@.+$/, "")
    .replace(/[^a-z0-9]/g, "");
  const nn = normalizeText(displayedName).replace(/[^a-z0-9]/g, "");
  if (!nh || !nn) return false;
  if (nh === nn) return true;
  return nn.includes(nh);
}

/**
 * Build a regex that matches a name in LLM output, tolerant of:
 *  — case
 *  — optional apostrophes ("Keplers" or "Kepler's")
 *  — accent variations ("San Jose" or "San José")
 *  — multi-space variation
 *
 * Anchored by \b on either side so partial-word matches don't fire.
 */
function nameToRegex(name) {
  if (!name) return null;
  const VOWEL_VARIANTS = {
    a: "[aáàâäãå]", e: "[eéèêë]", i: "[iíìîï]", o: "[oóòôöõ]", u: "[uúùûü]", n: "[nñ]", c: "[cç]",
  };
  const escaped = String(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/['’‘]/g, "['’‘]?")
    .replace(/[a-z]/gi, (ch) => VOWEL_VARIANTS[ch.toLowerCase()] || ch)
    .replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

function collectTargets(item) {
  const targets = [];
  const seen = new Set();
  const tryAdd = (name) => {
    if (!name) return;
    const m = findMatch(name);
    if (!m) return;
    const key = m.key;
    if (seen.has(key)) return;
    seen.add(key);
    // Try the original input first (preserves apostrophes/accents the LLM
    // is likely to copy verbatim), then the DB key as a fallback for cases
    // where the LLM paraphrases ("San Jose Sharks face Kraken" instead of
    // "San Jose Sharks vs Kraken").
    const candidates = [];
    if (name) candidates.push(name);
    if (m.displayName && m.displayName !== name) candidates.push(m.displayName);
    targets.push({ candidates, handles: m.handles });
  };
  tryAdd(item?.venue);
  tryAdd(item?.title);
  tryAdd(item?.name);
  if (Array.isArray(item?.cards)) {
    for (const card of item.cards) {
      tryAdd(card?.name);
      tryAdd(card?.venue);
    }
  }
  return targets;
}

/**
 * Mutate a variants object so each platform's text has venue/org names
 * replaced with @handles where available. Idempotent (skips when the
 * mention already appears in the text).
 *
 * Pass items as:
 *   - tonight-pick / single: { venue, title, ... }
 *   - day-plan: { cards: [...] }  (or the full plan object)
 */
export function applyTagSubstitutions(variants, item) {
  if (!variants || !item) return variants;
  const targets = collectTargets(item);
  if (targets.length === 0) return variants;

  const platforms = ["x", "threads", "bluesky", "facebook", "instagram", "mastodon"];
  for (const platform of platforms) {
    if (!variants[platform]) continue;
    let text = variants[platform];
    for (const t of targets) {
      const handle = t.handles?.[platform];
      if (!handle) continue;
      const mention = formatMention(handle, platform);
      if (!mention) continue;
      if (text.includes(mention)) continue; // already tagged

      // Try each candidate name (DB displayName, then original input).
      // First match wins.
      for (const candidate of t.candidates) {
        const regex = nameToRegex(candidate);
        if (!regex) continue;
        const match = text.match(regex);
        if (!match) continue;
        const matched = match[0];
        const replacement = isHandleObvious(handle, matched)
          ? mention
          : `${matched} (${mention})`;
        text = text.replace(regex, replacement);
        break;
      }
    }
    variants[platform] = text;
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Gap tracking — log venues/orgs we tried to tag but couldn't, so the
// coverage gap becomes visible and ranked. Resolution stays manual: once a
// handle gets added to social-handles.json, it stops appearing here.
// ---------------------------------------------------------------------------

function readGaps() {
  if (!existsSync(GAPS_FILE)) {
    return {
      _meta: {
        description: "Venues/orgs we tried to tag but couldn't find in social-handles.json. Auto-populated at gen time. Resolve by adding entries to social-handles.json (this file's entries are then dropped on next run).",
      },
      gaps: {},
    };
  }
  try {
    const data = JSON.parse(readFileSync(GAPS_FILE, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`gaps file parsed to ${typeof data}`);
    }
    if (!data.gaps || typeof data.gaps !== "object") data.gaps = {};
    return data;
  } catch (err) {
    // Fail loud — silently overwriting could erase a manually-curated backlog.
    throw new Error(`social-handles-gaps.json failed to parse — refusing to clobber: ${err.message}`);
  }
}

function writeGaps(data) {
  const tmp = GAPS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, GAPS_FILE);
}

/**
 * Increment the gap counter for a single name. Skips names that are already
 * in social-handles.json (no point logging resolved coverage). Also drops
 * entries from the gaps file when they resolve, so the file naturally
 * shrinks as Stephen fills in handles.
 */
function logHandleGap(rawName, context = {}) {
  if (!rawName) return;
  const name = String(rawName).trim();
  if (name.length < 3) return;
  const norm = normalizeText(name);
  if (!norm) return;
  if (loadHandles().has(norm)) return; // already resolved

  const data = readGaps();
  const today = new Date().toISOString().slice(0, 10);
  const entry = data.gaps[norm] || {
    displayName: name,
    firstSeen: today,
    occurrences: 0,
    contexts: [],
  };
  entry.lastSeen = today;
  entry.occurrences += 1;
  // Track unique context tuples so we can see which slots/cities the gap
  // shows up in (informs which platform handles matter most).
  const ctx = {};
  for (const k of ["slot", "city", "category", "kind"]) {
    if (context[k]) ctx[k] = context[k];
  }
  if (Object.keys(ctx).length > 0) {
    const key = JSON.stringify(ctx);
    if (!entry.contexts.some((c) => JSON.stringify(c) === key)) {
      entry.contexts.push(ctx);
    }
  }
  data.gaps[norm] = entry;
  data._meta = { ...(data._meta || {}), lastUpdated: today };

  // Sweep already-resolved entries (in case social-handles.json grew since
  // last gen — keeps the gaps file from accumulating stale rows).
  const handles = loadHandles();
  for (const k of Object.keys(data.gaps)) {
    if (handles.has(k)) delete data.gaps[k];
  }

  writeGaps(data);
}

/**
 * Walk an item's name fields (venue, title, card names) and log any that
 * don't match social-handles.json. Call this from copy-gen alongside
 * applyTagSubstitutions — together they capture both successes and gaps.
 */
export function recordUntaggedItem(item, context = {}) {
  if (!item) return;
  const seen = new Set();
  const tryLog = (name, extra = {}) => {
    if (!name) return;
    const key = String(name).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (findMatch(name)) return; // already in DB
    logHandleGap(name, { ...context, ...extra });
  };
  tryLog(item.venue, { kind: "venue" });
  tryLog(item.title, { kind: "title" });
  if (Array.isArray(item.cards)) {
    for (const card of item.cards) {
      tryLog(card?.name, {
        kind: "card",
        category: card?.category,
        city: card?.city,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Soft prompt (still useful — gives the LLM a head-start; the post-processing
// pass is the safety net)
// ---------------------------------------------------------------------------

export function mentionInstructions(item) {
  const { handles } = lookupHandles(item);
  if (!handles) return "";

  const platformMentions = [];
  for (const p of ["x", "threads", "bluesky", "instagram", "facebook"]) {
    const mention = mentionFor(handles, p);
    if (mention) platformMentions.push({ platform: p, mention });
  }
  if (platformMentions.length === 0) return "";

  const byMention = new Map();
  for (const { platform, mention } of platformMentions) {
    if (!byMention.has(mention)) byMention.set(mention, []);
    byMention.get(mention).push(platform);
  }
  const lines = [];
  for (const [mention, platforms] of byMention) {
    lines.push(`- ${mention} on ${platforms.join(", ")}`);
  }
  return `\nTAGGING — replace the venue/org name with the handle below where it fits naturally. Prefer in-place substitution over parenthetical:\n${lines.join("\n")}\nUse the right handle for each platform; on platforms where no handle is listed, use the bare name. (A post-processing pass will also enforce this — your job is to leave the name in a recognizable form so substitution can find it.)`;
}
