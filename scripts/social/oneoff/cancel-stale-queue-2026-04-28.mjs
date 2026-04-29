#!/usr/bin/env node
// One-off (2026-04-28): Stephen flagged the queue as stale.
//   1) Delete the just-published Hey Balloon Lady post on x/bluesky/threads/facebook
//   2) Cancel the 22 unpublished "single" posts approved 2.5 weeks ago so
//      publish-from-queue won't drain them.
//
// Future day-plan / tonight-pick slots in social-schedule.json are NOT touched —
// those are the legitimate morning + noon cadence and regenerate weekly.
//
// Usage: node scripts/social/oneoff/cancel-stale-queue-2026-04-28.mjs [--dry-run]

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE = join(__dirname, "..", "..", "..", "src", "data", "south-bay", "social-approved-queue.json");

if (!process.env.X_API_KEY) {
  try {
    const lines = readFileSync(join(__dirname, "..", "..", "..", ".env.local"), "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const dryRun = process.argv.includes("--dry-run");

const x = await import("../lib/platforms/x.mjs");
const bluesky = await import("../lib/platforms/bluesky.mjs");
const threads = await import("../lib/platforms/threads.mjs");
const facebook = await import("../lib/platforms/facebook.mjs");
const mastodon = await import("../lib/platforms/mastodon.mjs");
const instagram = await import("../lib/platforms/instagram.mjs");

const queue = JSON.parse(readFileSync(QUEUE, "utf8"));

// ── Step 1: delete the Hey Balloon Lady post ───────────────────────────────
const balloonIdx = queue.findIndex(
  (e) => e.targetUrl === "https://southbaytoday.org/plan/aaf7ffab" && e.published
);
if (balloonIdx === -1) {
  console.log("⚠️  Hey Balloon Lady post not found — skipping deletion");
} else {
  const entry = queue[balloonIdx];
  console.log(`\n── Deleting: ${entry.item?.title || "(no title)"} (idx ${balloonIdx})`);
  console.log(`   publishedAt: ${entry.publishedAt}`);

  for (const p of entry.publishedTo || []) {
    if (!p.ok) continue;
    const id = p.postId || p.id || p.uri;
    if (!id) continue;
    const platform = p.platform;

    if (dryRun) {
      console.log(`   [dry] would delete ${platform}: ${id.slice(0, 60)}`);
      continue;
    }

    try {
      let client;
      if (platform === "x") client = x;
      else if (platform === "bluesky") client = bluesky;
      else if (platform === "threads") client = threads;
      else if (platform === "facebook") client = facebook;
      else if (platform === "mastodon") client = mastodon;
      else if (platform === "instagram") client = instagram;
      else {
        console.log(`   ? unknown platform ${platform}`);
        continue;
      }
      await client.deletePost(id);
      console.log(`   ✓ ${platform}: deleted`);
      p.deleted = true;
      p.deletedAt = new Date().toISOString();
    } catch (err) {
      console.error(`   ✗ ${platform}: ${(err.message || String(err)).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!dryRun) {
    entry.deletedAt = new Date().toISOString();
    entry.deletedReason = "stephen-flagged-stale-queue";
  }
}

// ── Step 2: cancel all unpublished items in queue ──────────────────────────
const unpublished = queue.filter((p) => !p.published);
console.log(`\n── Cancelling ${unpublished.length} unpublished queue items`);
for (const p of unpublished) {
  const title = p.item?.title || "(no title)";
  const eventDate = p.item?.date || p.date || "?";
  console.log(`   - ${eventDate} | ${title.slice(0, 70)}`);
  if (!dryRun) {
    p.published = true;
    p.publishedAt = new Date().toISOString();
    p.publishResult = "cancelled-stale";
    p.cancelledReason = "stephen-flagged-stale-queue-2026-04-28";
  }
}

// ── Save ───────────────────────────────────────────────────────────────────
if (!dryRun) {
  writeFileSync(QUEUE, JSON.stringify(queue, null, 2));
  console.log(`\n✓ Saved queue (${queue.length} entries)`);
} else {
  console.log(`\n[dry-run] no writes`);
}
