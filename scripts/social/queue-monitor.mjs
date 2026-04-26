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
const SCHEDULE_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-schedule.json");
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

// Generation moved entirely to the weekly Saturday 3:30 AM `generate-schedule.mjs`
// run (10-day horizon). Queue-monitor's only job now is to ping when the
// approved-unpublished count drops below this floor.
const PING_THRESHOLD = 40;

// Walk the 10-day schedule once and bucket future slots:
//   needsReview — still missing copy or image approval (the swiper queue)
//   approved    — both approved, not yet published (sits waiting for a publish slot)
function readScheduleBuckets() {
  let needsReview = 0;
  let approved = 0;
  if (!existsSync(SCHEDULE_FILE)) return { needsReview, approved };
  try {
    const sched = JSON.parse(readFileSync(SCHEDULE_FILE, "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    for (const [date, day] of Object.entries(sched.days || {})) {
      if (date < today) continue;
      for (const slot of Object.values(day)) {
        if (!slot || typeof slot !== "object") continue;
        if (slot.status === "rejected" || slot.status === "published") continue;
        const fullyApproved = slot.copyApprovedAt && slot.imageApprovedAt;
        if (fullyApproved) approved++;
        else needsReview++;
      }
    }
  } catch {}
  return { needsReview, approved };
}

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    const q = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    return q.filter((p) => !p.published);
  } catch {
    return [];
  }
}

// "Approved unpublished" = legacy queue items + schedule slots fully approved.
// publish-from-queue.mjs publishes from both sources (schedule first, then legacy queue).
function countApprovedUnpublished() {
  return loadQueue().length + readScheduleBuckets().approved;
}

// "Drafts to review" = anything still in front of the swiper.
//   - legacy /tmp/sbs-social/post-*.json from generate-posts.mjs
//   - schedule slots where copy or image still need approval
function countPendingDrafts() {
  let legacy = 0;
  if (existsSync(POST_DIR)) {
    legacy = readdirSync(POST_DIR).filter((f) => f.startsWith("post-") && f.endsWith(".json")).length;
  }
  return legacy + readScheduleBuckets().needsReview;
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
  const approvedUnpublished = countApprovedUnpublished();
  const pendingDrafts = countPendingDrafts();
  const now = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "short", timeStyle: "short" });

  console.log(`[${now}] Approved unpublished: ${approvedUnpublished} | Drafts to review: ${pendingDrafts}`);

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

  if (approvedUnpublished >= PING_THRESHOLD) {
    console.log(`Approved unpublished ${approvedUnpublished} ≥ ping threshold ${PING_THRESHOLD} — skipping DM.`);
    return;
  }

  const msg = `📬 **South Bay Today — Queue Low**\n` +
    `Approved unpublished: **${approvedUnpublished}** (ping at <${PING_THRESHOLD})\n` +
    `Drafts to review: **${pendingDrafts}**\n\n` +
    `Swiper: http://10.0.0.234:3456 (or Tailscale: http://100.117.24.89:3456)`;

  console.log("Sending Discord DM...");
  await sendDiscordDM(msg);
  console.log("Done.");
}

main().catch(console.error);
