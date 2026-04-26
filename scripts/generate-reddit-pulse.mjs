#!/usr/bin/env node
/**
 * generate-reddit-pulse.mjs
 *
 * Pulls top + recent posts from South Bay-relevant subreddits, classifies them
 * via Haiku, mines comments on high-signal threads for named places/events,
 * and writes:
 *
 *   reddit-pulse.json — curated "What the South Bay is Saying" feed for the homepage
 *   reddit-gaps.json  — places/events mentioned on Reddit that we don't have
 *
 * Also auto-appends high-confidence restaurant openings to scc-food-openings.json.
 *
 * Polite to Reddit: identified user-agent, 2s between requests, public .json
 * endpoints only (no auth required for read-only public listings).
 *
 * Run: node --env-file=.env.local scripts/generate-reddit-pulse.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { loadEnvLocal } from "./lib/env.mjs";
import { DATA_DIR, ARTIFACTS, generatorMeta } from "./lib/paths.mjs";
import { generateAndUpload } from "./social/lib/recraft.mjs";

loadEnvLocal();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const CLAUDE_HAIKU = "claude-haiku-4-5-20251001";
const USER_AGENT = "southbaytoday-pulse/1.0 (by /u/southbaytoday; https://southbaytoday.org)";
const REQUEST_DELAY_MS = 2000;

const PULSE_OUT = join(DATA_DIR, "reddit-pulse.json");
const GAPS_OUT  = join(DATA_DIR, "reddit-gaps.json");
const IMAGE_CACHE_PATH = join(DATA_DIR, "reddit-image-cache.json");

// Posts whose comments we mine for entities. Tunable — too high = slow + rate-limit risk.
const MAX_COMMENT_FETCHES = 14;
const TOP_COMMENTS_PER_POST = 30;

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
  { name: "SanJoseSharks",  weight: 0.7, scope: "sports" },
  { name: "sjearthquakes",  weight: 0.7, scope: "sports" },
];

// ─── Helpers ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRedditListing(sub, sort, params = "") {
  const url = `https://www.reddit.com/r/${sub}/${sort}.json?${params}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.status === 404 || res.status === 403) {
      console.log(`  ⤳ r/${sub} ${sort}: ${res.status} (skipped)`);
      return [];
    }
    if (!res.ok) {
      console.log(`  ⤳ r/${sub} ${sort}: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data?.data?.children?.map((c) => c.data) ?? [];
  } catch (err) {
    console.log(`  ⤳ r/${sub} ${sort}: ${err.message}`);
    return [];
  }
}

async function fetchPostComments(sub, postId, limit = 30) {
  const url = `https://www.reddit.com/r/${sub}/comments/${postId}.json?limit=${limit}&sort=top`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return [];
    const data = await res.json();
    const commentsListing = data?.[1]?.data?.children ?? [];
    return commentsListing
      .filter((c) => c.kind === "t1")
      .map((c) => ({
        body: c.data.body || "",
        score: c.data.score ?? 0,
        author: c.data.author,
      }))
      .filter((c) => c.body && c.body !== "[deleted]" && c.body !== "[removed]");
  } catch {
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

function normalizePost(p, weight, scope) {
  if (p.stickied) return null;
  if (p.removed_by_category) return null;
  if (p.author === "[deleted]") return null;
  if (p.over_18) return null;
  if (typeof p.title !== "string") return null;

  const ageHours = (Date.now() / 1000 - p.created_utc) / 3600;
  return {
    id: p.id,
    sub: p.subreddit,
    title: decodeHtmlEntities(p.title.trim()),
    selftext: decodeHtmlEntities((p.selftext || "").slice(0, 1200)),
    author: p.author,
    score: p.score ?? 0,
    numComments: p.num_comments ?? 0,
    createdUtc: p.created_utc,
    ageHours,
    permalink: `https://www.reddit.com${p.permalink}`,
    externalUrl: p.url_overridden_by_dest && p.url_overridden_by_dest !== p.url ? p.url_overridden_by_dest : (p.is_self ? null : p.url),
    isSelf: p.is_self,
    weight,
    scope,
  };
}

async function callClaude(prompt, maxTokens = 4096) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_HAIKU,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error: ${res.status} ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return data.content[0].text;
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
  console.log(`Fetching ${SUBS.length} subreddits…\n`);

  // ─── PHASE 1: Fetch posts from every sub ────────────────────────────
  const all = [];
  for (const sub of SUBS) {
    const topDay = await fetchRedditListing(sub.name, "top", "t=day&limit=25");
    await sleep(REQUEST_DELAY_MS);
    const newer = await fetchRedditListing(sub.name, "new", "limit=15");
    await sleep(REQUEST_DELAY_MS);

    const seen = new Set();
    const merged = [...topDay, ...newer].filter((p) => {
      if (!p?.id || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    const normalized = merged
      .map((p) => normalizePost(p, sub.weight, sub.scope))
      .filter(Boolean)
      .filter((p) => p.ageHours <= 96);

    console.log(`  ✓ r/${sub.name}: ${normalized.length} posts`);
    all.push(...normalized);
  }
  console.log(`\n${all.length} total posts.\n`);

  if (all.length === 0) {
    console.error("No posts fetched. Aborting.");
    process.exit(1);
  }

  const candidates = all
    .filter((p) => p.score >= 5 || p.numComments >= 3)
    .sort((a, b) => (b.score * b.weight) - (a.score * a.weight))
    .slice(0, 200);

  console.log(`${candidates.length} candidates passed engagement floor.\n`);

  // ─── PHASE 2: Classify with Haiku ───────────────────────────────────
  const list = candidates
    .map((p, i) => {
      const body = p.selftext ? ` — "${p.selftext.slice(0, 200).replace(/\n+/g, " ")}"` : "";
      return `${i + 1}. [r/${p.sub}, ↑${p.score}, ${p.numComments}c] ${p.title}${body}`;
    })
    .join("\n");

  const classifyPrompt = `You are curating Reddit posts for South Bay Today, a Silicon Valley local discovery site. The vibe is light, uplifting, locally-relevant. Cities we cover: San Jose, Sunnyvale, Palo Alto, Mountain View, Santa Clara, Cupertino, Los Gatos, Saratoga, Campbell, Milpitas. NOT covered: SF, Oakland, East Bay, North Bay, Peninsula north of Palo Alto, anything outside the Bay Area.

Here are ${candidates.length} Reddit posts:

${list}

For each post, output a JSON object with:
- "i": the 1-based index
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
  Vary palettes across posts so the grid feels colorful, not monochrome. Always end with "no text, no people, no logos".

Be strict on relevance. Crime/lawsuits/scary stuff = relevance 1-3 (we won't surface). Boring complaints = 1-3. A guy ranting about traffic = relevance 1. An MRI study recruitment = relevance 1. A new restaurant opening = relevance 9. A great rec thread = relevance 8.

Return ONLY a JSON array of objects, no other text.`;

  console.log("Classifying with Haiku…");
  let classified;
  let rawClassify;
  try {
    rawClassify = await callClaude(classifyPrompt, 16384);
    classified = parseJson(rawClassify);
  } catch (err) {
    console.error("Classify error:", err.message);
    console.error("Raw response head:", (rawClassify || "").slice(0, 300));
    console.error("Raw response tail:", (rawClassify || "").slice(-300));
    process.exit(1);
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
  const PER_SUB_CAP = 3;   // bumped from 2 to support 12 total
  const SPORTS_CAP = 2;    // bumped from 1 — at 12 total, 2 sports is fine

  const seenTopics = new Set();
  const subCounts = new Map();
  const seenIds = new Set();
  let sportsCount = 0;
  const pulse = [];
  for (const p of pulseEligible) {
    if (p.topic && seenTopics.has(p.topic)) continue;
    const n = subCounts.get(p.sub) ?? 0;
    if (n >= PER_SUB_CAP) continue;
    if (p.category === "sports" && sportsCount >= SPORTS_CAP) continue;
    pulse.push(p);
    seenIds.add(p.id);
    if (p.topic) seenTopics.add(p.topic);
    subCounts.set(p.sub, n + 1);
    if (p.category === "sports") sportsCount++;
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

  // ─── PHASE 3a: Light-touch title polish ─────────────────────────────
  // Fixes obvious grammar/punctuation/typo issues without touching Reddit voice.
  // One Haiku call for all 12 pulse titles; original `title` is preserved on
  // each post (for traceability) and `displayTitle` is what the UI renders.
  if (pulse.length > 0) {
    const titlesBlock = pulse
      .map((p, i) => `${i + 1}. ${p.title}`)
      .join("\n");
    const polishPrompt = `Below are Reddit post titles. Apply the LIGHTEST possible touch-up to each — fix things the OP themselves would fix on a re-read, and nothing more.

DO fix:
- Stray/wrong commas (e.g. "Bed Bath and Beyond will return, at Stanford" → drop the comma)
- Trailing periods on sentence fragments / phrases (e.g. "New Lakewood Park Library and Renovation." → drop the period)
- Doubled spaces, missing spaces around punctuation
- Obvious typos and missing words (e.g. "How many game are Drew" → "How many games are Drew")
- Stylized ALL CAPS in the middle of an otherwise sentence-cased title (e.g. "22 Events in SAN JOSE — Today APR 25, 2026" → "22 Events in San Jose — Today Apr 25, 2026")

DO NOT touch:
- Reddit voice: a title that's ALL CAPS as a whole, lots of exclamation points, emoji decoration, slang, "!!!!" — that's the OP's voice; leave it
- Meaning, structure, word order
- Names of places, people, things
- Quotes inside the title

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

  // ─── PHASE 3b: Generate Recraft images per post (cached) ────────────
  // Cache by post.id so a post that survives across runs reuses its image.
  // Generate in parallel — Recraft is async-friendly.
  let imageCache = {};
  if (existsSync(IMAGE_CACHE_PATH)) {
    try { imageCache = JSON.parse(readFileSync(IMAGE_CACHE_PATH, "utf8")); } catch {}
  }

  console.log(`Generating Recraft tiles for ${pulse.length} posts…`);
  // Serialize with a small delay — Recraft rate-limits parallel calls.
  const imageResults = [];
  for (const p of pulse) {
    const cached = imageCache[p.id];
    if (cached?.url) {
      imageResults.push({ id: p.id, url: cached.url });
      continue;
    }
    if (!p.imagePrompt) {
      imageResults.push({ id: p.id, url: null });
      continue;
    }

    const fullPrompt = `${p.imagePrompt}. Bold flat-color illustration. Vivid colors. Square 1:1 ratio. NO TEXT, no letters, no words, no people, no logos, no faces.`;

    let url = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await generateAndUpload({
          prompt: fullPrompt,
          pathname: `reddit-pulse/${p.id}.png`,
        });
        url = result.url;
        break;
      } catch (err) {
        const msg = err.message || "";
        if (msg.includes("429") && attempt < 2) {
          const wait = 4000 * (attempt + 1);
          console.warn(`  ⏳ tile r/${p.sub}/${p.id} rate-limited, waiting ${wait}ms…`);
          await sleep(wait);
          continue;
        }
        console.warn(`  ⚠️  tile r/${p.sub}/${p.id} failed: ${msg}`);
        break;
      }
    }

    if (url) {
      imageCache[p.id] = { url, prompt: p.imagePrompt, generatedAt: new Date().toISOString() };
      console.log(`  ✓ tile r/${p.sub}/${p.id}`);
    }
    imageResults.push({ id: p.id, url });
    await sleep(1500); // polite spacing between Recraft calls
  }
  const imageById = new Map(imageResults.map((r) => [r.id, r.url]));

  // Persist image cache (even on partial failure — we want successful URLs saved).
  writeFileSync(IMAGE_CACHE_PATH, JSON.stringify(imageCache, null, 2) + "\n");

  // Prune cache entries that haven't been seen in pulse for >30 days.
  // (Simple pruning: keep only ones referenced this run + recent ones.)
  const pulseIds = new Set(pulse.map((p) => p.id));
  const now = Date.now();
  const prunedCache = {};
  for (const [id, entry] of Object.entries(imageCache)) {
    const ageDays = (now - new Date(entry.generatedAt).getTime()) / 86400000;
    if (pulseIds.has(id) || ageDays < 30) prunedCache[id] = entry;
  }
  writeFileSync(IMAGE_CACHE_PATH, JSON.stringify(prunedCache, null, 2) + "\n");

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
  writeFileSync(PULSE_OUT, JSON.stringify(pulseOutput, null, 2) + "\n");
  console.log(`✅ ${pulse.length} pulse items → reddit-pulse.json`);

  // ─── PHASE 4: Comment mining for entity extraction ──────────────────
  // Pick the highest-relevance discussion/restaurant/event posts for deep mining.
  const miningCandidates = enriched
    .filter((p) => ["discussion", "restaurant_news", "event", "news"].includes(p.category))
    .filter((p) => p.relevance >= 6)
    .sort((a, b) => b.numComments + b.score - (a.numComments + a.score))
    .slice(0, MAX_COMMENT_FETCHES);

  console.log(`\nMining comments on ${miningCandidates.length} threads…`);
  const minedPosts = [];
  for (const post of miningCandidates) {
    const comments = await fetchPostComments(post.sub, post.id, TOP_COMMENTS_PER_POST);
    await sleep(REQUEST_DELAY_MS);
    const commentText = comments
      .slice(0, TOP_COMMENTS_PER_POST)
      .map((c) => c.body)
      .join("\n--\n")
      .slice(0, 4000);
    minedPosts.push({ ...post, commentText, commentCountFetched: comments.length });
    console.log(`  ✓ r/${post.sub}/${post.id}: ${comments.length} comments`);
  }

  // ─── PHASE 5: Extract named entities via Haiku ──────────────────────
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

  // scc-food-openings — REAL keys are opened + comingSoon
  if (existsSync(ARTIFACTS.foodOpenings)) {
    try {
      const fo = JSON.parse(readFileSync(ARTIFACTS.foodOpenings, "utf8"));
      for (const r of [...(fo.opened || []), ...(fo.comingSoon || [])]) {
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

  // ─── PHASE 7: Auto-append clearly structured restaurant openings ────
  // Conservative — only auto-add when category=restaurant_news AND signal is unambiguous.
  let appendedCount = 0;
  if (existsSync(ARTIFACTS.foodOpenings)) {
    try {
      const fo = JSON.parse(readFileSync(ARTIFACTS.foodOpenings, "utf8"));
      fo.opened = fo.opened || [];
      fo.comingSoon = fo.comingSoon || [];

      const restaurantPosts = enriched.filter(
        (p) => p.category === "restaurant_news" && p.relevance >= 7,
      );

      // Index already-known to avoid dupes — case-insensitive name+source match
      const existingKeys = new Set(
        [...fo.opened, ...fo.comingSoon].map((r) => `${normalizeName(r.name)}|${(r.source || "").trim()}`),
      );

      for (const post of restaurantPosts) {
        // We only auto-add when the post title clearly names a restaurant + signal.
        // Confidence-validate via a quick Haiku check; skip if unclear.
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
            const key = `${normalizeName(v.name)}|${post.permalink}`;
            if (!existingKeys.has(key)) {
              const entry = {
                name: v.name,
                city: v.city || "",
                blurb: v.blurb || post.title,
                source: post.permalink,
                sourceLabel: `r/${post.sub}`,
                discoveredAt: new Date().toISOString(),
                discoveryMethod: "reddit-pulse",
              };
              if (v.signal === "opened") fo.opened.push(entry);
              else fo.comingSoon.push(entry);
              existingKeys.add(key);
              appendedCount++;
              console.log(`  ➕ auto-added [${v.signal}] ${v.name} (${v.city})`);
            }
          }
        } catch (err) {
          console.warn(`  ⚠️  validate fail for ${post.id}: ${err.message}`);
        }
      }

      if (appendedCount > 0) {
        fo.generatedAt = new Date().toISOString();
        writeFileSync(ARTIFACTS.foodOpenings, JSON.stringify(fo, null, 2) + "\n");
        console.log(`✅ Auto-appended ${appendedCount} restaurant openings → scc-food-openings.json`);
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
  writeFileSync(GAPS_OUT, JSON.stringify(gapsOutput, null, 2) + "\n");
  console.log(`\n✅ Gaps: ${placeGaps.length} places + ${eventGaps.length} events → reddit-gaps.json`);
  placeGaps.slice(0, 15).forEach((g) => console.log(`   ⚠️  [place/${g.kind || "?"}] ${g.name}${g.city ? ` (${g.city})` : ""} — ${g.context || ""}`));
  if (eventGaps.length > 0) console.log("");
  eventGaps.slice(0, 10).forEach((g) => console.log(`   ⚠️  [event] ${g.name}${g.when ? ` — ${g.when}` : ""}`));
}

main().catch((err) => { console.error(err); process.exit(1); });
