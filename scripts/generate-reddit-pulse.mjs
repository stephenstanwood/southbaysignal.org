#!/usr/bin/env node
/**
 * generate-reddit-pulse.mjs
 *
 * Pulls top + recent posts from South Bay-relevant subreddits, classifies them
 * via Haiku, and writes two artifacts:
 *
 *   reddit-pulse.json — curated "What the South Bay is Saying" feed for the homepage
 *   reddit-gaps.json  — events/restaurant openings mentioned on Reddit that we don't have
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

// ─── Subreddit list ───────────────────────────────────────────────────
// Mix of city/regional subs. Some may 404 — handled gracefully.
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

function normalizePost(p, weight, scope) {
  // Filter junk early.
  if (p.stickied) return null;
  if (p.removed_by_category) return null;
  if (p.author === "[deleted]") return null;
  if (p.over_18) return null;
  if (typeof p.title !== "string") return null;

  const ageHours = (Date.now() / 1000 - p.created_utc) / 3600;
  return {
    id: p.id,
    sub: p.subreddit,
    title: p.title.trim(),
    selftext: (p.selftext || "").slice(0, 800),
    author: p.author,
    score: p.score ?? 0,
    numComments: p.num_comments ?? 0,
    createdUtc: p.created_utc,
    ageHours,
    permalink: `https://www.reddit.com${p.permalink}`,
    externalUrl: p.url_overridden_by_dest && p.url_overridden_by_dest !== p.url ? p.url_overridden_by_dest : (p.is_self ? null : p.url),
    thumbnail: p.thumbnail && p.thumbnail.startsWith("http") ? p.thumbnail : null,
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

function parseJsonArray(raw) {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("No JSON array in response");
  return JSON.parse(match[0]);
}

// Lightweight token-overlap similarity for cross-ref against our event/restaurant data.
// Not perfect but catches the obvious "we already have this" cases.
function tokenize(s) {
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );
}

function similarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.min(ta.size, tb.size);
}

function alreadyKnown(redditTitle, knownTitles) {
  for (const t of knownTitles) {
    if (similarity(redditTitle, t) >= 0.5) return true;
  }
  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching ${SUBS.length} subreddits…\n`);

  const all = [];

  for (const sub of SUBS) {
    // top of day (high-signal recent), plus new (very fresh items)
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
      .filter((p) => p.ageHours <= 96); // last 4 days only

    console.log(`  ✓ r/${sub.name}: ${normalized.length} posts`);
    all.push(...normalized);
  }

  console.log(`\n${all.length} total posts after filtering.\n`);

  if (all.length === 0) {
    console.error("No posts fetched. Aborting (not overwriting existing files).");
    process.exit(1);
  }

  // ─── Score-prefilter to keep the Haiku batch small ──────────────────
  // We send all the high-engagement posts but cap at 200 to keep the prompt
  // reasonable. A floor on score keeps obvious low-effort posts out.
  const candidates = all
    .filter((p) => p.score >= 5 || p.numComments >= 3)
    .sort((a, b) => (b.score * b.weight) - (a.score * a.weight))
    .slice(0, 200);

  console.log(`${candidates.length} candidates passed engagement floor.\n`);

  // ─── Classify with Haiku ────────────────────────────────────────────
  const list = candidates
    .map((p, i) => {
      const body = p.selftext ? ` — "${p.selftext.slice(0, 200).replace(/\n+/g, " ")}"` : "";
      return `${i + 1}. [r/${p.sub}, ↑${p.score}, ${p.numComments}c] ${p.title}${body}`;
    })
    .join("\n");

  const classifyPrompt = `You are curating Reddit posts for a South Bay (Silicon Valley) local news/discovery site. Cities we cover: San Jose, Sunnyvale, Palo Alto, Mountain View, Santa Clara, Cupertino, Los Gatos, Saratoga, Campbell, Milpitas. NOT covered: SF, Oakland, East Bay, North Bay, Peninsula north of Palo Alto, anything outside the Bay Area.

Here are ${candidates.length} Reddit posts:

${list}

For each post, output a JSON object with:
- "i": the 1-based index
- "category": one of:
    "event"            — a specific upcoming event or recurring activity (concert, festival, run, market, class)
    "restaurant_news"  — restaurant opening, closing, new location, expansion, or strong recommendation
    "discussion"       — interesting local Q&A, recommendations thread, "best X in city Y", neighborhood chatter
    "news"             — local news worth knowing (development, transit, civic happenings)
    "personal"         — someone's personal post, lost-and-found, complaint, rant, "is it safe", venting
    "political"        — politics, elections, partisan content
    "out_of_area"      — about SF, East Bay, Peninsula north of PA, or non-Bay
    "noise"            — memes, low-effort, NSFW-adjacent, scams, surveys, study recruitment
- "relevance": integer 1-10 — how relevant + interesting to South Bay residents (10 = must-see, 1 = skip)
- "summary": one short sentence (under 25 words) — what the post is actually about, in plain English. Skip the "OP asks…" framing; just state the topic.

Be strict. "Best burrito in San Jose" is "discussion" relevance 8. A guy ranting about traffic on 101 is "personal" relevance 2. An MRI study recruitment flyer is "noise" relevance 1. A new restaurant opening is "restaurant_news" relevance 9.

Return ONLY a JSON array of objects, no other text.`;

  console.log("Classifying with Haiku…");
  let classified;
  try {
    const raw = await callClaude(classifyPrompt, 8192);
    classified = parseJsonArray(raw);
  } catch (err) {
    console.error("Classify error:", err.message);
    process.exit(1);
  }

  // Index classified results back onto candidates
  const enriched = candidates.map((c, i) => {
    const cls = classified.find((x) => x.i === i + 1);
    return cls
      ? { ...c, category: cls.category, relevance: cls.relevance, summary: cls.summary }
      : { ...c, category: "noise", relevance: 0, summary: c.title };
  });

  console.log(`${enriched.length} classified.\n`);

  // ─── PULSE FILE: high-relevance, non-junk, recent ───────────────────
  const pulseEligible = enriched
    .filter((p) => ["discussion", "news", "event", "restaurant_news"].includes(p.category))
    .filter((p) => p.relevance >= 6)
    .filter((p) => p.ageHours <= 72)
    .sort((a, b) => {
      // Score: relevance * weight + engagement bonus, slight recency boost.
      const sa = a.relevance * a.weight + Math.min(a.score / 50, 2) + (24 - Math.min(a.ageHours, 24)) / 48;
      const sb = b.relevance * b.weight + Math.min(b.score / 50, 2) + (24 - Math.min(b.ageHours, 24)) / 48;
      return sb - sa;
    });

  // Sub-cap: max 2 from any single sub so a hot day in r/SanJose doesn't dominate.
  const subCounts = new Map();
  const pulse = [];
  for (const p of pulseEligible) {
    const n = subCounts.get(p.sub) ?? 0;
    if (n >= 2) continue;
    pulse.push(p);
    subCounts.set(p.sub, n + 1);
    if (pulse.length >= 8) break;
  }

  const pulseOutput = {
    _meta: generatorMeta("generate-reddit-pulse", {
      sourceCount: SUBS.length,
      sources: SUBS.map((s) => `r/${s.name}`),
    }),
    posts: pulse.map((p) => ({
      id: p.id,
      sub: p.sub,
      title: p.title,
      summary: p.summary,
      category: p.category,
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
  pulse.forEach((p) => console.log(`   • [r/${p.sub}] ${p.title}`));

  // ─── GAPS FILE: events / restaurant_news we don't already have ──────
  const knownEventTitles = [];
  const knownRestaurantTitles = [];

  if (existsSync(ARTIFACTS.events)) {
    try {
      const ev = JSON.parse(readFileSync(ARTIFACTS.events, "utf8"));
      for (const e of (ev.events || [])) knownEventTitles.push(e.title || "");
    } catch {}
  }
  if (existsSync(ARTIFACTS.foodOpenings)) {
    try {
      const fo = JSON.parse(readFileSync(ARTIFACTS.foodOpenings, "utf8"));
      for (const r of (fo.openings || fo.restaurants || [])) knownRestaurantTitles.push(r.name || r.title || "");
    } catch {}
  }
  if (existsSync(ARTIFACTS.restaurantRadar)) {
    try {
      const rr = JSON.parse(readFileSync(ARTIFACTS.restaurantRadar, "utf8"));
      for (const r of (rr.restaurants || rr.items || [])) knownRestaurantTitles.push(r.name || r.title || "");
    } catch {}
  }

  const gapCandidates = enriched.filter(
    (p) => (p.category === "event" || p.category === "restaurant_news") && p.relevance >= 6,
  );

  const gaps = gapCandidates.map((p) => {
    const known = p.category === "restaurant_news"
      ? alreadyKnown(p.title, knownRestaurantTitles)
      : alreadyKnown(p.title, knownEventTitles);
    return {
      id: p.id,
      sub: p.sub,
      title: p.title,
      summary: p.summary,
      category: p.category,
      score: p.score,
      numComments: p.numComments,
      ageHours: Math.round(p.ageHours * 10) / 10,
      permalink: p.permalink,
      externalUrl: p.externalUrl,
      alreadyInOurData: known,
    };
  });

  const gapsOnly = gaps.filter((g) => !g.alreadyInOurData);

  const gapsOutput = {
    _meta: generatorMeta("generate-reddit-pulse", { sourceCount: gapCandidates.length }),
    summary: {
      totalCandidates: gapCandidates.length,
      alreadyKnown: gaps.length - gapsOnly.length,
      potentialGaps: gapsOnly.length,
    },
    gaps: gapsOnly,
    matched: gaps.filter((g) => g.alreadyInOurData),
  };
  writeFileSync(GAPS_OUT, JSON.stringify(gapsOutput, null, 2) + "\n");
  console.log(`\n✅ ${gapsOnly.length} potential gaps (of ${gapCandidates.length} event/restaurant candidates) → reddit-gaps.json`);
  gapsOnly.slice(0, 10).forEach((g) => console.log(`   ⚠️  [${g.category}] ${g.title} — ${g.permalink}`));
}

main().catch((err) => { console.error(err); process.exit(1); });
