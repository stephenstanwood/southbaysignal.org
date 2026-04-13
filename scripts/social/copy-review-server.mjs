#!/usr/bin/env node
// ---------------------------------------------------------------------------
// South Bay Signal — Social Copy Review Server
// Shows all 4 platform variants per item, with comment box for feedback.
// Approved posts go to the ready queue, not published immediately.
// Auto-regenerates next batch when current batch is finished.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { processComment } from "./lib/action-commands.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3456;
const POST_DIR = "/tmp/sbs-social";
const QUEUE_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-approved-queue.json");
const REVIEW_HISTORY_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-review-history.json");
const REPLIES_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-replies.json");
const SCHEDULE_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-schedule.json");
const GENERATE_SCRIPT = join(__dirname, "generate-posts.mjs");
const ENV_FILE = join(__dirname, "..", "..", ".env.local");
const BATCH_SIZE = 25;

let isGenerating = false;

// Load all pending post JSONs from /tmp/sbs-social/
function loadPendingPosts() {
  if (!existsSync(POST_DIR)) return [];
  const files = readdirSync(POST_DIR)
    .filter((f) => f.startsWith("post-") && f.endsWith(".json"))
    .sort();
  const posts = files.map((f) => {
    try {
      const data = JSON.parse(readFileSync(join(POST_DIR, f), "utf8"));
      data._file = f;
      return data;
    } catch {
      return null;
    }
  }).filter(Boolean);
  // Sort by event date/time ascending (soonest first)
  posts.sort((a, b) => {
    const dateA = a.item?.date || "9999";
    const dateB = b.item?.date || "9999";
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    const timeA = a.item?.time || "99:99";
    const timeB = b.item?.time || "99:99";
    return timeA.localeCompare(timeB);
  });
  return posts;
}

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  const dir = dirname(QUEUE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");
}

