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

// Discord DM channel (Stephen's DM channel with the bot)
const DM_CHANNEL = "1486102002474811524";
const BOT_TOKEN_FILE = "/Users/stephenstanwood/.claude/channels/discord/.env";

// Load env
try {
  const envPath = join(__dirname, "..", "..", ".env.local");
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

function loadBotToken() {
  try {
    const lines = readFileSync(BOT_TOKEN_FILE, "utf8").split("\n");
    for (const line of lines) {
      if (line.startsWith("DISCORD_BOT_TOKEN=")) {
        return line.slice("DISCORD_BOT_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
  return null;
}

// Two-tier monitoring:
//   PING_THRESHOLD — below this approved-unpublished count, DM Stephen
//   QUEUE_TARGET   — top up generation until reviewable hits this
// 80 is roughly where Stephen stops approving, 40 is when the queue feels thin.
const PING_THRESHOLD = 40;
const QUEUE_TARGET = 80;
const MIN_BATCH = 20;      // never generate fewer than this when topping up
const BUFFER = 5;          // overshoot the target by this much to absorb rejects

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
  const botToken = loadBotToken();
  if (!botToken) {
    console.error("No Discord bot token found — falling back to webhook");
    // Fallback to webhook if bot token unavailable
    if (process.env.DISCORD_WEBHOOK) {
      await fetch(process.env.DISCORD_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
    }
    return;
  }

  const res = await fetch(`https://discord.com/api/v10/channels/${DM_CHANNEL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bot ${botToken}`,
    },
    body: JSON.stringify({ content: message }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("Discord DM failed:", res.status, body);
  }
}

async function main() {
  const queue = loadQueue();
  const pendingDrafts = countPendingDrafts();
  const now = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "short", timeStyle: "short" });

  const reviewable = queue.length + pendingDrafts;
  console.log(`[${now}] Approved unpublished: ${queue.length} | Drafts to review: ${pendingDrafts} | Total reviewable: ${reviewable} (target ${QUEUE_TARGET})`);

  // Always check for SV History milestones (date-sensitive, runs regardless of queue health)
  console.log("Checking for SV History milestones...");
  try {
    const nodePath = process.execPath;
    const envFile = join(__dirname, "..", "..", ".env.local");
    execFileSync(nodePath, ["--env-file=" + envFile, join(__dirname, "generate-sv-history.mjs")], {
      cwd: join(__dirname, "..", ".."),
      timeout: 120_000,
      stdio: "inherit",
    });
  } catch (err) {
    console.error("SV History generation failed:", err.message);
  }

  // Top up if total reviewable is below target.
  if (reviewable < QUEUE_TARGET) {
    const deficit = QUEUE_TARGET - reviewable + BUFFER;
    const batchSize = Math.max(MIN_BATCH, deficit);

    console.log(`Generating ${batchSize} new drafts to close deficit of ${deficit}...`);
    try {
      const nodePath = process.execPath;
      const envFile = join(__dirname, "..", "..", ".env.local");
      execFileSync(nodePath, ["--env-file=" + envFile, join(__dirname, "generate-posts.mjs"), "--max", String(batchSize)], {
        cwd: join(__dirname, "..", ".."),
        timeout: 600_000,
        stdio: "inherit",
      });
    } catch (err) {
      console.error("Generation failed:", err.message);
    }
  } else {
    console.log("Queue is healthy, no top-up needed.");
  }

  const newDraftCount = countPendingDrafts();
  const newQueue = loadQueue();
  const newReviewable = newQueue.length + newDraftCount;

  // Only DM Stephen if approved-unpublished is below the ping threshold.
  if (newQueue.length >= PING_THRESHOLD) {
    console.log(`Approved unpublished ${newQueue.length} ≥ ping threshold ${PING_THRESHOLD} — skipping DM.`);
    return;
  }

  const msg = `📬 **South Bay Today — Queue Low**\n` +
    `Approved unpublished: **${newQueue.length}** (ping at <${PING_THRESHOLD})\n` +
    `Drafts to review: **${newDraftCount}**\n` +
    `Total reviewable: **${newReviewable}** (target ${QUEUE_TARGET})\n\n` +
    `Swiper: http://10.0.0.234:3456 (or Tailscale: http://100.117.24.89:3456)`;

  console.log("Sending Discord DM...");
  await sendDiscordDM(msg);
  console.log("Done.");
}

main().catch(console.error);
