#!/usr/bin/env node
/**
 * One-shot: backfill `topic` and `category` on existing reddit-image-cache.json
 * entries that pre-date the cache-fallback feature (PR #74). Without this,
 * the topic/category fallback has no historical entries to reuse and only
 * helps after ~30 days of natural cache turnover.
 *
 * Runs Sonnet in batches over the cached prompts. Cheap one-time cost.
 *
 * Run: node --env-file=.env.local scripts/backfill-reddit-image-cache-metadata.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvLocal } from "./lib/env.mjs";
import { callClaude as callClaudeApi } from "./lib/claude.mjs";
import { DATA_DIR } from "./lib/paths.mjs";
import { writeFileAtomic } from "./lib/io.mjs";

loadEnvLocal();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const IMAGE_CACHE_PATH = join(DATA_DIR, "reddit-image-cache.json");
const BATCH_SIZE = 60;

async function callClaude(prompt, maxTokens = 16384) {
  return callClaudeApi(prompt, { maxTokens, label: "reddit-image-cache" });
}

function parseJson(raw) {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```\s*$/, "")
    .trim();
  return JSON.parse(cleaned);
}

async function classifyBatch(entries) {
  const list = entries
    .map((e, i) => `${i + 1}. "${(e.prompt || "").slice(0, 250)}"`)
    .join("\n");

  const prompt = `Below are Recraft image prompts used for Reddit-discussion tiles on a South Bay (Silicon Valley) local site. For each prompt, infer:

- "category": one of "discussion", "news", "event", "restaurant_news", "sports". Choose the best fit. Use these heuristics:
   - speech bubbles, abstract dots, conversation imagery → discussion
   - balloons, confetti, festival, marquee → event
   - balls, jerseys, score graphics, motion lines → sports
   - food, plates, ingredients, restaurant scenes → restaurant_news
   - buildings, parks, infrastructure, vehicles, civic scenes → news
   - if unclear, use "discussion"

- "topic": a short kebab-case slug (3-6 words) describing the SUBJECT. Be specific (e.g. "san-jose-bagels", "earthquakes-good-season-run", "campbell-library-rebuild"). If the prompt is purely abstract/generic and there's no identifiable subject, return null.

Return ONLY a JSON array of objects: [{"i": 1, "category": "...", "topic": "..." | null}, ...]. No other text.

Prompts:
${list}`;

  const raw = await callClaude(prompt);
  return parseJson(raw);
}

async function main() {
  const cache = JSON.parse(readFileSync(IMAGE_CACHE_PATH, "utf8"));
  const ids = Object.keys(cache);
  const toClassify = ids.filter((id) => {
    const e = cache[id];
    return e?.prompt && !(e.topic && e.category);
  });

  console.log(`Cache has ${ids.length} entries. Need backfill: ${toClassify.length}.`);
  if (toClassify.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  let updated = 0;
  for (let i = 0; i < toClassify.length; i += BATCH_SIZE) {
    const batchIds = toClassify.slice(i, i + BATCH_SIZE);
    const batchEntries = batchIds.map((id) => cache[id]);
    console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toClassify.length / BATCH_SIZE)} (${batchEntries.length} prompts)…`);
    let result;
    try {
      result = await classifyBatch(batchEntries);
    } catch (err) {
      console.error(`  ✗ batch failed: ${err.message}`);
      continue;
    }
    for (const r of result) {
      const id = batchIds[r.i - 1];
      if (!id || !cache[id]) continue;
      cache[id].category = r.category || null;
      cache[id].topic = r.topic || null;
      updated++;
    }
    writeFileAtomic(IMAGE_CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
    console.log(`  ✓ wrote ${updated}/${toClassify.length} so far`);
  }

  console.log(`\n✅ Backfilled ${updated} entries.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