function loadReplies() {
  if (!existsSync(REPLIES_FILE)) return [];
  try {
    return JSON.parse(readFileSync(REPLIES_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveReplies(replies) {
  const dir = dirname(REPLIES_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(REPLIES_FILE, JSON.stringify(replies, null, 2) + "\n");
}

function loadSchedule() {
  if (!existsSync(SCHEDULE_FILE)) return { days: {} };
  try { return JSON.parse(readFileSync(SCHEDULE_FILE, "utf8")); } catch { return { days: {} }; }
}

function saveScheduleFile(schedule) {
  writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2) + "\n");
}

// Rewrite all platform copy variants based on edit instructions
async function rewriteCopyWithEdits(originalCopy, editInstructions, item) {
  // Load env for API key
  let apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    try {
      const lines = readFileSync(ENV_FILE, "utf8").split("\n");
      for (const line of lines) {
        const m = line.match(/^ANTHROPIC_API_KEY=(.*)$/);
        if (m) apiKey = m[1].replace(/^["']|["']$/g, "");
      }
    } catch {}
  }
  if (!apiKey) throw new Error("No ANTHROPIC_API_KEY for edit rewrite");

  const prompt = `You are editing social media posts for South Bay Today, a hyperlocal community tool for the South Bay.

ORIGINAL COPY (per platform):
X: ${originalCopy.x || "(none)"}
Threads: ${originalCopy.threads || "(none)"}
Bluesky: ${originalCopy.bluesky || "(none)"}
Facebook: ${originalCopy.facebook || "(none)"}
Instagram: ${originalCopy.instagram || "(none)"}

EDIT INSTRUCTIONS FROM REVIEWER:
${editInstructions}

Apply the edit instructions to ALL platform variants. Preserve the existing tone, URLs, hashtags, and @mentions. Respect platform character limits:
- X: max 280 chars
- Threads: max 500 chars
- Bluesky: max 300 chars
- Facebook: max 500 chars
- Instagram: max 2200 chars

If the edit only affects wording/phrasing, apply it consistently across all variants.
If the edit adds/removes information, adjust each variant appropriately for its platform constraints.
Keep URLs exactly as they are — never change or remove them.

Return ONLY a JSON object with keys "x", "threads", "bluesky", "facebook", "instagram" — each a string. No other text.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to extract JSON from edit rewrite response");

  const rewritten = JSON.parse(jsonMatch[0]);

  // Mastodon reuses Bluesky copy
  rewritten.mastodon = rewritten.bluesky || originalCopy.mastodon;

  // Fallback: keep originals for any missing platform
  for (const key of Object.keys(originalCopy)) {
    if (!rewritten[key]) rewritten[key] = originalCopy[key];
  }

  return rewritten;
}

// Clear old post files and generate a new batch
function generateNewBatch() {
  if (isGenerating) return;
  isGenerating = true;
  console.log(`\n🔄 Generating next batch of ${BATCH_SIZE} posts...`);

  // Clear old post files (preserve sv-history and restaurant posts — they have their own dedup)
  if (existsSync(POST_DIR)) {
    for (const f of readdirSync(POST_DIR)) {
      if (f.startsWith("post-") && f.endsWith(".json") && !f.includes("-sv-history-") && !f.includes("-restaurant-")) {
        unlinkSync(join(POST_DIR, f));
      }
    }
  }

  const nodePath = process.execPath;

  // Generate sv-history posts first (quick — only produces output on anniversary dates)
  try {
    execFileSync(nodePath, ["--env-file=" + ENV_FILE, join(__dirname, "generate-sv-history.mjs")], {
      cwd: join(__dirname, "..", ".."),
      timeout: 120_000,
      stdio: "inherit",
    });
  } catch (err) {
    console.error("SV History generation failed:", err.message);
  }

  // Generate restaurant opening posts (quick — only produces output for new openings)
  try {
    execFileSync(nodePath, ["--env-file=" + ENV_FILE, join(__dirname, "generate-restaurant-openings.mjs")], {
      cwd: join(__dirname, "..", ".."),
      timeout: 120_000,
      stdio: "inherit",
    });
  } catch (err) {
    console.error("Restaurant opening generation failed:", err.message);
  }

  execFile(nodePath, ["--env-file=" + ENV_FILE, GENERATE_SCRIPT, "--max", String(BATCH_SIZE)], {
    cwd: join(__dirname, "..", ".."),
    timeout: 300_000,
  }, (err, stdout, stderr) => {
    isGenerating = false;
    if (err) {
      console.error("Generation failed:", err.message);
      if (stderr) console.error(stderr);
      return;
    }
    console.log(stdout);
    const posts = loadPendingPosts();
    console.log(`✅ ${posts.length} new drafts ready for review`);
  });
}

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SBT Social Review</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #FAF9F6;
    color: #1A1A1A;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-height: 100vh;
    padding: 32px 20px;
  }
  h1 {
    font-size: 13px;
    letter-spacing: 4px;
    text-transform: uppercase;
    color: #888;
    margin-bottom: 4px;
  }

  /* Tab navigation */
  .tab-bar {
    display: flex;
    gap: 0;
    max-width: 640px;
    width: 100%;
    margin-bottom: 20px;
    border: 1px solid #E5E2DB;
    border-radius: 8px;
    overflow: hidden;
  }
  .tab-btn {
    flex: 1;
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    border: none;
    cursor: pointer;
    background: #fff;
    color: #888;
    transition: background 0.15s, color 0.15s;
  }
  .tab-btn:not(:last-child) { border-right: 1px solid #E5E2DB; }
  .tab-btn.active {
    background: #1a1a1a;
    color: #faf9f6;
  }
  .tab-btn:not(.active):hover { background: #f0efec; }
  .tab-count {
    font-size: 12px;
    font-weight: 400;
    opacity: 0.7;
  }

  .counter {
    font-size: 13px;
    color: #aaa;
    margin-bottom: 8px;
  }
  .queue-badge {
    display: inline-block;
    background: #2c6b4f;
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    padding: 4px 12px;
    border-radius: 12px;
    margin-bottom: 16px;
  }
  .queue-badge.low { background: #c0392b; }
  .queue-badge.mid { background: #e6a817; }
  .shortcuts {
    font-size: 12px;
    color: #aaa;
    margin-bottom: 20px;
  }
  kbd {
    display: inline-block;
    background: #eee;
    border: 1px solid #ddd;
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 12px;
    margin: 0 2px;
  }

  .item-header {
    max-width: 640px;
    width: 100%;
    margin-bottom: 16px;
  }
  .item-title {
    font-size: 18px;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .item-meta {
    font-size: 13px;
    color: #888;
    margin-bottom: 4px;
  }
  .item-url {
    font-size: 12px;
    color: #1d9bf0;
    word-break: break-all;
  }
  .item-url a { color: #1d9bf0; text-decoration: none; }

  .platforms {
    max-width: 640px;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 16px;
    transition: transform 0.3s, opacity 0.3s;
  }
  .platforms.swipe-left { transform: translateX(-120%) rotate(-4deg); opacity: 0; }
  .platforms.swipe-right { transform: translateX(120%) rotate(4deg); opacity: 0; }
  .platform-card {
    background: #fff;
    border: 1px solid #E5E2DB;
    border-radius: 8px;
    padding: 16px 20px;
  }
  .platform-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .platform-label.x { color: #1A1A1A; }
  .platform-label.threads { color: #000; }
  .platform-label.bluesky { color: #0085ff; }
  .platform-label.facebook { color: #1877F2; }
  .platform-icon { font-size: 14px; }
  .platform-text {
    font-size: 15px;
    line-height: 1.5;
    color: #1a1a1a;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .platform-text a { color: #1d9bf0; text-decoration: none; }
  .char-count {
    font-size: 11px;
    color: #bbb;
    margin-top: 6px;
    text-align: right;
  }

  .comment-section {
    max-width: 640px;
    width: 100%;
    margin-bottom: 16px;
  }
  .comment-input {
    width: 100%;
    padding: 10px 14px;
    border: 1px solid #E5E2DB;
    border-radius: 8px;
    font-size: 14px;
    font-family: inherit;
    resize: vertical;
    min-height: 44px;
    max-height: 120px;
    background: #fff;
  }
  .comment-input::placeholder { color: #bbb; }
  .comment-input:focus { outline: none; border-color: #999; }

  .buttons {
    display: flex;
    gap: 12px;
    max-width: 640px;
    width: 100%;
    margin-bottom: 32px;
  }
  .btn {
    flex: 1;
    padding: 14px;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.1s;
  }
  .btn:active { transform: scale(0.96); }
  .btn-reject {
    background: #f5f5f5;
    color: #888;
    border: 1px solid #ddd;
  }
  .btn-reject:hover { background: #eee; }
  .btn-edit {
    background: #f0ead6;
    color: #6b5b3e;
    border: 1px solid #d4c9a8;
    flex: 1.2;
  }
  .btn-edit:hover { background: #e8dfc8; }
  .btn-edit.loading {
    opacity: 0.6;
    pointer-events: none;
  }
  .btn-approve {
    background: #1a1a1a;
    color: #faf9f6;
  }
  .btn-approve:hover { background: #333; }

  .done {
    text-align: center;
    padding: 60px 20px;
    max-width: 640px;
  }
  .done h2 { font-size: 22px; margin-bottom: 12px; }
  .done p { color: #888; line-height: 1.6; font-size: 14px; }
  .stat { margin-top: 20px; }
  .stat-num { font-size: 36px; font-weight: 700; }
  .stat-label { font-size: 13px; color: #888; }

  .generating {
    text-align: center;
    padding: 60px 20px;
    color: #888;
  }
  .generating h2 { font-size: 20px; margin-bottom: 12px; color: #1a1a1a; }
  .spinner {
    display: inline-block;
    width: 24px;
    height: 24px;
    border: 3px solid #eee;
    border-top-color: #1a1a1a;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: 16px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .empty {
    text-align: center;
    padding: 80px 20px;
    color: #888;
  }
  .empty h2 { font-size: 20px; margin-bottom: 8px; color: #1a1a1a; }

  /* Replies tab styles */
  #replies-view {
    max-width: 640px;
    width: 100%;
    display: none;
  }
  .reply-card {
    background: #fff;
    border: 1px solid #E5E2DB;
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 12px;
    border-left: 4px solid #ccc;
  }
  .reply-card.cls-positive_simple { border-left-color: #2c6b4f; }
  .reply-card.cls-factual, .reply-card.cls-question { border-left-color: #1d9bf0; }
  .reply-card.cls-needs_human { border-left-color: #e6a817; }
  .reply-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .reply-platform-icon { font-size: 16px; }
  .reply-author {
    font-size: 14px;
    font-weight: 600;
  }
  .reply-timestamp {
    font-size: 12px;
    color: #aaa;
    margin-left: auto;
  }
  .reply-text {
    font-size: 15px;
    line-height: 1.5;
    margin-bottom: 8px;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .reply-context {
    font-size: 12px;
    color: #888;
    margin-bottom: 10px;
    padding: 6px 10px;
    background: #faf9f6;
    border-radius: 4px;
  }
  .reply-context strong { color: #555; }
  .reply-status {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 12px;
    color: #888;
    margin-bottom: 10px;
  }
  .reply-status .check { color: #2c6b4f; }
  .reply-status .x-mark { color: #c0392b; }
  .reply-badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .reply-badge.positive_simple { background: #e8f5e9; color: #2c6b4f; }
  .reply-badge.factual, .reply-badge.question { background: #e3f2fd; color: #1565c0; }
  .reply-badge.needs_human { background: #fff3e0; color: #e65100; }
  .reply-badge.unclassified { background: #f5f5f5; color: #888; }
  .reply-link {
    font-size: 12px;
    color: #1d9bf0;
    text-decoration: none;
  }
  .reply-link:hover { text-decoration: underline; }
  .reply-action-box {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .reply-action-input {
    flex: 1;
    padding: 8px 12px;
    border: 1px solid #E5E2DB;
    border-radius: 8px;
    font-size: 13px;
    font-family: inherit;
    background: #fff;
  }
  .reply-action-input::placeholder { color: #bbb; }
  .reply-action-input:focus { outline: none; border-color: #999; }
  .reply-action-btn {
    padding: 8px 16px;
    border: none;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    background: #1a1a1a;
    color: #faf9f6;
    white-space: nowrap;
  }
  .reply-action-btn:hover { background: #333; }
  .reply-action-btn:disabled { background: #ccc; cursor: default; }
  .reply-saved-note {
    margin-top: 8px;
    padding: 6px 10px;
    background: #f0efec;
    border-radius: 4px;
    font-size: 12px;
    color: #555;
  }
  .reply-saved-note strong { color: #1a1a1a; }

  /* Calendar View */
  #calendar-view { max-width: 1200px; margin: 0 auto; padding: 0 16px; }
  .cal-day { margin-bottom: 24px; border: 1px solid #E5E2DB; border-radius: 12px; overflow: hidden; }
  .cal-day-header {
    padding: 12px 20px; background: #f5f4f0; border-bottom: 1px solid #E5E2DB;
    display: flex; justify-content: space-between; align-items: center;
  }
  .cal-day-header h3 { font-size: 16px; font-weight: 600; margin: 0; }
  .cal-day-header .cal-date { color: #888; font-size: 13px; }
  .cal-day.today .cal-day-header { background: #1a1a1a; color: #faf9f6; }
  .cal-day.today .cal-date { color: #bbb; }
  .cal-slots { display: flex; flex-direction: column; }
  .cal-slot {
    padding: 0; border-bottom: 1px solid #E5E2DB;
  }
  .cal-slot:last-child { border-bottom: none; }
  .cal-slot-header {
    display: flex; align-items: center; gap: 12px; padding: 12px 20px;
    flex-wrap: wrap;
  }
  .cal-slot-type {
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
    white-space: nowrap;
  }
  .cal-slot-type.day-plan { color: #d4a017; }
  .cal-slot-type.tonight-pick { color: #8b5cf6; }
  .cal-slot-type.wildcard { color: #059669; }
  .cal-slot-title { font-size: 14px; font-weight: 600; line-height: 1.3; flex: 1; }
  .cal-badges { display: flex; gap: 6px; }
  .cal-badge {
    font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 600;
  }
  .cal-badge.draft { background: #fef3c7; color: #92400e; }
  .cal-badge.copy-approved { background: #d1fae5; color: #065f46; }
  .cal-badge.image-approved { background: #dbeafe; color: #1e40af; }
  .cal-badge.published { background: #e5e7eb; color: #4b5563; }
  .cal-badge.empty { background: #f3f4f6; color: #9ca3af; }
  .cal-slot.empty { opacity: 0.5; }
  .cal-slot.empty .cal-slot-title { color: #bbb; font-style: italic; }

  /* Calendar expanded slot */
  .cal-expanded {
    padding: 16px 20px 20px; background: #faf9f6;
  }
  .cal-expanded-platforms { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 16px; }
  .cal-expanded-platform { font-size: 13px; line-height: 1.5; }
  .cal-expanded-platform strong { font-size: 11px; text-transform: uppercase; color: #888; }
  .cal-expanded-image { max-width: 300px; border-radius: 8px; margin-bottom: 16px; }
  .cal-expanded-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .cal-expanded-actions button {
    padding: 8px 16px; border-radius: 6px; border: 1px solid #ddd;
    background: #fff; font-size: 13px; cursor: pointer; font-weight: 500;
  }
  .cal-expanded-actions button:hover { background: #f5f5f5; }
  .cal-expanded-actions .btn-approve-copy { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  .cal-expanded-actions .btn-approve-image { background: #2563eb; color: #fff; border-color: #2563eb; }
  .cal-expanded-actions .btn-regen { background: #f59e0b; color: #fff; border-color: #f59e0b; }
  .cal-edit-area { margin-top: 12px; }
  .cal-edit-input {
    width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px;
    font-size: 13px; font-family: inherit; resize: vertical; min-height: 40px;
  }
</style>
</head>
<body>
<h1>South Bay Today</h1>

<div class="tab-bar" id="tab-bar">
  <button class="tab-btn active" onclick="switchTab('calendar')" id="tab-calendar">Calendar</button>
  <button class="tab-btn" onclick="switchTab('replies')" id="tab-replies">Replies <span class="tab-count" id="tab-replies-count"></span></button>
</div>

<div id="calendar-view">
  <div id="calendar-grid"></div>
</div>

<div id="replies-view">
  <div id="replies-list"></div>
</div>

<script>
let posts = [];
let current = 0;
let results = [];
let queueSize = 0;
let currentTab = 'calendar';
let repliesData = [];

const PLATFORM_ICONS = { x: '\\ud835\\udd4f', threads: '\\ud83e\\uddf5', bluesky: '\\ud83e\\udd8b', facebook: '\\ud83d\\udcd8' };

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tab-calendar').className = 'tab-btn' + (tab === 'calendar' ? ' active' : '');
  document.getElementById('tab-replies').className = 'tab-btn' + (tab === 'replies' ? ' active' : '');
  document.getElementById('calendar-view').style.display = tab === 'calendar' ? '' : 'none';
  if (tab === 'calendar') loadCalendar();
  document.getElementById('replies-view').style.display = tab === 'replies' ? '' : 'none';
  if (tab === 'replies') loadReplies();
}

function updateTabCounts(draftCount, repliesNewCount) {
  const rc = document.getElementById('tab-replies-count');
  if (rc) rc.textContent = repliesNewCount > 0 ? '(' + repliesNewCount + ' new)' : '';
}

function updateQueueBadge(size) {
  queueSize = size;
  const el = document.getElementById('queue-badge');
  if (el) {
    el.textContent = size + ' approved, unpublished';
    el.className = 'queue-badge' + (size < 40 ? ' low' : size < 60 ? ' mid' : '');
  }
}

async function init() {
  // Load calendar immediately since it's the default tab
  loadCalendar();

  // Fetch reply count for tab badge
  try {
    const rRes = await fetch('/api/replies');
    const rData = await rRes.json();
    repliesData = Array.isArray(rData) ? rData : [];
    const newCount = repliesData.filter(r => r.classification && !r.responded && !r.actionNote).length;
    updateTabCounts(0, newCount);
  } catch {
    updateTabCounts(0, 0);
  }
}

function urlify(text) {
  return text.replace(/(https?:\\/\\/[^\\s]+)/g, '<a href="$1" target="_blank">$1</a>');
}

function escapeHtml(text) {
  return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

function render() {
  if (current >= posts.length) {
    showDone();
    return;
  }

  const post = posts[current];
  const item = post.item || {};
  document.getElementById('counter').textContent = (current + 1) + ' / ' + posts.length;
  document.getElementById('comment').value = '';

  document.getElementById('item-header').innerHTML =
    '<div class="item-title">' + (item.title || 'Untitled') + '</div>' +
    '<div class="item-meta">' + [item.cityName, item.venue, item.date, item.time, item.category].filter(Boolean).join(' \\u00b7 ') + ' \\u00b7 score: ' + (item.score || '?') + '</div>' +
    (item.url ? '<div class="item-url"><a href="' + item.url + '" target="_blank">' + item.url + '</a></div>' : '');

  const copy = post.copy || {};
  const platformDefs = [
    { key: 'x', label: 'X', icon: '\\ud835\\udd4f', maxChars: 280 },
    { key: 'threads', label: 'Threads', icon: '\\ud83e\\uddf5', maxChars: 500 },
    { key: 'bluesky', label: 'Bluesky', icon: '\\ud83e\\udd8b', maxChars: 300 },
    { key: 'facebook', label: 'Facebook', icon: '\\ud83d\\udcd8', maxChars: 500 },
    { key: 'instagram', label: 'Instagram', icon: '\\ud83d\\udcf7', maxChars: 2200 },
  ];

  let cardsHtml = '';
  for (const p of platformDefs) {
    const text = copy[p.key] || '';
    if (!text) continue;
    const overLimit = text.length > p.maxChars;
    cardsHtml += '<div class="platform-card">' +
      '<div class="platform-label ' + p.key + '"><span class="platform-icon">' + p.icon + '</span> ' + p.label + '</div>' +
      '<div class="platform-text">' + urlify(text) + '</div>' +
      '<div class="char-count"' + (overLimit ? ' style="color:#c0392b;font-weight:700"' : '') + '>' + text.length + ' / ' + p.maxChars + '</div>' +
      '</div>';
  }
  document.getElementById('platforms').innerHTML = cardsHtml;
  document.getElementById('platforms').className = 'platforms';
}

async function showDone() {
  document.getElementById('review-area').style.display = 'none';
  document.getElementById('shortcuts').style.display = 'none';
  const approved = results.filter(r => r.vote === 'approve');
  const rejected = results.filter(r => r.vote === 'reject');
  const withComments = results.filter(r => r.comment);

  // Save results first
  const saveRes = await fetch('/api/review', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(results) });
  const saveData = await saveRes.json();
  updateQueueBadge(saveData.queueSize || queueSize + approved.length);

  let html = '<h2>Review complete</h2>';
  html += '<div style="display:flex;gap:40px;justify-content:center;margin-top:24px">';
  html += '<div class="stat"><div class="stat-num" style="color:#2c6b4f">' + approved.length + '</div><div class="stat-label">approved</div></div>';
  html += '<div class="stat"><div class="stat-num" style="color:#c0392b">' + rejected.length + '</div><div class="stat-label">skipped</div></div>';
  if (withComments.length > 0) {
    html += '<div class="stat"><div class="stat-num" style="color:#e6a817">' + withComments.length + '</div><div class="stat-label">with notes</div></div>';
  }
  html += '</div>';

  // Show action command results
  if (saveData.actionResults && saveData.actionResults.length > 0) {
    html += '<div style="margin-top:20px;padding:12px 16px;background:#f0f7f4;border:1px solid #c8e6d0;border-radius:8px;text-align:left;max-width:500px;margin-left:auto;margin-right:auto">';
    html += '<div style="font-weight:600;font-size:13px;color:#2c6b4f;margin-bottom:8px">🎯 Actions executed:</div>';
    for (const ar of saveData.actionResults) {
      html += '<div style="font-size:12px;color:#333;margin-bottom:4px">• <strong>' + ar.title + '</strong>: ' + ar.summary + '</div>';
    }
    html += '</div>';
  }

  // Show generating state and trigger new batch
  html += '<div class="generating" id="gen-status" style="margin-top:32px"><div class="spinner"></div><h2>Generating next batch...</h2><p>This takes about a minute. Page will refresh when ready.</p></div>';
  document.getElementById('done').style.display = 'block';
  document.getElementById('done').innerHTML = html;

  // Trigger generation
  fetch('/api/generate', { method: 'POST' });

  // Poll for new posts
  pollForNewPosts();
}

async function pollForNewPosts() {
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (!data.generating && data.pendingCount > 0) {
        clearInterval(poll);
        // Reset and reload
        current = 0;
        results = [];
        document.getElementById('done').style.display = 'none';
        document.getElementById('review-area').style.display = '';
        document.getElementById('shortcuts').style.display = '';
        init();
      }
      if (attempts > 120) { // 2 min timeout
        clearInterval(poll);
        document.getElementById('gen-status').innerHTML = '<h2>Generation timed out</h2><p>Refresh the page to try again.</p>';
      }
    } catch {}
  }, 2000);
}

// Show "Accept w/ Edits" button when comment has text (only if review swiper is present)
const commentEl = document.getElementById('comment');
if (commentEl) {
  commentEl.addEventListener('input', function() {
    const editBtn = document.getElementById('btn-edit');
    if (editBtn) editBtn.style.display = this.value.trim() ? '' : 'none';
  });
}

function vote(v) {
  const el = document.getElementById('platforms');
  const comment = document.getElementById('comment').value.trim();

  // "edit" = accept with edits — requires comment text
  if (v === 'edit' && !comment) {
    document.getElementById('comment').focus();
    return;
  }

  el.classList.add(v === 'reject' ? 'swipe-left' : 'swipe-right');

  const voteData = {
    file: posts[current]._file,
    title: posts[current].item?.title || '',
    vote: v === 'edit' ? 'edit' : v,
    comment: comment || null,
  };
  results.push(voteData);

  if (v === 'edit') {
    // Show loading state — edits take a moment (Claude rewrite)
    const editBtn = document.getElementById('btn-edit');
    editBtn.classList.add('loading');
    editBtn.textContent = 'Rewriting...';
  }

  // Save immediately — don't wait for batch end
  fetch('/api/vote', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(voteData) })
    .then(r => r.json())
    .then(data => {
      if (data.queueSize) updateQueueBadge(data.queueSize);
      if (data.actionResult) {
        console.log('Action:', data.actionResult);
      }
      if (v === 'edit') {
        const editBtn = document.getElementById('btn-edit');
        editBtn.classList.remove('loading');
        editBtn.textContent = 'Accept w/ Edits';
      }
    })
    .catch(() => {
      if (v === 'edit') {
        const editBtn = document.getElementById('btn-edit');
        editBtn.classList.remove('loading');
        editBtn.textContent = 'Accept w/ Edits';
      }
    });

  if (v === 'approve' || v === 'edit') updateQueueBadge(queueSize + 1);
  setTimeout(() => { current++; render(); }, v === 'edit' ? 500 : 300);
}

// --- Replies ---

async function loadReplies() {
  try {
    const res = await fetch('/api/replies');
    const data = await res.json();
    repliesData = Array.isArray(data) ? data : [];
  } catch {
    repliesData = [];
  }
  renderReplies();
}

function renderReplies() {
  const container = document.getElementById('replies-list');
  if (!repliesData || repliesData.length === 0) {
    container.innerHTML = '<div class="empty"><h2>No replies yet</h2><p>Run <code>node scripts/social/monitor-replies.mjs</code> to fetch replies from your social accounts.</p></div>';
    return;
  }

  // Sort newest first
  const sorted = [...repliesData].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

  let html = '';
  for (const reply of sorted) {
    const cls = reply.classification || 'unclassified';
    const icon = PLATFORM_ICONS[reply.platform] || '';
    const liked = reply.liked;
    const responded = reply.responded;

    html += '<div class="reply-card cls-' + cls + '">';

    // Header
    html += '<div class="reply-card-header">';
    html += '<span class="reply-platform-icon">' + icon + '</span>';
    html += '<span class="reply-author">@' + escapeHtml(reply.authorUsername || 'unknown') + '</span>';
    html += '<span class="reply-badge ' + cls + '">' + cls.replace('_', ' ') + '</span>';
    html += '<span class="reply-timestamp">' + timeAgo(reply.timestamp) + '</span>';
    html += '</div>';

    // Reply text
    html += '<div class="reply-text">' + escapeHtml(reply.text || '') + '</div>';

    // Original post context
    if (reply.originalPostTitle) {
      html += '<div class="reply-context">Re: <strong>' + escapeHtml(reply.originalPostTitle) + '</strong></div>';
    }

    // Status row
    html += '<div class="reply-status">';
    html += liked ? '<span class="check">\\u2714 liked</span>' : '<span class="x-mark">\\u2717 not liked</span>';
    html += responded ? '<span class="check">\\u2714 responded</span>' : '<span class="x-mark">\\u2717 no response</span>';
    if (reply.permalink) {
      html += '<a class="reply-link" href="' + escapeHtml(reply.permalink) + '" target="_blank">View on platform \\u2197</a>';
    }
    html += '</div>';

    // Saved action note
    if (reply.actionNote) {
      html += '<div class="reply-saved-note"><strong>Action:</strong> ' + escapeHtml(reply.actionNote) + '</div>';
    }

    // Action input
    html += '<div class="reply-action-box">';
    html += '<input class="reply-action-input" id="action-' + escapeHtml(reply.id) + '" placeholder="e.g. respond with: Thanks! ..." value="' + escapeHtml(reply.actionNote || '') + '">';
    html += '<button class="reply-action-btn" onclick="submitAction(\\'' + escapeHtml(reply.id) + '\\')">Save</button>';
    html += '</div>';

    html += '</div>';
  }
  container.innerHTML = html;
}

async function submitAction(replyId) {
  const input = document.getElementById('action-' + replyId);
  if (!input) return;
  const note = input.value.trim();
  const btn = input.nextElementSibling;
  btn.disabled = true;
  btn.textContent = '...';

  try {
    const res = await fetch('/api/reply-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: replyId, actionNote: note || null }),
    });
    const data = await res.json();
    if (data.ok) {
      if (data.actionResult) {
        btn.textContent = '✅ ' + data.actionResult;
        btn.style.fontSize = '11px';
        setTimeout(() => { btn.textContent = 'Save'; btn.style.fontSize = ''; btn.disabled = false; }, 4000);
      } else {
        btn.textContent = 'Saved';
        setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
      }
      // Update local data
      const r = repliesData.find(r => r.id === replyId);
      if (r) r.actionNote = note || null;
      // Refresh tab count
      const newCount = repliesData.filter(r => r.classification && !r.responded && !r.actionNote).length;
      updateTabCounts(posts.length, newCount);
    }
  } catch {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
  }
}

document.addEventListener('keydown', (e) => {
  // Don't intercept keys when in replies tab or in an input
  if (currentTab !== 'review') return;
  if (document.activeElement === document.getElementById('comment')) {
    if (e.key === 'Escape') document.getElementById('comment').blur();
    return;
  }
  if (e.key === 'ArrowRight') vote('approve');
  if (e.key === 'ArrowLeft') vote('reject');
  if (e.key === 'e' || e.key === 'E') { vote('edit'); return; }
  if (e.key === 'Tab') {
    e.preventDefault();
    document.getElementById('comment').focus();
  }
});

// --- Calendar ---

let scheduleData = {};

const SLOT_META = {
  'day-plan': { label: '7:15 AM — Day Plan', icon: '\\ud83d\\udccb', color: '#d4a017', hour: 7, minute: 15 },
  'tonight-pick': { label: '11:45 AM — Tonight Pick', icon: '\\ud83c\\udf19', color: '#8b5cf6', hour: 11, minute: 45 },
  'wildcard': { label: '4:30 PM — Wildcard', icon: '\\ud83c\\udfb2', color: '#059669', hour: 16, minute: 30 },
};

function nowPT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

function slotIsMissed(dateStr, slotType, slot) {
  // Already published — always show
  if (slot?.status === 'published') return false;
  const now = nowPT();
  const today = todayStr();
  // Past days — all slots missed
  if (dateStr < today) return true;
  // Future days — nothing missed
  if (dateStr > today) return false;
  // Today — check if publish window has passed
  const meta = SLOT_META[slotType];
  const slotMinutes = meta.hour * 60 + meta.minute;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes > slotMinutes;
}

const SLOT_ORDER = ['day-plan', 'tonight-pick', 'wildcard'];
const DAY_NAMES_CAL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function loadCalendar() {
  try {
    const res = await fetch('/api/schedule');
    scheduleData = await res.json();
  } catch {
    scheduleData = { days: {} };
  }
  renderCalendar();
}

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function renderCalendar() {
  const grid = document.getElementById('calendar-grid');
  const today = todayStr();
  const days = scheduleData.days || {};

  // Generate 14 days starting from today
  let html = '';
  for (let offset = 0; offset < 14; offset++) {
    const d = new Date(today + 'T12:00:00');
    d.setDate(d.getDate() + offset);
    const dateStr = d.toLocaleDateString('en-CA');
    const dayName = DAY_NAMES_CAL[d.getDay()];
    const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const isToday = dateStr === today;
    const dayData = days[dateStr] || {};

    html += '<div class="cal-day' + (isToday ? ' today' : '') + '">';
    html += '<div class="cal-day-header">';
    html += '<h3>' + dayName + (isToday ? ' (Today)' : '') + '</h3>';
    html += '<span class="cal-date">' + monthDay + '</span>';
    html += '</div>';
    html += '<div class="cal-slots">';

    // Skip entire day if all slots are missed
    const activeSlots = SLOT_ORDER.filter(st => !slotIsMissed(dateStr, st, dayData[st]));
    if (activeSlots.length === 0) {
      // Close the day div without rendering slots
      html += '</div></div>';
      continue;
    }

    for (const slotType of SLOT_ORDER) {
      const slot = dayData[slotType];
      const meta = SLOT_META[slotType];
      const missed = slotIsMissed(dateStr, slotType, slot);

      // Hide missed slots entirely
      if (missed) continue;

      const isEmpty = !slot;

      html += '<div class="cal-slot' + (isEmpty ? ' empty' : '') + '">';
      html += '<div class="cal-slot-header">';
      html += '<div class="cal-slot-type ' + slotType + '">' + meta.icon + ' ' + meta.label + '</div>';

      if (slot) {
        // Title + badges inline
        const title = slot.plan ? (slot.cityName || 'Day Plan') :
          (slot.item?.title || slot.item?.name || 'Untitled');
        html += '<span class="cal-slot-title">' + escapeHtml(title) + '</span>';

        html += '<div class="cal-badges">';
        if (slot.status === 'published') {
          html += '<span class="cal-badge published">Published</span>';
        } else {
          html += '<span class="cal-badge ' + (slot.copyApprovedAt ? 'copy-approved' : 'draft') + '">Copy: ' + (slot.copyApprovedAt ? '\\u2713' : 'draft') + '</span>';
          html += '<span class="cal-badge ' + (slot.imageApprovedAt ? 'image-approved' : slot.imageUrl ? 'draft' : 'empty') + '">Image: ' + (slot.imageApprovedAt ? '\\u2713' : slot.imageUrl ? 'review' : 'none') + '</span>';
        }
        html += '</div>';
      } else {
        html += '<span class="cal-slot-title" style="color:#bbb;font-style:italic">No content</span>';
      }

      html += '</div>'; // close cal-slot-header

      // Always show expanded content
      if (slot) {
        html += renderExpandedSlot(dateStr, slotType, slot);
      }

      html += '</div>'; // close cal-slot
    }

    html += '</div>'; // close cal-slots
    html += '</div>'; // close cal-day
  }

  grid.innerHTML = html;
}

function renderExpandedSlot(dateStr, slotType, slot) {
  let html = '<div class="cal-expanded">';

  // Platform copy — full text with char counts
  const CHAR_LIMITS = { x: 280, threads: 500, bluesky: 300, facebook: 500, instagram: 2200, mastodon: 500 };
  if (slot.copy) {
    html += '<div class="cal-expanded-platforms">';
    const platforms = ['x', 'threads', 'bluesky', 'facebook', 'instagram'];
    for (const p of platforms) {
      if (!slot.copy[p]) continue;
      const len = slot.copy[p].length;
      const limit = CHAR_LIMITS[p] || 500;
      const over = len > limit;
      html += '<div class="cal-expanded-platform"><strong>' + p.toUpperCase() + '</strong> <span style="font-size:11px;color:' + (over ? '#c0392b;font-weight:700' : '#aaa') + '">' + len + ' / ' + limit + '</span><br><div style="white-space:pre-wrap;word-wrap:break-word;margin-top:4px">' + urlify(escapeHtml(slot.copy[p])) + '</div></div>';
    }
    html += '</div>';
  }

  // Image
  if (slot.imageUrl) {
    html += '<img class="cal-expanded-image" src="' + escapeHtml(slot.imageUrl) + '">';
  }

  // Actions
  html += '<div class="cal-expanded-actions">';
  if (!slot.copyApprovedAt) {
    html += '<button class="btn-approve-copy" onclick="calAction(\\'' + dateStr + '\\', \\'' + slotType + '\\', \\'approve-copy\\'); event.stopPropagation();">Approve Copy</button>';
  }
  if (slot.imageUrl && !slot.imageApprovedAt) {
    html += '<button class="btn-approve-image" onclick="calAction(\\'' + dateStr + '\\', \\'' + slotType + '\\', \\'approve-image\\'); event.stopPropagation();">Approve Image</button>';
  }
  if (slot.copyApprovedAt) {
    html += '<button class="btn-regen" onclick="calAction(\\'' + dateStr + '\\', \\'' + slotType + '\\', \\'regen-image\\'); event.stopPropagation();">' + (slot.imageUrl ? 'Regen Image' : 'Generate Image') + '</button>';
  }
  html += '</div>';

  // Edit area
  html += '<div class="cal-edit-area">';
  html += '<input class="cal-edit-input" id="cal-edit-' + dateStr + '-' + slotType + '" placeholder="Edit instructions..." onclick="event.stopPropagation()">';
  html += '<button style="margin-top:6px;padding:6px 14px;border-radius:6px;border:1px solid #ddd;background:#fff;font-size:12px;cursor:pointer" onclick="calEditCopy(\\'' + dateStr + '\\', \\'' + slotType + '\\'); event.stopPropagation();">Submit Edits</button>';
  html += '</div>';

  html += '</div>';
  return html;
}

// All slots render expanded by default — no toggle needed

async function calAction(dateStr, slotType, action) {
  try {
    const res = await fetch('/api/schedule/' + dateStr + '/' + slotType + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.ok) {
      // Update local state
      if (data.schedule) {
        scheduleData = data.schedule;
      } else {
        await loadCalendar();
        return;
      }
      renderCalendar();
    } else {
      alert('Action failed: ' + (data.error || 'unknown'));
    }
  } catch (err) {
    alert('Action failed: ' + err.message);
  }
}

async function calEditCopy(dateStr, slotType) {
  const input = document.getElementById('cal-edit-' + dateStr + '-' + slotType);
  if (!input || !input.value.trim()) return;

  try {
    const res = await fetch('/api/schedule/' + dateStr + '/' + slotType + '/edit-copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instructions: input.value.trim() }),
    });
    const data = await res.json();
    if (data.ok) {
      input.value = '';
      if (data.schedule) {
        scheduleData = data.schedule;
      } else {
        await loadCalendar();
        return;
      }
      renderCalendar();
    }
  } catch (err) {
    alert('Edit failed: ' + err.message);
  }
}

init();
</script>
</body>
</html>`;

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/posts") {
    const posts = loadPendingPosts();
    const queue = loadQueue();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ posts, queueSize: queue.filter((p) => !p.published).length }));
    return;
  }

  if (req.method === "GET" && req.url === "/api/status") {
    const posts = loadPendingPosts();
    const queue = loadQueue();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ generating: isGenerating, pendingCount: posts.length, queueSize: queue.filter((p) => !p.published).length }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/generate") {
    generateNewBatch();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, generating: true }));
    return;
  }

  // Immediate per-vote endpoint — saves each swipe as it happens
  if (req.method === "POST" && req.url === "/api/vote") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const r = JSON.parse(body);
        const posts = loadPendingPosts();
        const post = posts.find((p) => p._file === r.file);

        if ((r.vote === "approve" || r.vote === "edit") && post) {
          const queue = loadQueue();
          const cleanPost = { ...post };
          delete cleanPost._file;

          // If "edit" vote, rewrite copy with Claude using the comment as instructions
          if (r.vote === "edit" && r.comment && cleanPost.copy) {
            try {
              const rewritten = await rewriteCopyWithEdits(cleanPost.copy, r.comment, cleanPost.item);
              cleanPost.copy = rewritten;
              console.log(`  ✏️  ${r.title?.slice(0, 50)} → copy rewritten per edits`);
            } catch (err) {
              console.error(`  ⚠️  Edit rewrite failed: ${err.message} — queuing original`);
            }
          }

          const approvedPost = {
            ...cleanPost,
            approvedAt: new Date().toISOString(),
            comment: r.comment || null,
            editApplied: r.vote === "edit",
            published: false,
          };
          // Assign a publish slot based on the event date + current queue
          // occupancy. Falls back to null if no event date or no slot fits.
          try {
            const { assignSlot } = await import("./lib/slot-scheduler.mjs");
            const slot = assignSlot(approvedPost, queue);
            if (slot) {
              approvedPost.scheduledSlot = slot;
              console.log(`     📅 slotted: ${slot.date} @ ${slot.time}${slot.fallback ? " (fallback)" : ""}`);
            }
          } catch (err) {
            console.warn(`     ⚠️  slot assignment failed: ${err.message}`);
          }
          queue.push(approvedPost);
          saveQueue(queue);
          console.log(`  ✅ ${r.title?.slice(0, 50)} → ${r.vote === "edit" ? "approved w/ edits" : "approved"} (queue: ${queue.length})`);
        } else {
          console.log(`  ⏭️  ${r.title?.slice(0, 50)} → skipped`);
        }

        // Save to review history so it never reappears
        let reviewHistory = [];
        try { reviewHistory = JSON.parse(readFileSync(REVIEW_HISTORY_FILE, "utf8")); } catch {}
        reviewHistory.push({
          title: r.title,
          url: post?.item?.url || null,
          postType: post?.postType || null,
          milestoneId: post?.item?.milestoneId || null,
          vote: r.vote,
          comment: r.comment || null,
          reviewedAt: new Date().toISOString(),
        });
        writeFileSync(REVIEW_HISTORY_FILE, JSON.stringify(reviewHistory, null, 2) + "\n");

        // Delete the post file from /tmp so it won't reappear
        if (post?._file) {
          try { unlinkSync(join(POST_DIR, post._file)); } catch {}
        }

        // Process action commands from comments (skip for edit votes — those are edit instructions, not actions)
        let actionResult = null;
        if (r.comment && r.vote !== "edit") {
          const context = {
            title: r.title || post?.item?.title || "",
            source: post?.item?.source || "",
            venue: post?.item?.venue || "",
            city: post?.item?.city || "",
            category: post?.item?.category || "",
            url: post?.item?.url || "",
          };
          try {
            actionResult = await processComment(r.comment, context);
            if (actionResult?.summary) {
              console.log(`     🎯 ${r.title?.slice(0, 40)}: ${actionResult.summary}`);
            }
          } catch (err) {
            console.error(`  ⚠ Action processing failed:`, err.message);
          }
        }

        const queue = loadQueue();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, queueSize: queue.filter((p) => !p.published).length, actionResult: actionResult?.summary || null }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/review") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const results = JSON.parse(body);
      const queue = loadQueue();
      const posts = loadPendingPosts();

      const approved = results.filter((r) => r.vote === "approve");
      const rejected = results.filter((r) => r.vote === "reject");
      const withComments = results.filter((r) => r.comment);

      for (const r of approved) {
        const post = posts.find((p) => p._file === r.file);
        if (!post) continue;
        delete post._file;
        queue.push({
          ...post,
          approvedAt: new Date().toISOString(),
          comment: r.comment || null,
          published: false,
        });
      }
      saveQueue(queue);

      // Persist ALL reviewed items (approved + rejected) to review history
      // so they never show up again in future generation runs
      let reviewHistory = [];
      try { reviewHistory = JSON.parse(readFileSync(REVIEW_HISTORY_FILE, "utf8")); } catch {}
      for (const r of results) {
        const post = posts.find((p) => p._file === r.file);
        reviewHistory.push({
          title: r.title,
          url: post?.item?.url || null,
          vote: r.vote,
          comment: r.comment || null,
          reviewedAt: new Date().toISOString(),
        });
      }
      writeFileSync(REVIEW_HISTORY_FILE, JSON.stringify(reviewHistory, null, 2) + "\n");

      console.log(`\n✅ Review complete!`);
      console.log(`   ${approved.length} approved → queue now ${queue.length}`);
      console.log(`   ${rejected.length} skipped`);
      if (withComments.length > 0) {
        console.log(`   ${withComments.length} with comments:`);
        for (const r of withComments) {
          console.log(`     [${r.vote}] ${r.title}: "${r.comment}"`);
        }
      }

      // Process action commands from comments
      const actionResults = [];
      for (const r of withComments) {
        const post = posts.find((p) => p._file === r.file);
        const context = {
          title: r.title || post?.item?.title || "",
          source: post?.item?.source || "",
          venue: post?.item?.venue || "",
          city: post?.item?.city || "",
          category: post?.item?.category || "",
          url: post?.item?.url || "",
        };
        try {
          const result = await processComment(r.comment, context);
          if (result.summary) {
            actionResults.push({ title: r.title, summary: result.summary });
          }
        } catch (err) {
          console.error(`  ⚠ Action processing failed for "${r.title}":`, err.message);
        }
      }
      if (actionResults.length > 0) {
        console.log(`   🎯 Actions executed:`);
        for (const ar of actionResults) {
          console.log(`     ${ar.title}: ${ar.summary}`);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, queueSize: queue.filter((p) => !p.published).length, actionResults }));
    });
    return;
  }

  // ── Schedule API endpoints ───────────────────────────────────────────────

  if (req.method === "GET" && req.url === "/api/schedule") {
    const schedule = loadSchedule();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(schedule));
    return;
  }

  // Handle schedule actions: /api/schedule/:date/:slotType/:action
  const scheduleMatch = req.url?.match(/^\/api\/schedule\/(\d{4}-\d{2}-\d{2})\/(day-plan|tonight-pick|wildcard)\/(approve-copy|approve-image|regen-image|edit-copy)$/);
  if (req.method === "POST" && scheduleMatch) {
    const [, date, slotType, action] = scheduleMatch;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const schedule = loadSchedule();
        const slot = schedule.days?.[date]?.[slotType];
        if (!slot) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Slot not found" }));
          return;
        }

        if (action === "approve-copy") {
          slot.copyApprovedAt = new Date().toISOString();
          slot.status = "copy-approved";
          console.log(`  ✅ Copy approved: ${date} ${slotType}`);

          // Trigger Recraft poster generation
          try {
            const { pickStyle, dayPlanPrompt, tonightPickPrompt, wildcardPrompt } = await import("./lib/poster-styles.mjs");
            const { generateAndUpload } = await import("./lib/recraft.mjs");
            const style = pickStyle();
            let prompt;
            if (slotType === "day-plan" && slot.plan) {
              prompt = dayPlanPrompt(slot.plan, date, style.style);
            } else if (slotType === "tonight-pick" && slot.item) {
              prompt = tonightPickPrompt(slot.item, style.style);
            } else if (slot.item) {
              prompt = wildcardPrompt(slot.item, slot.subtype || "general", style.style);
            }
            if (prompt) {
              console.log(`  🎨 Generating Recraft image (${style.id})...`);
              const pathname = `posters/${date}-${slotType}.png`;
              const { url } = await generateAndUpload({ prompt, pathname, colors: style.colors || undefined });
              slot.imageUrl = url;
              slot.imageStyle = style.id;
              console.log(`  ✅ Image generated: ${url.slice(0, 80)}`);
            }
          } catch (err) {
            console.error(`  ⚠️  Recraft generation failed: ${err.message}`);
          }

          saveScheduleFile(schedule);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, schedule }));
          return;
        }

        if (action === "approve-image") {
          slot.imageApprovedAt = new Date().toISOString();
          slot.status = "image-approved";
          console.log(`  ✅ Image approved: ${date} ${slotType}`);
          saveScheduleFile(schedule);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, schedule }));
          return;
        }

        if (action === "regen-image") {
          try {
            const { pickStyle, dayPlanPrompt, tonightPickPrompt, wildcardPrompt } = await import("./lib/poster-styles.mjs");
            const { generateAndUpload } = await import("./lib/recraft.mjs");
            const style = pickStyle();
            let prompt;
            if (slotType === "day-plan" && slot.plan) {
              prompt = dayPlanPrompt(slot.plan, date, style.style);
            } else if (slotType === "tonight-pick" && slot.item) {
              prompt = tonightPickPrompt(slot.item, style.style);
            } else if (slot.item) {
              prompt = wildcardPrompt(slot.item, slot.subtype || "general", style.style);
            }
            if (prompt) {
              console.log(`  🎨 Regenerating Recraft image (${style.id})...`);
              const pathname = `posters/${date}-${slotType}-${Date.now()}.png`;
              const { url } = await generateAndUpload({ prompt, pathname, colors: style.colors || undefined });
              slot.imageUrl = url;
              slot.imageStyle = style.id;
              slot.imageApprovedAt = null; // reset approval on regen
              console.log(`  ✅ Image regenerated: ${url.slice(0, 80)}`);
            }
          } catch (err) {
            console.error(`  ⚠️  Recraft regeneration failed: ${err.message}`);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err.message }));
            return;
          }
          saveScheduleFile(schedule);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, schedule }));
          return;
        }

        if (action === "edit-copy") {
          const params = JSON.parse(body || "{}");
          if (!params.instructions) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Missing instructions" }));
            return;
          }
          try {
            const rewritten = await rewriteCopyWithEdits(slot.copy, params.instructions, slot.item || {});
            slot.copy = rewritten;
            slot.copyApprovedAt = null; // reset approval after edit
            slot.status = "draft";
            console.log(`  ✏️  Copy edited: ${date} ${slotType}`);
          } catch (err) {
            console.error(`  ⚠️  Edit failed: ${err.message}`);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err.message }));
            return;
          }
          saveScheduleFile(schedule);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, schedule }));
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Unknown action" }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/replies") {
    const replies = loadReplies();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(replies));
    return;
  }

  if (req.method === "POST" && req.url === "/api/reply-action") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { id, actionNote } = JSON.parse(body);
        if (!id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Missing reply id" }));
          return;
        }
        const replies = loadReplies();
        const reply = replies.find((r) => r.id === id);
        if (!reply) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Reply not found" }));
          return;
        }
        reply.actionNote = actionNote || null;
        saveReplies(replies);
        console.log(`\n📝 Action saved for reply ${id}: "${actionNote || "(cleared)"}"`);

        // Process action commands from the note
        let actionResult = null;
        if (actionNote) {
          const context = {
            title: reply.postTitle || "",
            source: "",
            venue: "",
            city: "",
            category: "",
            url: reply.permalink || "",
          };
          try {
            actionResult = await processComment(actionNote, context);
          } catch (err) {
            console.error(`  ⚠ Action processing failed:`, err.message);
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          actionResult: actionResult?.summary || null,
        }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML);
});

server.listen(PORT, () => {
  const posts = loadPendingPosts();
  const queue = loadQueue();
  console.log(`\n🗳️  Social Copy Review: http://localhost:${PORT}`);
  console.log(`   ${posts.length} drafts to review`);
  console.log(`   ${queue.length} in approved queue`);
  console.log(`   ← skip  |  approve →  |  Tab for comment box\n`);
});
