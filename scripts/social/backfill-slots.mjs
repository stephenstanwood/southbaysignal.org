#!/usr/bin/env node
// Backfill scheduledSlot for approved, unpublished posts that don't have one.
// Run once after adding slot-scheduler to the pipeline. Safe to re-run —
// only assigns slots to posts missing one.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assignSlot } from "./lib/slot-scheduler.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-approved-queue.json");

const raw = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
const queue = Array.isArray(raw) ? raw : raw.posts || [];

const unpub = queue.filter((p) => !p.published);
const missing = unpub.filter((p) => !p.scheduledSlot);

console.log(`Queue: ${queue.length} total, ${unpub.length} unpublished, ${missing.length} missing slot`);

let assigned = 0;
let skipped = 0;
for (const post of missing) {
  const slot = assignSlot(post, queue);
  if (slot) {
    post.scheduledSlot = slot;
    assigned += 1;
    const title = post.item?.title || "(unknown)";
    console.log(`  ✅ ${slot.date} @ ${slot.time}${slot.fallback ? " (fallback)" : ""} — ${title.slice(0, 60)}`);
  } else {
    skipped += 1;
    const title = post.item?.title || "(unknown)";
    const evDate = post.item?.date || post.date || "(no date)";
    console.log(`  ⏭️  no slot — ${title.slice(0, 60)} (event: ${evDate})`);
  }
}

console.log(`\nDone: assigned ${assigned}, skipped ${skipped}`);

if (assigned > 0) {
  const out = Array.isArray(raw) ? queue : { ...raw, posts: queue };
  writeFileSync(QUEUE_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${QUEUE_FILE}`);
}
