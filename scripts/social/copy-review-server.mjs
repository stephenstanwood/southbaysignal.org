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
import { execFile } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3456;
const POST_DIR = "/tmp/sbs-social";
const QUEUE_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-approved-queue.json");
const REVIEW_HISTORY_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-review-history.json");
const REPLIES_FILE = join(__dirname, "..", "..", "src", "data", "south-bay", "social-replies.json");
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

// Clear old post files and generate a new batch
function generateNewBatch() {
  if (isGenerating) return;
  isGenerating = true;
  console.log(`\n🔄 Generating next batch of ${BATCH_SIZE} posts...`);

  // Clear old post files
  if (existsSync(POST_DIR)) {
    for (const f of readdirSync(POST_DIR)) {
      if (f.startsWith("post-") && f.endsWith(".json")) {
        unlinkSync(join(POST_DIR, f));
      }
    }
  }

  const nodePath = process.execPath;
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
<title>SBS Social Review</title>
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
</style>
</head>
<body>
<h1>The South Bay Signal</h1>

<div class="tab-bar" id="tab-bar">
  <button class="tab-btn active" onclick="switchTab('review')" id="tab-review">Review <span class="tab-count" id="tab-review-count"></span></button>
  <button class="tab-btn" onclick="switchTab('replies')" id="tab-replies">Replies <span class="tab-count" id="tab-replies-count"></span></button>
</div>

<div id="review-tab">
  <div class="counter" id="counter"></div>
  <div id="queue-badge" class="queue-badge"></div>
  <div class="shortcuts" id="shortcuts"><kbd>&larr;</kbd> reject &nbsp; <kbd>&rarr;</kbd> approve &nbsp; <kbd>Tab</kbd> comment box</div>

  <div id="review-area">
    <div class="item-header" id="item-header"></div>
    <div class="platforms" id="platforms"></div>
    <div class="comment-section">
      <textarea class="comment-input" id="comment" placeholder="Notes or edit suggestions (optional)..." rows="1"></textarea>
    </div>
    <div class="buttons" id="buttons">
      <button class="btn btn-reject" onclick="vote('reject')">&larr; Skip</button>
      <button class="btn btn-approve" onclick="vote('approve')">Approve &rarr;</button>
    </div>
  </div>
  <div class="done" id="done" style="display:none"></div>
</div>

<div id="replies-view">
  <div id="replies-list"></div>
</div>

<script>
let posts = [];
let current = 0;
let results = [];
let queueSize = 0;
let currentTab = 'review';
let repliesData = [];

const PLATFORM_ICONS = { x: '\\ud835\\udd4f', threads: '\\ud83e\\uddf5', bluesky: '\\ud83e\\udd8b', facebook: '\\ud83d\\udcd8' };

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tab-review').className = 'tab-btn' + (tab === 'review' ? ' active' : '');
  document.getElementById('tab-replies').className = 'tab-btn' + (tab === 'replies' ? ' active' : '');
  document.getElementById('review-tab').style.display = tab === 'review' ? '' : 'none';
  document.getElementById('replies-view').style.display = tab === 'replies' ? '' : 'none';
  if (tab === 'replies') loadReplies();
}

function updateTabCounts(draftCount, repliesNewCount) {
  document.getElementById('tab-review-count').textContent = draftCount > 0 ? '(' + draftCount + ' drafts)' : '';
  document.getElementById('tab-replies-count').textContent = repliesNewCount > 0 ? '(' + repliesNewCount + ' new)' : '';
}

function updateQueueBadge(size) {
  queueSize = size;
  const el = document.getElementById('queue-badge');
  el.textContent = size + ' in approved queue';
  el.className = 'queue-badge' + (size < 40 ? ' low' : size < 60 ? ' mid' : '');
}

async function init() {
  const res = await fetch('/api/posts');
  const data = await res.json();
  posts = data.posts;
  updateQueueBadge(data.queueSize);

  // Fetch reply count for tab badge
  try {
    const rRes = await fetch('/api/replies');
    const rData = await rRes.json();
    repliesData = rData;
    const newCount = rData.filter(r => r.classification && !r.responded && !r.actionNote).length;
    updateTabCounts(posts.length, newCount);
  } catch {
    updateTabCounts(posts.length, 0);
  }

  if (posts.length === 0) {
    document.getElementById('review-area').style.display = 'none';
    document.getElementById('shortcuts').style.display = 'none';
    document.getElementById('done').style.display = 'block';
    document.getElementById('done').innerHTML = '<div class="empty"><h2>No drafts to review</h2><p>Generate some with:<br><code>node scripts/social/generate-posts.mjs --max 20</code></p></div>';
    return;
  }
  render();
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

function vote(v) {
  const el = document.getElementById('platforms');
  el.classList.add(v === 'approve' ? 'swipe-right' : 'swipe-left');
  const comment = document.getElementById('comment').value.trim();
  results.push({
    file: posts[current]._file,
    title: posts[current].item?.title || '',
    vote: v,
    comment: comment || null,
  });
  if (v === 'approve') updateQueueBadge(queueSize + 1);
  setTimeout(() => { current++; render(); }, 300);
}

// --- Replies ---

async function loadReplies() {
  try {
    const res = await fetch('/api/replies');
    repliesData = await res.json();
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
      btn.textContent = 'Saved';
      setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
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
  if (e.key === 'Tab') {
    e.preventDefault();
    document.getElementById('comment').focus();
  }
});

init();
</script>
</body>
</html>`;

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/posts") {
    const posts = loadPendingPosts();
    const queue = loadQueue();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ posts, queueSize: queue.length }));
    return;
  }

  if (req.method === "GET" && req.url === "/api/status") {
    const posts = loadPendingPosts();
    const queue = loadQueue();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ generating: isGenerating, pendingCount: posts.length, queueSize: queue.length }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/generate") {
    generateNewBatch();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, generating: true }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/review") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
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

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, queueSize: queue.length }));
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
    req.on("end", () => {
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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
