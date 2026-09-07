#!/usr/bin/env node
/**
 * generate-reddit-pulse.mjs
 *
 * Pulls top + recent posts from South Bay-relevant subreddits, classifies them
 * via Sonnet, extracts named places/events from titles + bodies, and writes:
 *
 *   reddit-pulse.json — curated "What the South Bay is Saying" feed for the homepage
 *   reddit-gaps.json  — places/events mentioned on Reddit that we don't have
 *
 * Also auto-appends high-confidence coming-soon restaurant signals to scc-food-openings.json.
 *
 * Source: Reddit's public RSS feeds (reddit.com/r/<sub>/{top,new}/.rss). The
 * unauthenticated *.json API now 403s and new API apps are gated to moderation
 * use cases (Responsible Builder Policy, 2026-05), but RSS stays open. Trade-off:
 * RSS carries no score and no comment trees, so ranking is recency-based and
 * entity extraction works off post titles + bodies only.
 * Polite: identified user-agent, 2s between requests, read-only.
 *
 * Run: node --env-file=.env.local scripts/generate-reddit-pulse.mjs
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { loadEnvLocal } from "./lib/env.mjs";
import { DATA_DIR, ARTIFACTS, generatorMeta } from "./lib/paths.mjs";
import { generateAndUploadResized } from "./social/lib/recraft.mjs";
import { writeFileAtomic } from "./lib/io.mjs";
import { callClaude as callClaudeApi } from "./lib/claude.mjs";
import { summaryEchoesTitle } from "./lib/reddit-summary-echo.mjs";

loadEnvLocal();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const USER_AGENT = "southbaytoday-pulse/1.0 (by /u/southbaytoday; https://southbaytoday.org)";
const REQUEST_DELAY_MS = 2000;

const PULSE_OUT = join(DATA_DIR, "reddit-pulse.json");
const GAPS_OUT  = join(DATA_DIR, "reddit-gaps.json");
const IMAGE_CACHE_PATH = join(DATA_DIR, "reddit-image-cache.json");

// Posts we extract named entities from (title + body). Tunable.
const MAX_COMMENT_FETCHES = 14;

// Map free-text city strings (Sonnet output) → canonical South Bay cityId.
// Cities NOT in this map are out-of-scope (e.g., Daly City, Oakland, SF) and
// must be skipped — Reddit threads on r/bayarea regularly mention them.
const CITY_ID_MAP = {
  "san jose":      "san-jose",
  "mountain view": "mountain-view",
  "sunnyvale":     "sunnyvale",
  "santa clara":   "santa-clara",
  "cupertino":     "cupertino",
  "milpitas":      "milpitas",
  "campbell":      "campbell",
  "saratoga":      "saratoga",
  "los gatos":     "los-gatos",
  "los altos":     "los-altos",
  "los altos hills": "los-altos",
  "palo alto":     "palo-alto",
};
function resolveCity(raw) {
  const key = (raw || "").trim().toLowerCase();
  if (!key) return null;
  const cityId = CITY_ID_MAP[key];
  if (!cityId) return null;
  return { cityId, cityName: key.toUpperCase() };
}

// Deterministic out-of-area filter — runs BEFORE Sonnet classification so we
// never spend tokens (or risk a misclassification) on SF/East Bay posts that
// the curator obviously doesn't want in the feed. Sonnet's `out_of_area`
// category stays as a backstop for posts these patterns miss.
const SOUTH_BAY_HINT_REGEX = /\b(san jose|sj |sjc|sunnyvale|palo alto|mountain view|mtn view|santa clara|cupertino|los gatos|saratoga|campbell|milpitas|los altos|stanford|silicon valley|south bay|willow glen|almaden|cambrian|berryessa|santana row|valley fair)\b/i;
const SF_MARKER_REGEX = /(\bin sf\b|\bin san francisco\b|\bsf'?s\b|\bsfo\b|\bin the city\b|\bfrom sf\b|\bto sf\b)/i;
// SF venues/neighborhoods that imply "in SF" without saying so. An event "at
// the Castro Theater" is in SF; a post about Fisherman's Wharf is SF tourism.
const SF_LANDMARK_REGEX = /\b(castro theatre|castro theater|golden gate park|golden gate bridge|fisherman'?s wharf|the embarcadero|chase center|oracle park|sf giants|sf 49ers|mission district|the mission\b|tenderloin|haight\b|haight-ashbury|nob hill|ocean beach|the presidio|outer sunset|outer richmond|north beach sf|alamo square)\b/i;

function isLikelyOutOfArea(p) {
  const text = `${p.title || ""} ${p.selftext || ""}`;
  if (SOUTH_BAY_HINT_REGEX.test(text)) return false;
  // r/AskSF is SF-by-definition; without an explicit South Bay hint, drop it.
  if ((p.sub || "").toLowerCase() === "asksf") return true;
  if (SF_MARKER_REGEX.test(text)) return true;
  if (SF_LANDMARK_REGEX.test(text)) return true;
  return false;
}

// ─── Subreddit list ───────────────────────────────────────────────────
const SUBS = [
  // South Bay core
  { name: "SanJose",       weight: 1.0, scope: "south-bay" },
  { name: "siliconvalley", weight: 0.9, scope: "south-bay" },
  { name: "PaloAlto",      weight: 0.95, scope: "south-bay" },
  { name: "MountainView",  weight: 0.95, scope: "south-bay" },
  { name: "Sunnyvale",     weight: 0.95, scope: "south-bay" },
  { name: "SantaClara",    weight: 0.9, scope: "south-bay" },
  { name: "Cupertino",     weight: 0.9, scope: "south-bay" },
  { name: "Saratoga_CA",   weight: 0.9, scope: "south-bay" },
  { name: "losgatos",      weight: 0.9, scope: "south-bay" },
  { name: "Milpitas",      weight: 0.9, scope: "south-bay" },
  { name: "campbell",      weight: 0.85, scope: "south-bay" },
  // Broader Bay (lower weight — needs to be South Bay relevant to surface)
  { name: "bayarea",       weight: 0.6, scope: "bay-area" },
  { name: "AskSF",         weight: 0.4, scope: "bay-area" },
  { name: "bayareafood",   weight: 0.7, scope: "bay-area" },
  // Sports
  // Sports subs are skipped during the team's offseason — empty rinks /
  // empty pitches generate trade rumors and "what should we do" filler that
  // doesn't read as fun local content. Months are inclusive PT, 1-indexed.
  // Sharks: NHL regular season Oct–Apr (we don't bother extending into
  // playoff months — Sharks haven't made it in years).
  // Earthquakes: MLS season late Feb–early Nov.
  { name: "SanJoseSharks",  weight: 0.7, scope: "sports", seasonMonths: [10, 11, 12, 1, 2, 3, 4] },
  { name: "sjearthquakes",  weight: 0.7, scope: "sports", seasonMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

// ─── Helpers ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch a subreddit's public Atom feed and return the raw <entry> blocks.
// Reddit 403s the unauthenticated *.json API and gates new API apps to
// moderation use cases (Responsible Builder Policy, 2026-05) — but the public
// RSS feeds stay open. They carry title/link/author/timestamp/body but NO
// score and NO comments, so ranking is recency-based and comment mining is gone.
async function fetchRedditRss(sub, path) {
  const url = `https://www.reddit.com/r/${sub}/${path}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.status === 404 || res.status === 403) {
      console.log(`  ⤳ r/${sub} ${path}: ${res.status} (skipped)`);
      return [];
    }
    if (!res.ok) {
      console.log(`  ⤳ r/${sub} ${path}: HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    return xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  } catch (err) {
    console.log(`  ⤳ r/${sub} ${path}: ${err.message}`);
    return [];
  }
}

function decodeHtmlEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Parse one Atom <entry> from a subreddit RSS feed into the post shape the rest
// of the pipeline expects. score/numComments are unknowable over RSS → 0 (the
// homepage + city tiles hide the ↑/💬 chips when 0). The body comes from
// <content>, which for self-posts holds the post text followed by a
// "submitted by … [link] [comments]" footer we strip off.
function normalizeRssEntry(entry, subName, weight, scope) {
  const grab = (re) => { const m = entry.match(re); return m ? m[1] : ""; };

  const id = grab(/<id>([^<]+)<\/id>/).replace(/^t3_/, "");
  const title = decodeHtmlEntities(grab(/<title>([\s\S]*?)<\/title>/).trim());
  if (!id || !title) return null;

  const author = grab(/<author>[\s\S]*?<name>([^<]+)<\/name>/).replace(/^\/u\//, "");
  // AutoModerator posts are megathreads / classifieds / stickies — never content.
  if (author === "AutoModerator") return null;

  const permalink = grab(/<link[^>]*\bhref="([^"]+)"/);
  const ts = grab(/<published>([^<]+)<\/published>/) || grab(/<updated>([^<]+)<\/updated>/);
  const createdUtc = ts ? Math.floor(new Date(ts).getTime() / 1000) : Math.floor(Date.now() / 1000);

  // <content> is HTML-encoded; decode, drop the SC_OFF/ON markers and the trailing
  // "submitted by … [link] [comments]" boilerplate, then strip tags to plain text.
  let body = decodeHtmlEntities(grab(/<content[^>]*>([\s\S]*?)<\/content>/));
  body = body
    .replace(/<!--\s*SC_O(?:FF|N)\s*-->/g, "")
    .replace(/&#32;/g, " ")
    .replace(/submitted by[\s\S]*$/i, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    id,
    sub: subName,
    title,
    selftext: body.slice(0, 1200),
    author,
    score: 0,
    numComments: 0,
    createdUtc,
    ageHours: (Date.now() / 1000 - createdUtc) / 3600,
    permalink,
    externalUrl: null,
    isSelf: true,
    weight,
    scope,
  };
}

async function callClaude(prompt, maxTokens = 4096) {
  return callClaudeApi(prompt, { maxTokens, label: "reddit-pulse" });
}

function parseJson(raw) {
  // Handle ```json fences as well as bare JSON.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();

  // Try parsing the full candidate as-is.
  try { return JSON.parse(candidate); } catch {}

  // Fall back to object first (handles "{...arrays inside...}" without grabbing the
  // inner array). Then array. Greedy regex so we capture from outer { to last }.
  const obj = candidate.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch {} }

  const arr = candidate.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch {} }

  throw new Error("Could not parse JSON from response");
}

// Normalize a place name for comparison: lowercase, strip punctuation, drop common
// suffixes like "restaurant", "cafe", "bar", "& grill". Used as a key for map lookup,
// not as final display text.
function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\w\s&]/g, " ")
    .replace(/\s+(restaurant|cafe|caf[eé]|bar|grill|kitchen|deli|bakery|coffee|tea house|brewery|brewing|pub|tavern|eatery|bistro|diner|pizzeria|taqueria|the)\b/gi, "")
    .replace(/^the\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching ${SUBS.length} subreddits via RSS…\n`);

  // ─── PHASE 1: Fetch posts from every sub ────────────────────────────
  const ptMonth = Number(new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "numeric" }));
  const activeSubs = SUBS.filter((s) => !s.seasonMonths || s.seasonMonths.includes(ptMonth));
  const skipped = SUBS.filter((s) => s.seasonMonths && !s.seasonMonths.includes(ptMonth));
  if (skipped.length) console.log(`Skipping offseason subs: ${skipped.map((s) => `r/${s.name}`).join(", ")}\n`);
  const all = [];
  for (const sub of activeSubs) {
    const topEntries = await fetchRedditRss(sub.name, "top/.rss?t=day");
    await sleep(REQUEST_DELAY_MS);
    const newEntries = await fetchRedditRss(sub.name, "new/.rss");
    await sleep(REQUEST_DELAY_MS);

    const seen = new Set();
    const normalized = [...topEntries, ...newEntries]
      .map((e) => normalizeRssEntry(e, sub.name, sub.weight, sub.scope))
      .filter(Boolean)
      .filter((p) => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
      .filter((p) => p.ageHours <= 96);

    console.log(`  ✓ r/${sub.name}: ${normalized.length} posts`);
    all.push(...normalized);
  }
  console.log(`\n${all.length} total posts.\n`);

  if (all.length === 0) {
    console.error("No posts fetched. Aborting.");
    process.exit(1);
  }

  const preGeoCount = all.length;
  const geoScoped = all.filter((p) => !isLikelyOutOfArea(p));
  const droppedOOA = preGeoCount - geoScoped.length;
  if (droppedOOA > 0) console.log(`Dropped ${droppedOOA} out-of-area posts (SF/AskSF/etc.) pre-classification.`);

  const candidates = geoScoped
    // RSS feeds are Reddit's own top/day + new listings — already pre-curated, and
    // there's no score to floor on. Rank by sub weight then recency so the highest-
    // signal local subs lead the slice we hand to the classifier.
    .sort((a, b) => (b.weight - a.weight) || (b.createdUtc - a.createdUtc))
    .slice(0, 300);

  console.log(`${candidates.length} candidates to classify.\n`);

  // ─── PHASE 2: Classify with Sonnet ───────────────────────────────────
  // Classify in chunks so the JSON response can't blow past max_tokens. RSS has
  // no engagement floor, so the candidate pool is large; one monolithic call
  // truncates. Global 1-based indices are preserved across chunks so the enrich
  // step below still matches by `i`.
  const buildClassifyPrompt = (chunk, startIdx) => {
    const list = chunk
      .map((p, j) => {
        const body = p.selftext ? ` — "${p.selftext.slice(0, 200).replace(/\n+/g, " ")}"` : "";
        return `${startIdx + j + 1}. [r/${p.sub}] ${p.title}${body}`;
      })
      .join("\n");
    return `You are curating Reddit posts for South Bay Today, a Silicon Valley local discovery site. The vibe is light, uplifting, locally-relevant. Cities we cover: San Jose, Sunnyvale, Palo Alto, Mountain View, Santa Clara, Cupertino, Los Gatos, Saratoga, Campbell, Milpitas. NOT covered: SF, Oakland, East Bay, North Bay, Peninsula north of Palo Alto, anything outside the Bay Area.

Here are ${chunk.length} Reddit posts:

${list}

For each post, output a JSON object with:
- "i": the 1-based index shown for each post
- "category": one of:
    "event"            — a specific upcoming event or activity (concert, festival, run, market, class)
    "restaurant_news"  — restaurant opening, closing, new location, expansion, or strong recommendation
    "discussion"       — interesting local Q&A, recommendations thread, "best X in city Y", neighborhood chatter — UPLIFTING/CURIOUS, not complaining
    "news"             — POSITIVE local news (a new park, a business expansion, a community win, transit upgrade)
    "negative_news"    — crime, lawsuits, accidents, deaths, dangerous incidents, scams, "is it safe" questions, scary stuff, fires, rescues, missing persons, anything where bad stuff happened (even if responders did good work)
    "personal"         — complaints, rants, lost-and-found, venting, ANY post with a negative-leaning headline ("really ruin", "terrible", "this is bad", "avoid", "I'm so frustrated")
    "political"        — politics, elections, partisan content
    "out_of_area"      — about SF, East Bay, Peninsula north of PA, or non-Bay
    "noise"            — memes, low-effort, NSFW-adjacent, scams, surveys, study recruitment
    "sports"           — local sports team result/news (Sharks, Earthquakes, etc.)

CRITICAL: a headline that complains, sounds defensive, or warns about something bad → "personal" or "negative_news", NOT "discussion" or "news", regardless of how popular the post is. We never surface complaint posts.
- "relevance": integer 1-10 — how relevant + interesting to South Bay residents looking for *fun, useful, uplifting* local content
- "topic": short kebab-case slug (3-6 words) describing what the post is ABOUT — its subject. Posts about the same OVERALL subject MUST share a topic — be GENEROUS with clustering. Two Earthquakes posts about ANY recent good performance → both get "earthquakes-good-season-run" (do NOT split into "earthquakes-record-start" vs "earthquakes-recent-win"). Two pepper-spray Costco posts → "mountain-view-costco-incident". A bagel rec thread → "san-jose-bagels". Treat sports posts about the same team's recent form as one topic.
- "summary": one short sentence (under 25 words) — what the post is about, plain English, no "OP asks…"
- "imagePrompt": short Recraft prompt (10-20 words) for an abstract, colorful illustrative tile. Specific to the topic. Use bold flat-color illustration style — NOT photorealistic. Examples:
    "Adamson's opens": "playful flat illustration of a French dip sandwich with melted cheese, bright purple and orange palette, no text, no people"
    "SJ bagel rec thread": "stack of colorful bagels with cream cheese and lox, pop-art style, vivid teal and yellow palette, no text"
    "Earthquakes win": "abstract soccer ball mid-flight with bold green and white triangular shapes, dynamic motion, no text, no logos"
    "MV ranks #6 best place": "stylized aerial silhouette of suburban houses and oak trees, sunset sky with magenta and gold, no text, no people"
  Vary palettes across posts so the grid feels colorful, not monochrome.
  When the subject has a natural orientation (a swimmer in a lap pool, a runner on a track, a car on a road, a plane in the sky), be EXPLICIT about direction so Recraft doesn't randomize it: "swimmer gliding ALONG the lane lines (parallel to lanes, not across)", "runner moving down the track in lane direction", "car driving forward along the road". Composition cues prevent Recraft from rotating the subject 90°.
  Always end with "no text, no people, no logos".

Be strict on relevance. Crime/lawsuits/scary stuff = relevance 1-3 (we won't surface). Boring complaints = 1-3. A guy ranting about traffic = relevance 1. An MRI study recruitment = relevance 1. A new restaurant opening = relevance 9. A great rec thread = relevance 8.

Return ONLY a JSON array of objects, no other text.`;
  };

  console.log("Classifying with Sonnet…");
  const CLASSIFY_CHUNK = 60;
  const classified = [];
  for (let start = 0; start < candidates.length; start += CLASSIFY_CHUNK) {
    const chunk = candidates.slice(start, start + CLASSIFY_CHUNK);
    let raw;
    try {
      raw = await callClaude(buildClassifyPrompt(chunk, start), 16384);
      classified.push(...parseJson(raw));
    } catch (err) {
      console.error("Classify error:", err.message);
      console.error("Raw response head:", (raw || "").slice(0, 300));
      console.error("Raw response tail:", (raw || "").slice(-300));
      process.exit(1);
    }
    console.log(`  ✓ classified ${Math.min(start + CLASSIFY_CHUNK, candidates.length)}/${candidates.length}`);
  }

  const enriched = candidates.map((c, i) => {
    const cls = classified.find((x) => x.i === i + 1);
    return cls
      ? {
          ...c,
          category: cls.category,
          relevance: cls.relevance,
          topic: cls.topic || c.id,
          summary: cls.summary,
          imagePrompt: cls.imagePrompt || "",
        }
      : { ...c, category: "noise", relevance: 0, topic: c.id, summary: c.title, imagePrompt: "" };
  });
  console.log(`${enriched.length} classified.\n`);

  // ─── PHASE 3: Write the homepage pulse ──────────────────────────────
  // Allowed categories: explicit positive ones. negative_news/personal/political
  // are excluded. sports allowed only if relevance is high (real win, not "ugh ref").
  const POSITIVE_CATEGORIES = new Set(["discussion", "news", "event", "restaurant_news", "sports"]);

  const pulseEligible = enriched
    .filter((p) => POSITIVE_CATEGORIES.has(p.category))
    .filter((p) => p.relevance >= 6)
    .filter((p) => p.ageHours <= 72)
    // Sort by recency — newest first. Quality is enforced by the relevance/category
    // gates above plus the topic-dedupe + sub-cap below, so we don't need engagement
    // weighting in the sort. Pure recency keeps the feed feeling live.
    .sort((a, b) => b.createdUtc - a.createdUtc);

  // Topic dedupe: keep only the highest-ranked post per topic. Two Earthquakes-win
  // posts with the same topic will collapse to one. Sub cap stays as a secondary
  // safeguard. Sports cap because the same season run shows up across many posts
  // even when topics technically differ.
  const PULSE_TARGET = 12;
  const PER_SUB_CAP = 3;     // bumped from 2 to support 12 total
  const SPORTS_CAP = 1;      // explicit sports category — at most 1 of 12
  const SPORTS_SUB_CAP = 2;  // total posts from scope=sports subs (Sharks + Earthquakes)

  const seenTopics = new Set();
  const subCounts = new Map();
  const seenIds = new Set();
  let sportsCount = 0;
  let sportsSubCount = 0;
  const pulse = [];
  for (const p of pulseEligible) {
    if (p.topic && seenTopics.has(p.topic)) continue;
    const n = subCounts.get(p.sub) ?? 0;
    if (n >= PER_SUB_CAP) continue;
    if (p.category === "sports" && sportsCount >= SPORTS_CAP) continue;
    if (p.scope === "sports" && sportsSubCount >= SPORTS_SUB_CAP) continue;
    pulse.push(p);
    seenIds.add(p.id);
    if (p.topic) seenTopics.add(p.topic);
    subCounts.set(p.sub, n + 1);
    if (p.category === "sports") sportsCount++;
    if (p.scope === "sports") sportsSubCount++;
    if (pulse.length >= PULSE_TARGET) break;
  }

  // Backfill — homepage grid is a fixed 4×3 of 12 tiles; a short feed leaves
  // a visible gap. If strict gates left us under PULSE_TARGET, relax in tiers
  // (drop sub cap → drop sports cap → widen age window → lower relevance) until
  // we hit 12 or run out of candidates. Keeps topic dedupe — that's a quality
  // floor, not a tunable.
  if (pulse.length < PULSE_TARGET) {
    const tiers = [
      // Tier 1: same gates, just drop the per-sub and sports caps.
      (p) => POSITIVE_CATEGORIES.has(p.category) && p.relevance >= 6 && p.ageHours <= 72,
      // Tier 2: widen the age window to a week.
      (p) => POSITIVE_CATEGORIES.has(p.category) && p.relevance >= 6 && p.ageHours <= 168,
      // Tier 3: lower the relevance floor.
      (p) => POSITIVE_CATEGORIES.has(p.category) && p.relevance >= 4 && p.ageHours <= 168,
    ];
    for (const passes of tiers) {
      if (pulse.length >= PULSE_TARGET) break;
      for (const p of enriched.sort((a, b) => b.createdUtc - a.createdUtc)) {
        if (pulse.length >= PULSE_TARGET) break;
        if (seenIds.has(p.id)) continue;
        if (p.topic && seenTopics.has(p.topic)) continue;
        if (!passes(p)) continue;
        pulse.push(p);
        seenIds.add(p.id);
        if (p.topic) seenTopics.add(p.topic);
      }
    }
    console.log(`Backfilled to ${pulse.length} (target ${PULSE_TARGET}).`);
  }

  if (pulse.length < PULSE_TARGET) {
    console.warn(
      `⚠️  editorial selection short: ${pulse.length}/${PULSE_TARGET} — ` +
      `even with all backfill tiers exhausted, candidate pool was insufficient. ` +
      `Subreddit fetch likely thin today.`,
    );
  }

  // ─── PHASE 3b: Image hydration (every selected post gets an image) ────
  // Editorial selection above is final. This phase only hydrates an image
  // for each chosen post — Recraft is just the preferred source, with a
  // multi-tier fallback so image-gen failures never drop a post.
  let imageCache = {};
  if (existsSync(IMAGE_CACHE_PATH)) {
    try { imageCache = JSON.parse(readFileSync(IMAGE_CACHE_PATH, "utf8")); } catch {}
  }

  // Generic per-category fallback prompts — used when a post-specific prompt
  // gets rejected by Recraft (content moderation, weird subject, etc.).
  // Topic-agnostic so they never hit the same rejection.
  const GENERIC_FALLBACK_PROMPTS = {
    restaurant_news: "abstract still-life of plates, cups, and food shapes in pop-art style, vivid warm palette",
    event:           "abstract confetti, balloons, and celebration shapes in flat-color illustration, vibrant palette",
    discussion:      "abstract overlapping speech bubbles and dots in pop-art style, bold mixed palette",
    news:            "abstract geometric collage of overlapping rectangles and circles, bold mixed palette",
    sports:          "abstract dynamic motion lines and arrow shapes in flat-color illustration, energetic mixed palette",
  };

  async function tryRecraft(p, prompt) {
    const fullPrompt = `${prompt}. Bold flat-color illustration. Vivid colors. Square 1:1 ratio. NO TEXT, no letters, no words, no people, no logos, no faces.`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Tiles render at ~150-185px via CSS background-image (RedditPulseTeaser
        // 4-col grid) — 400x400 lossy webp q80 is generous headroom at that
        // display size and a ~5x byte reduction vs. Recraft's lossless source.
        const result = await generateAndUploadResized({
          prompt: fullPrompt,
          pathname: `reddit-pulse/${p.id}-400.webp`,
          width: 400,
          height: 400,
        });
        return result.url;
      } catch (err) {
        const msg = err.message || "";
        if (msg.includes("429") && attempt < 2) {
          const wait = 4000 * (attempt + 1);
          console.warn(`  ⏳ tile r/${p.sub}/${p.id} rate-limited, waiting ${wait}ms…`);
          await sleep(wait);
          continue;
        }
        console.warn(`  ⚠️  tile r/${p.sub}/${p.id} failed: ${msg}`);
        return null;
      }
    }
    return null;
  }

  // Find a cached image suitable as a fallback for post `p`. Strategy:
  //   1. Same topic, generated within 21d — exact subject match, freshest first
  //   2. Same category, generated within 21d — random pick for variety
  // Returns null if no usable match. Existing cache entries from before topic/
  // category tracking are skipped (no metadata = no safe match).
  const FALLBACK_AGE_MS = 21 * 86400000;
  function findCacheFallback(p) {
    const cutoff = Date.now() - FALLBACK_AGE_MS;
    const topicMatch = [];
    const categoryMatch = [];
    for (const entry of Object.values(imageCache)) {
      if (!entry?.url) continue;
      if (new Date(entry.generatedAt).getTime() < cutoff) continue;
      if (p.topic && entry.topic === p.topic) {
        topicMatch.push(entry);
      } else if (p.category && entry.category === p.category) {
        categoryMatch.push(entry);
      }
    }
    if (topicMatch.length > 0) {
      topicMatch.sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
      return { url: topicMatch[0].url, kind: "topic" };
    }
    if (categoryMatch.length > 0) {
      const pick = categoryMatch[Math.floor(Math.random() * categoryMatch.length)];
      return { url: pick.url, kind: "category" };
    }
    return null;
  }

  // Hydrate an image for a post that was already selected editorially.
  // Sources in priority order — first hit wins, never drops the post:
  //   1. cache-exact     — same post id was imaged in a prior run
  //   2. recraft-specific — fresh Recraft with the post-specific prompt
  //   3. recraft-generic  — fresh Recraft with a category-generic prompt
  //   4. cache-topic      — cached image with same topic slug (within 21d)
  //   5. cache-category   — cached image with same category (within 21d)
  // With ~400 tagged cache entries spread across 5 categories, step 5 is
  // essentially evergreen — image-gen ceases to be a load-bearing filter.
  async function hydrateImage(p) {
    const cached = imageCache[p.id];
    if (cached?.url) return { url: cached.url, source: "cache-exact" };

    if (p.imagePrompt) {
      let url = await tryRecraft(p, p.imagePrompt);
      if (url) return { url, source: "recraft-specific" };

      const generic = GENERIC_FALLBACK_PROMPTS[p.category];
      if (generic) {
        console.warn(`  ↻ retrying r/${p.sub}/${p.id} with generic ${p.category} prompt…`);
        await sleep(1500);
        url = await tryRecraft(p, generic);
        if (url) return { url, source: "recraft-generic" };
      }
    }

    const fallback = findCacheFallback(p);
    if (fallback) {
      console.warn(`  ♻︎ r/${p.sub}/${p.id} reusing cached ${fallback.kind} image`);
      return { url: fallback.url, source: `cache-${fallback.kind}` };
    }
    return null;
  }

  console.log(`Hydrating images for ${pulse.length} selected posts…`);
  const imageById = new Map();
  let failedHydration = 0;
  const sourceCounts = { "cache-exact": 0, "recraft-specific": 0, "recraft-generic": 0, "cache-topic": 0, "cache-category": 0 };

  for (const p of pulse) {
    const result = await hydrateImage(p);
    if (result) {
      const { url, source } = result;
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
      // Persist fresh Recraft generations to cache; cache-* sources are
      // already in the cache so no re-write needed.
      const isFresh = source === "recraft-specific" || source === "recraft-generic";
      if (isFresh && !imageCache[p.id]) {
        imageCache[p.id] = {
          url,
          prompt: p.imagePrompt,
          topic: p.topic || null,
          category: p.category || null,
          generatedAt: new Date().toISOString(),
        };
      }
      imageById.set(p.id, url);
      console.log(`  ✓ r/${p.sub}/${p.id} [${source}]`);
    } else {
      failedHydration++;
      console.error(`  ⨯ r/${p.sub}/${p.id} hydration failed — cache empty for this category?`);
    }
    // Polite spacing between Recraft calls. Sources that didn't call Recraft
    // (cache-exact / cache-topic / cache-category) don't strictly need this
    // wait, but the per-post cost is small and it keeps things readable.
    await sleep(500);
  }
  console.log(`Image sources: ${JSON.stringify(sourceCounts)}`);

  // Posts that fail every hydration tier (should never happen with a healthy
  // cache) are dropped here. UI tolerates shortfall by trimming to multiple of 4.
  if (failedHydration > 0) {
    const before = pulse.length;
    const filtered = pulse.filter((p) => imageById.has(p.id));
    pulse.length = 0;
    pulse.push(...filtered);
    console.warn(`Dropped ${before - pulse.length} posts with no image.`);
  }
  console.log(`Final pulse: ${pulse.length} posts (target ${PULSE_TARGET}).`);

  // Alert when we can't reach target. Two distinct causes:
  //   - Editorial: <12 candidates survived even with relaxed gates (thin sub feeds)
  //   - Hydration: cache + Recraft both empty for some category (shouldn't happen)
  if (pulse.length < PULSE_TARGET) {
    const heavyFallback =
      (sourceCounts["cache-topic"] + sourceCounts["cache-category"]) > 4;
    console.warn(
      `⚠️  reddit-pulse below target: ${pulse.length}/${PULSE_TARGET} ` +
      `(hydration-fails: ${failedHydration}, heavy-fallback: ${heavyFallback})`,
    );
    const webhook = process.env.DISCORD_WEBHOOK;
    if (webhook) {
      const sources = Object.entries(sourceCounts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}=${n}`)
        .join(", ");
      const msg =
        `⚠️ reddit-pulse landed at **${pulse.length}/${PULSE_TARGET}**\n` +
        `Hydration failed: ${failedHydration}\n` +
        `Sources: ${sources || "(none)"}\n` +
        `Grid will trim to ${Math.floor(pulse.length / 4) * 4} tiles.`;
      try {
        await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: msg }),
        });
      } catch (err) {
        console.error("Discord webhook failed:", err.message);
      }
    }
  }

  // Persist image cache (even on partial failure — we want successful URLs saved).
  writeFileAtomic(IMAGE_CACHE_PATH, JSON.stringify(imageCache, null, 2) + "\n");

  // Prune cache entries that haven't been seen in pulse for >30 days.
  // (Simple pruning: keep only ones referenced this run + recent ones.)
  const pulseIds = new Set(pulse.map((p) => p.id));
  const now = Date.now();
  const prunedCache = {};
  for (const [id, entry] of Object.entries(imageCache)) {
    const ageDays = (now - new Date(entry.generatedAt).getTime()) / 86400000;
    if (pulseIds.has(id) || ageDays < 30) prunedCache[id] = entry;
  }
  writeFileAtomic(IMAGE_CACHE_PATH, JSON.stringify(prunedCache, null, 2) + "\n");

  // ─── PHASE 3c: Light-touch title polish ─────────────────────────────
  // Runs AFTER image filtering so we polish only what we're actually shipping
  // (including any reserve-swapped posts). One Sonnet call for all final titles.
  // Original `title` is preserved on each post; `displayTitle` is what the UI renders.
  if (pulse.length > 0) {
    const titlesBlock = pulse
      .map((p, i) => `${i + 1}. ${p.title}`)
      .join("\n");
    const polishPrompt = `Below are Reddit post titles. Apply the LIGHTEST possible touch-up to each — fix things the OP themselves would fix on a re-read, and nothing more.

DO fix:
- Capitalize the FIRST word of the title (e.g. "our ted lindsay finalist!" → "Our ted lindsay finalist!" — then continue to the proper-noun rule below)
- Capitalize proper nouns: people's names, team names, place names, brand names, product names (e.g. "our ted lindsay finalist!" → "Our Ted Lindsay Finalist!" — Ted Lindsay is a person; "best pizza in san jose" → "Best pizza in San Jose")
- Stray/wrong commas (e.g. "Bed Bath and Beyond will return, at Stanford" → drop the comma)
- Trailing periods on sentence fragments / phrases (e.g. "New Lakewood Park Library and Renovation." → drop the period)
- Doubled spaces, missing spaces around punctuation
- Obvious typos and missing words (e.g. "How many game are Drew" → "How many games are Drew")
- Stylized ALL CAPS in the middle of an otherwise sentence-cased title (e.g. "22 Events in SAN JOSE — Today APR 25, 2026" → "22 Events in San Jose — Today Apr 25, 2026")

DO NOT touch:
- A title that's ENTIRELY all-caps as Reddit shouting voice — leave it (but if mostly lowercase, fix per rules above)
- Lots of exclamation points, emoji decoration, slang, "!!!!" — that's the OP's voice; leave it
- Meaning, structure, word order
- Quotes inside the title
- Common words mid-title (don't title-case every word; just first word + proper nouns)

If a title needs no edits, return it unchanged verbatim.

TITLES:
${titlesBlock}

Return ONLY a JSON array of objects, in the same order:
[
  {"i": 1, "displayTitle": "..."},
  {"i": 2, "displayTitle": "..."},
  ...
]
No other text.`;

    try {
      console.log("Polishing titles…");
      const raw = await callClaude(polishPrompt, 4096);
      const polished = parseJson(raw);
      for (const item of polished) {
        const post = pulse[item.i - 1];
        if (!post) continue;
        const cleaned = (item.displayTitle || "").trim();
        if (cleaned && cleaned !== post.title) {
          post.displayTitle = cleaned;
          console.log(`  ✎ "${post.title}" → "${cleaned}"`);
        }
      }
    } catch (err) {
      console.warn(`  ⚠️  polish failed: ${err.message}`);
    }
  }

  // Drop a summary that only re-says its own headline. The "Around town"
  // section prints both lines, so a restatement costs the reader a re-read for
  // nothing — the 2026-09-07 issue ran "VTA defends its plan to extend BART to
  // downtown San Jose" over "VTA defends its plan to extend BART service to
  // downtown San Jose." Compared against displayTitle because that is the line
  // readers actually see. Every render site already guards an empty summary.
  let echoes = 0;
  for (const p of pulse) {
    const shown = p.displayTitle || p.title;
    if (p.summary && summaryEchoesTitle(shown, p.summary)) {
      console.log(`  🔁 dropped echo summary: "${shown}" ← "${p.summary}"`);
      p.summary = "";
      echoes += 1;
    }
  }
  if (echoes) console.log(`  ${echoes} echo summaries dropped`);

  const pulseOutput = {
    _meta: generatorMeta("generate-reddit-pulse", {
      sourceCount: SUBS.length,
      sources: SUBS.map((s) => `r/${s.name}`),
    }),
    posts: pulse.map((p) => ({
      id: p.id,
      sub: p.sub,
      title: p.title,
      displayTitle: p.displayTitle || p.title,
      summary: p.summary,
      category: p.category,
      topic: p.topic,
      image: imageById.get(p.id) || null,
      score: p.score,
      numComments: p.numComments,
      ageHours: Math.round(p.ageHours * 10) / 10,
      createdUtc: p.createdUtc,
      permalink: p.permalink,
      externalUrl: p.externalUrl,
    })),
  };
  writeFileAtomic(PULSE_OUT, JSON.stringify(pulseOutput, null, 2) + "\n");
  console.log(`✅ ${pulse.length} pulse items → reddit-pulse.json`);

  // ─── PHASE 4: Pick posts to mine for named entities ─────────────────
  // RSS exposes no comment trees, so entity extraction runs on the post title +
  // body only. Opening announcements ("X just opened on Bascom") are usually the
  // post itself, so this still surfaces the highest-value gaps — just fewer than
  // the old comment mining did. Highest-relevance posts first.
  const minedPosts = enriched
    .filter((p) => ["discussion", "restaurant_news", "event", "news"].includes(p.category))
    .filter((p) => p.relevance >= 6)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, MAX_COMMENT_FETCHES)
    .map((p) => ({ ...p, commentText: "", commentCountFetched: 0 }));

  console.log(`\nExtracting entities from ${minedPosts.length} posts (titles + bodies; RSS has no comments)…`);

  // ─── PHASE 5: Extract named entities via Sonnet ──────────────────────
  // Chunk posts to keep prompts reasonable.
  const allEntities = { places: [], events: [] };
  const chunkSize = 5;
  for (let i = 0; i < minedPosts.length; i += chunkSize) {
    const chunk = minedPosts.slice(i, i + chunkSize);
    const blocks = chunk
      .map((p, idx) => {
        const header = `### POST ${i + idx + 1} [r/${p.sub}, category=${p.category}]`;
        return `${header}\nTITLE: ${p.title}\n${p.selftext ? `BODY: ${p.selftext}\n` : ""}${p.commentText ? `COMMENTS:\n${p.commentText}` : ""}`;
      })
      .join("\n\n---\n\n");

    const extractPrompt = `Below are Reddit posts and their top comments from South Bay subreddits. Extract specific named entities — businesses, restaurants, venues, and events — that someone reading these threads might want to know about.

Output format (JSON object, NOT array):
{
  "places": [
    {"name": "Adamson's French Dip", "city": "San Jose", "kind": "restaurant", "context": "new Bascom Ave location"},
    ...
  ],
  "events": [
    {"name": "National River Cleanup Day", "when": "Saturday May 16", "city": "San Jose", "context": "annual cleanup event"},
    ...
  ]
}

Rules:
- Only specific named entities, not generic mentions ("the new place" / "that taqueria" don't count)
- Restaurants, bars, cafes, bakeries, breweries, food trucks, retail businesses, venues, parks → "places"
- "kind" for places: "restaurant" | "bar" | "cafe" | "bakery" | "retail" | "venue" | "park" | "service" | "other"
- "city" must be a South Bay city (San Jose, Sunnyvale, Palo Alto, Mountain View, Santa Clara, Cupertino, Los Gatos, Saratoga, Campbell, Milpitas) — if unclear, set to ""
- Skip places outside the South Bay (SF, Oakland, etc.)
- Skip national chains unless a specific local opening is being discussed (e.g. a new In-N-Out is news; "I went to McDonald's" is not)
- "context" is one short phrase explaining why this name surfaced (3-12 words)
- Dedupe — if the same place appears in 5 comments, list it once with the most informative context
- Aim for HIGH RECALL — err on the side of including a name if it might be relevant; we'll filter later

POSTS:
${blocks}

Return ONLY the JSON object, no other text.`;

    try {
      console.log(`\nExtracting entities (chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(minedPosts.length / chunkSize)})…`);
      const raw = await callClaude(extractPrompt, 4096);
      const parsed = parseJson(raw);
      // Tag each entity with the source posts in this chunk
      const sourceUrls = chunk.map((p) => p.permalink);
      for (const place of (parsed.places ?? [])) allEntities.places.push({ ...place, sourceUrls });
      for (const event of (parsed.events ?? [])) allEntities.events.push({ ...event, sourceUrls });
    } catch (err) {
      console.warn(`  ⚠️  chunk ${i / chunkSize} extract failed: ${err.message}`);
    }
  }

  console.log(`\nExtracted: ${allEntities.places.length} place mentions, ${allEntities.events.length} event mentions.`);

  // ─── PHASE 6: Cross-reference against our data ──────────────────────
  // Build name index from places.json + scc-food-openings + restaurant-radar + upcoming-events.
  const knownPlaceMap = new Map(); // normalized name → display name
  const knownEventMap = new Map();

  function indexName(map, displayName) {
    const norm = normalizeName(displayName);
    if (!norm || norm.length < 3) return;
    if (!map.has(norm)) map.set(norm, displayName);
  }

  // places.json — the big one (2492 entries)
  if (existsSync(ARTIFACTS.places)) {
    try {
      const places = JSON.parse(readFileSync(ARTIFACTS.places, "utf8"));
      const arr = places.places || [];
      for (const p of arr) indexName(knownPlaceMap, p.name);
      console.log(`\nIndexed ${arr.length} places from places.json`);
    } catch (err) { console.warn("places.json read err:", err.message); }
  }

  // scc-food-openings — verified openings, final inspections, and coming-soon signals
  if (existsSync(ARTIFACTS.foodOpenings)) {
    try {
      const fo = JSON.parse(readFileSync(ARTIFACTS.foodOpenings, "utf8"));
      for (const r of [...(fo.opened || []), ...(fo.inspections || []), ...(fo.comingSoon || [])]) {
        indexName(knownPlaceMap, r.name);
      }
    } catch (err) { console.warn("food-openings read err:", err.message); }
  }

  // restaurant-radar
  if (existsSync(ARTIFACTS.restaurantRadar)) {
    try {
      const rr = JSON.parse(readFileSync(ARTIFACTS.restaurantRadar, "utf8"));
      for (const r of (rr.items || [])) indexName(knownPlaceMap, r.name);
    } catch {}
  }

  // upcoming-events
  if (existsSync(ARTIFACTS.events)) {
    try {
      const ev = JSON.parse(readFileSync(ARTIFACTS.events, "utf8"));
      for (const e of (ev.events || [])) indexName(knownEventMap, e.title);
    } catch {}
  }

  console.log(`Total known place names: ${knownPlaceMap.size}, event titles: ${knownEventMap.size}\n`);

  // Match each extracted entity
  function matchPlace(entityName) {
    const norm = normalizeName(entityName);
    if (!norm) return null;
    // Exact normalized match
    if (knownPlaceMap.has(norm)) return knownPlaceMap.get(norm);
    // Substring (one direction) — meaningful only if entity is a 2+ word name
    if (norm.length >= 6) {
      for (const [k, v] of knownPlaceMap) {
        if (k.includes(norm) || norm.includes(k)) {
          // Require token overlap of ≥2 to avoid weak substring matches like "park"
          const ts = new Set(norm.split(" ").filter((t) => t.length > 2));
          const ks = new Set(k.split(" ").filter((t) => t.length > 2));
          let overlap = 0;
          for (const t of ts) if (ks.has(t)) overlap++;
          if (overlap >= 2) return v;
        }
      }
    }
    return null;
  }

  function matchEvent(entityName) {
    const norm = normalizeName(entityName);
    if (!norm) return null;
    if (knownEventMap.has(norm)) return knownEventMap.get(norm);
    for (const [k, v] of knownEventMap) {
      if (k.includes(norm) && norm.length >= 5) return v;
    }
    return null;
  }

  // Dedupe entities by normalized name (keep first occurrence with merged sourceUrls)
  function dedupe(entities) {
    const map = new Map();
    for (const e of entities) {
      const norm = normalizeName(e.name);
      if (!norm) continue;
      if (!map.has(norm)) {
        map.set(norm, { ...e, sourceUrls: [...new Set(e.sourceUrls)] });
      } else {
        const existing = map.get(norm);
        existing.sourceUrls = [...new Set([...existing.sourceUrls, ...e.sourceUrls])];
        if (!existing.context && e.context) existing.context = e.context;
      }
    }
    return [...map.values()];
  }

  const placeEntities = dedupe(allEntities.places);
  const eventEntities = dedupe(allEntities.events);

  const placeGaps = [];
  const placeMatches = [];
  for (const e of placeEntities) {
    const m = matchPlace(e.name);
    if (m) placeMatches.push({ ...e, matchedName: m });
    else placeGaps.push(e);
  }

  const eventGaps = [];
  const eventMatches = [];
  for (const e of eventEntities) {
    const m = matchEvent(e.name);
    if (m) eventMatches.push({ ...e, matchedName: m });
    else eventGaps.push(e);
  }

  // ─── PHASE 7: Auto-append clearly structured coming-soon signals ────
  // Inspection records and Reddit posts are never treated as opening evidence.
  let appendedCount = 0;
  if (existsSync(ARTIFACTS.foodOpenings)) {
    try {
      const fo = JSON.parse(readFileSync(ARTIFACTS.foodOpenings, "utf8"));
      fo.opened = fo.opened || [];
      fo.inspections = fo.inspections || [];
      fo.comingSoon = fo.comingSoon || [];

      const restaurantPosts = enriched.filter(
        (p) => p.category === "restaurant_news" && p.relevance >= 7,
      );

      // Cross-source dedup by normalized name only — an SCC permit entry and
      // a Reddit post about the same restaurant must collide. Source URL was
      // a poor key (SCC entries have no source, so reddit dupes slipped in).
      const existingNames = new Set(
        [...fo.opened, ...fo.inspections, ...fo.comingSoon]
          .map((r) => normalizeName(r.name))
          .filter(Boolean),
      );

      for (const post of restaurantPosts) {
        // We only auto-add when the post title clearly names a restaurant + signal.
        // Confidence-validate via a quick Sonnet check; skip if unclear.
        const validatePrompt = `This Reddit post claims a South Bay restaurant or food business news. Decide if it should be auto-added to our food-openings tracker.

POST: r/${post.sub} — ${post.title}
${post.selftext ? `BODY: ${post.selftext.slice(0, 600)}` : ""}

Output JSON (no other text):
{
  "valid": <true|false — is this a real, specific South Bay food business with clear signal of opening / coming soon / closing>,
  "name": "<official business name, or empty string>",
  "city": "<South Bay city, or empty string>",
  "signal": "opened" | "comingSoon" | "closed" | "other",
  "blurb": "<one short sentence — what's happening>",
  "confidence": <integer 1-10>
}

Be strict. If this is a recommendation thread, a question, or general chat, valid=false. Only true for clear opening/closing/expansion announcements about a specific named place. Skip retail / non-food. confidence ≥8 means we'll auto-add.`;

        try {
          const raw = await callClaude(validatePrompt, 512);
          const v = parseJson(raw);
          if (
            v.valid &&
            v.confidence >= 8 &&
            v.name &&
            ["opened", "comingSoon"].includes(v.signal)
          ) {
            const normName = normalizeName(v.name);
            if (existingNames.has(normName)) continue;
            // A Reddit report can be a useful discovery signal, but it does
            // not establish the actual opening date. Keep it out of `opened`
            // until a separate first-party opening source is verified.
            if (v.signal === "opened") {
              console.log(`  ⊘ skipped [opened] ${v.name} — needs first-party opening source`);
              continue;
            }
            const cityResolved = resolveCity(v.city);
            if (!cityResolved) {
              console.log(`  ⊘ skipped [${v.signal}] ${v.name} — out-of-scope city "${v.city}"`);
              continue;
            }
            const status = "coming-soon";
            const entry = {
              id: `soon-reddit-${post.id}`,
              name: v.name,
              address: null,
              cityId: cityResolved.cityId,
              cityName: cityResolved.cityName,
              date: null,
              status,
              blurb: v.blurb || post.title,
              source: post.permalink,
              sourceLabel: `r/${post.sub}`,
              discoveredAt: new Date().toISOString(),
              discoveryMethod: "reddit-pulse",
            };
            fo.comingSoon.push(entry);
            existingNames.add(normName);
            appendedCount++;
            console.log(`  ➕ auto-added [${v.signal}] ${v.name} (${cityResolved.cityName})`);
          }
        } catch (err) {
          console.warn(`  ⚠️  validate fail for ${post.id}: ${err.message}`);
        }
      }

      if (appendedCount > 0) {
        fo.generatedAt = new Date().toISOString();
        writeFileAtomic(ARTIFACTS.foodOpenings, JSON.stringify(fo, null, 2) + "\n");
        console.log(`✅ Auto-appended ${appendedCount} coming-soon restaurant signals → scc-food-openings.json`);
      }
    } catch (err) {
      console.warn("auto-append failed:", err.message);
    }
  }

  // ─── PHASE 8: Write gaps file ───────────────────────────────────────
  const gapsOutput = {
    _meta: generatorMeta("generate-reddit-pulse", {
      sourceCount: minedPosts.length,
    }),
    summary: {
      threadsMined: minedPosts.length,
      placesExtracted: placeEntities.length,
      placesMatched: placeMatches.length,
      placeGaps: placeGaps.length,
      eventsExtracted: eventEntities.length,
      eventsMatched: eventMatches.length,
      eventGaps: eventGaps.length,
      autoAppendedOpenings: appendedCount,
    },
    placeGaps,
    eventGaps,
    placeMatches,
    eventMatches,
  };
  writeFileAtomic(GAPS_OUT, JSON.stringify(gapsOutput, null, 2) + "\n");
  console.log(`\n✅ Gaps: ${placeGaps.length} places + ${eventGaps.length} events → reddit-gaps.json`);
  placeGaps.slice(0, 15).forEach((g) => console.log(`   ⚠️  [place/${g.kind || "?"}] ${g.name}${g.city ? ` (${g.city})` : ""} — ${g.context || ""}`));
  if (eventGaps.length > 0) console.log("");
  eventGaps.slice(0, 10).forEach((g) => console.log(`   ⚠️  [event] ${g.name}${g.when ? ` — ${g.when}` : ""}`));
}

main().catch((err) => { console.error(err); process.exit(1); });
