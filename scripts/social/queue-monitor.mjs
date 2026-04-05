#!/usr/bin/env node
// ---------------------------------------------------------------------------
// South Bay Signal — Queue Monitor
// Checks approved queue size. If under threshold:
//   1. Generates new drafts if needed
//   2. DMs Stephen on Discord
// Run via launchd on a schedule.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-approved-queue.json");
const POST_DIR = "/tmp/sbs-social";
const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1488592203251978271/Qf_2sPiCbbuQLnmn6AcSXmD7OfTQbbkKo2J-4K2FiASnQ-F3G0W71bfGwtJqfCKYrklz";
const QUEUE_THRESHOLD = 40;
const GENERATE_BATCH = 25;

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    const q = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    // Only count unpublished items
    return q.filter((p) => !p.published);
  } catch {
    return [];
  }
}

function countPendingDrafts() {
  if (!existsSync(POST_DIR)) return 0;
  return readdirSync(POST_DIR).filter((f) => f.startsWith("post-") && f.endsWith(".json")).length;
}

async function sendDiscordDM(message) {
  const payload = { content: message };
  const res = await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error("Discord webhook failed:", res.status);
  }
}

async function main() {
  const queue = loadQueue();
  const pendingDrafts = countPendingDrafts();
  const now = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "short", timeStyle: "short" });

  console.log(`[${now}] Queue: ${queue.length} approved (unpublished) | Drafts pending: ${pendingDrafts}`);

  if (queue.length >= QUEUE_THRESHOLD) {
    console.log("Queue is healthy, no action needed.");
    return;
  }

  // Queue is low — generate drafts if we don't already have some waiting
  if (pendingDrafts < 10) {
    console.log(`Generating ${GENERATE_BATCH} new drafts...`);
    try {
      const nodePath = process.execPath;
      const envFile = join(__dirname, "..", "..", ".env.local");
      execFileSync(nodePath, ["--env-file=" + envFile, join(__dirname, "generate-posts.mjs"), "--max", String(GENERATE_BATCH)], {
        cwd: join(__dirname, "..", ".."),
        timeout: 300_000,
        stdio: "inherit",
      });
    } catch (err) {
      console.error("Generation failed:", err.message);
    }
  }

  const newDraftCount = countPendingDrafts();

  // DM Stephen
  const msg = `📬 **The South Bay Signal — Queue Check**\n` +
    `Approved queue: **${queue.length}** (threshold: ${QUEUE_THRESHOLD})\n` +
    `Drafts ready to review: **${newDraftCount}**\n\n` +
    `Swiper: http://10.0.0.234:3456 (or Tailscale: http://100.117.24.89:3456)`;

  console.log("Sending Discord DM...");
  await sendDiscordDM(msg);
  console.log("Done.");
}

main().catch(console.error);
