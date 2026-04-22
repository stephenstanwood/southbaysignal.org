#!/usr/bin/env node
/**
 * photo-review-server.mjs
 * Tiny local server for reviewing photos with persistent votes.
 *
 * Run:  node scripts/photo-review-server.mjs
 * Opens http://localhost:4567 in your browser automatically.
 *
 * Votes are saved to: photo-votes.json (✓ = approved, ✗ = rejected)
 * Photos are loaded from: photo-data.json (run photo-review.mjs first if missing)
 */

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_FILE  = join(ROOT, "photo-data.json");
const VOTES_FILE = join(ROOT, "photo-votes.json");
const PORT = 4567;

// ── Load / init data ──────────────────────────────────────────────────────────

if (!existsSync(DATA_FILE)) {
  console.error("❌ photo-data.json not found. Run: node scripts/photo-review.mjs first");
  process.exit(1);
}

const photos = JSON.parse(readFileSync(DATA_FILE, "utf8"));

// Seed votes from the canonical approved/rejected sources so the Unvoted
// filter actually shows fresh photos, not ones Stephen has already triaged.
//   approved → src/data/south-bay/curated-photos.json (ids already in the site)
//   rejected → scripts/blocked-photos.mjs BLOCKED_IDS (hard-blocked)
function readSeedVotes() {
  const approved = new Set();
  const rejected = new Set();
  try {
    const curated = JSON.parse(readFileSync(join(ROOT, "src/data/south-bay/curated-photos.json"), "utf8"));
    for (const p of curated.photos || []) if (p.id) approved.add(p.id);
  } catch {}
  try {
    const src = readFileSync(join(ROOT, "scripts/blocked-photos.mjs"), "utf8");
    for (const m of src.matchAll(/"([^"\n]+)"/g)) rejected.add(m[1]);
  } catch {}
  return { approved, rejected };
}

function loadVotes() {
  const seed = readSeedVotes();
  let saved = { approved: [], rejected: [] };
  if (existsSync(VOTES_FILE)) {
    try { saved = JSON.parse(readFileSync(VOTES_FILE, "utf8")); } catch {}
  }
  // Union saved + seed so in-session edits persist but we never re-show a
  // photo that's already approved-on-site or hard-blocked.
  const approved = new Set([...(saved.approved || []), ...seed.approved]);
  const rejected = new Set([...(saved.rejected || []), ...seed.rejected]);

  // Cutoff-based auto-reject: Stephen's initial approve/deny run landed on
  // 2026-03-30 (commit "158 curated photos"). Anything in today's photo-data
  // that isn't approved was almost certainly already rejected back then. Treat
  // every un-approved, un-rejected photo as rejected so the Unvoted filter
  // surfaces ONLY genuinely new photos (those pulled in by future photo-review
  // runs from Flickr/Wikimedia/etc).
  for (const p of photos) {
    if (!approved.has(p.id) && !rejected.has(p.id)) rejected.add(p.id);
  }

  return {
    approved: [...approved],
    rejected: [...rejected],
    lastUpdated: saved.lastUpdated,
  };
}

function saveVotes(votes) {
  votes.lastUpdated = new Date().toISOString();
  writeFileSync(VOTES_FILE, JSON.stringify(votes, null, 2));
}

// ── HTML page ─────────────────────────────────────────────────────────────────

function buildPage(votes) {
  const approved = new Set(votes.approved);
  const rejected = new Set(votes.rejected);
  const remaining = photos.filter(p => !approved.has(p.id) && !rejected.has(p.id)).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>South Bay Photo Review (${remaining} remaining)</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, sans-serif; background: #f0ede6; color: #1a1a1a; }

  /* ── Header ── */
  header {
    background: #1a1a1a; color: #f5f5f0; padding: 10px 16px;
    display: flex; align-items: center; gap: 10px;
    position: sticky; top: 0; z-index: 10;
  }
  header h1 { font-size: 12px; font-weight: 700; flex: 1; }
  .pill { font-size: 11px; padding: 3px 10px; border-radius: 20px; font-weight: 700; white-space: nowrap; }
  .pill-green { background: #22c55e; color: #fff; }
  .pill-red   { background: #ef4444; color: #fff; }
  .pill-grey  { background: #555; color: #fff; }
  .review-btn {
    background: #f5f5f0; color: #1a1a1a; border: none;
    padding: 5px 14px; border-radius: 5px; font-size: 12px;
    font-weight: 700; cursor: pointer; white-space: nowrap;
  }
  .review-btn:hover { background: #e0ddd6; }

  /* ── Filters ── */
  .filters {
    padding: 8px 16px; background: #fff;
    border-bottom: 1px solid #e0ddd6;
    display: flex; gap: 5px; flex-wrap: wrap; align-items: center;
  }
  .filter-btn {
    padding: 3px 10px; border: 1px solid #ccc;
    border-radius: 20px; background: none; cursor: pointer; font-size: 11px;
  }
  .filter-btn.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }

  /* ── Grid ── */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 3px; padding: 10px 16px;
  }
  .photo-card {
    position: relative; overflow: hidden; cursor: pointer;
    border-radius: 3px; aspect-ratio: 1; background: #ccc;
  }
  .photo-card img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.15s; }
  .photo-card:hover img { transform: scale(1.04); }
  .photo-card.approved { outline: 3px solid #22c55e; outline-offset: -3px; }
  .photo-card.rejected { opacity: 0.2; }
  .grid-overlay {
    position: absolute; inset: 0; display: flex;
    align-items: flex-end; justify-content: center; gap: 10px; padding-bottom: 10px;
    background: linear-gradient(transparent 50%, rgba(0,0,0,0.55));
    opacity: 0; transition: opacity 0.15s;
  }
  .photo-card:hover .grid-overlay,
  .photo-card.approved .grid-overlay,
  .photo-card.rejected .grid-overlay { opacity: 1; }
  .src-badge {
    position: absolute; top: 4px; left: 4px;
    font-size: 8px; font-weight: 700; padding: 2px 5px; border-radius: 2px; pointer-events: none;
  }
  .src-flickr      { background: #ff0084; color: #fff; }
  .src-wikimedia   { background: #3b82f6; color: #fff; }
  .src-unsplash    { background: #000;    color: #fff; }
  .src-inaturalist { background: #74ac00; color: #fff; }
  .src-nasa        { background: #0b3d91; color: #fff; }
  .lic-badge {
    position: absolute; bottom: 38px; left: 4px;
    font-size: 8px; background: rgba(0,0,0,0.65); color: #fff;
    padding: 2px 4px; border-radius: 2px; font-family: monospace; pointer-events: none;
  }
  .small-vote {
    width: 32px; height: 32px; border-radius: 50%; border: 2px solid #fff;
    font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.15); transition: transform 0.1s, background 0.1s;
    -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
    color: #fff;
  }
  .small-vote:hover { transform: scale(1.2); }
  .small-approve:hover, .photo-card.approved .small-approve { background: #22c55e; border-color: #22c55e; }
  .small-reject:hover,  .photo-card.rejected .small-reject  { background: #ef4444; border-color: #ef4444; }
  .empty { padding: 40px; color: #999; text-align: center; }

  /* ── Lightbox ── */
  #lightbox {
    display: none; position: fixed; inset: 0; z-index: 100;
    background: rgba(0,0,0,0.92);
    flex-direction: column; align-items: center; justify-content: center;
  }
  #lightbox.open { display: flex; }
  #lb-img-wrap {
    flex: 1; display: flex; align-items: center; justify-content: center;
    width: 100%; padding: 16px; min-height: 0;
  }
  #lb-img {
    max-width: 100%; max-height: 100%;
    object-fit: contain; border-radius: 4px;
    transition: opacity 0.15s;
  }
  #lb-img.fading { opacity: 0; }
  #lb-bar {
    width: 100%; padding: 16px 24px;
    display: flex; align-items: center; gap: 20px;
    background: rgba(0,0,0,0.6);
    flex-shrink: 0;
  }
  #lb-info { flex: 1; min-width: 0; }
  #lb-title {
    font-size: 13px; font-weight: 600; color: #f5f5f0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-bottom: 3px;
  }
  #lb-meta { font-size: 11px; color: #999; }
  #lb-counter { font-size: 11px; color: #666; white-space: nowrap; }
  .lb-vote {
    width: 56px; height: 56px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.3); font-size: 24px;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: transform 0.12s, background 0.12s, border-color 0.12s;
    background: rgba(255,255,255,0.08); color: #fff; flex-shrink: 0;
  }
  .lb-vote:hover { transform: scale(1.12); }
  #lb-reject:hover  { background: #ef4444; border-color: #ef4444; }
  #lb-approve:hover { background: #22c55e; border-color: #22c55e; }
  #lb-close {
    position: absolute; top: 14px; right: 18px;
    font-size: 22px; color: #666; background: none; border: none;
    cursor: pointer; line-height: 1;
  }
  #lb-close:hover { color: #fff; }
  #lb-hint { font-size: 10px; color: #444; text-align: center; padding: 6px; flex-shrink: 0; }
</style>
</head>
<body>

<header>
  <h1>South Bay Photos</h1>
  <span class="pill pill-green" id="cnt-approved">${votes.approved.length} ✓</span>
  <span class="pill pill-red"   id="cnt-rejected">${votes.rejected.length} ✗</span>
  <span class="pill pill-grey"  id="cnt-remaining">${remaining} left</span>
  <button class="review-btn" onclick="startReview()">▶ Review mode</button>
</header>

<div class="filters">
  <span style="font-size:11px;color:#666">Show:</span>
  <button class="filter-btn active" onclick="setFilter('unvoted',this)">Unvoted (<span id="fcnt-unvoted">${remaining}</span>)</button>
  <button class="filter-btn" onclick="setFilter('all',this)">All (<span id="fcnt-all">${photos.length}</span>)</button>
  <button class="filter-btn" onclick="setFilter('approved',this)">Approved (<span id="fcnt-approved">${votes.approved.length}</span>)</button>
  <button class="filter-btn" onclick="setFilter('rejected',this)">Rejected (<span id="fcnt-rejected">${votes.rejected.length}</span>)</button>
  <span style="margin-left:6px;font-size:11px;color:#666">Source:</span>
  <button class="filter-btn active" onclick="setSource('all',this)">All</button>
  <button class="filter-btn" onclick="setSource('flickr',this)">Flickr</button>
  <button class="filter-btn" onclick="setSource('wikimedia',this)">Wikimedia</button>
  <button class="filter-btn" onclick="setSource('unsplash',this)">Unsplash</button>
  <button class="filter-btn" onclick="setSource('inaturalist',this)">iNaturalist</button>
  <button class="filter-btn" onclick="setSource('nasa',this)">NASA</button>
</div>

<div class="grid" id="grid"></div>

<!-- Lightbox -->
<div id="lightbox">
  <button id="lb-close" onclick="closeLightbox()">✕</button>
  <div id="lb-img-wrap">
    <img id="lb-img" src="" alt="">
  </div>
  <div id="lb-hint">← reject  ·  → approve  ·  Esc close</div>
  <div id="lb-bar">
    <button class="lb-vote" id="lb-reject"  onclick="lbVote('rejected')">✗</button>
    <div id="lb-info">
      <div id="lb-title"></div>
      <div id="lb-meta"></div>
    </div>
    <span id="lb-counter"></span>
    <button class="lb-vote" id="lb-approve" onclick="lbVote('approved')">✓</button>
  </div>
</div>

<script>
const photos = ${JSON.stringify(photos)};
const votes = {
  approved: new Set(${JSON.stringify(votes.approved)}),
  rejected:  new Set(${JSON.stringify(votes.rejected)}),
};
let gridFilter = "unvoted";
let gridSource = "all";

// ── Lightbox state ──
let lbQueue = [];   // ordered list of photo ids currently in review
let lbIndex = 0;    // current position in lbQueue

function getState(p) {
  if (votes.approved.has(p.id)) return "approved";
  if (votes.rejected.has(p.id)) return "rejected";
  return "unvoted";
}

function visiblePhotos() {
  return photos.filter(p => {
    if (gridSource !== "all" && p.source !== gridSource) return false;
    const s = getState(p);
    if (gridFilter === "unvoted")  return s === "unvoted";
    if (gridFilter === "approved") return s === "approved";
    if (gridFilter === "rejected") return s === "rejected";
    return true;
  });
}

// ── Grid ──
function render() {
  const grid = document.getElementById("grid");
  const list = visiblePhotos();
  if (!list.length) { grid.innerHTML = '<div class="empty">Nothing here.</div>'; return; }
  grid.innerHTML = list.map((p, i) => {
    const s = getState(p);
    return \`<div class="photo-card \${s}" id="card-\${p.id}" onclick="openLightbox(\${i})">
      <img src="\${p.thumb}" alt="\${p.title}" onerror="this.closest('.photo-card').remove()">
      <span class="src-badge src-\${p.source}">\${p.sourceName||p.source}</span>
      <span class="lic-badge">\${p.license}</span>
      <div class="grid-overlay">
        <button class="small-vote small-reject"  onclick="event.stopPropagation();gridVote('\${p.id}','rejected')"  title="Skip">✗</button>
        <button class="small-vote small-approve" onclick="event.stopPropagation();gridVote('\${p.id}','approved')" title="Keep">✓</button>
      </div>
    </div>\`;
  }).join("");
}

// ── Voting ──
async function persistVote(id, decision) {
  votes.approved.delete(id);
  votes.rejected.delete(id);
  votes[decision].add(id);
  updateCounts();
  try {
    await fetch("/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });
  } catch (e) { console.error("vote failed", e); }
}

async function gridVote(id, decision) {
  await persistVote(id, decision);
  const card = document.getElementById("card-" + id);
  if (card) {
    card.className = "photo-card " + decision;
    if (gridFilter === "unvoted") {
      card.style.transition = "opacity 0.25s";
      card.style.opacity = "0";
      setTimeout(() => card.remove(), 280);
    }
  }
}

// ── Lightbox ──
function openLightbox(startIndex) {
  lbQueue = visiblePhotos().map(p => p.id);
  lbIndex = startIndex;
  showLbPhoto();
  document.getElementById("lightbox").classList.add("open");
  document.body.style.overflow = "hidden";
}

function startReview() {
  // always start from unvoted
  const unvoted = photos.filter(p => !votes.approved.has(p.id) && !votes.rejected.has(p.id));
  if (!unvoted.length) { alert("All photos reviewed!"); return; }
  lbQueue = unvoted.map(p => p.id);
  lbIndex = 0;
  showLbPhoto();
  document.getElementById("lightbox").classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  document.getElementById("lightbox").classList.remove("open");
  document.body.style.overflow = "";
  render(); // refresh grid
}

function showLbPhoto() {
  if (lbIndex >= lbQueue.length) { closeLightbox(); return; }
  const p = photos.find(x => x.id === lbQueue[lbIndex]);
  if (!p) { lbIndex++; showLbPhoto(); return; }

  const img = document.getElementById("lb-img");
  img.classList.add("fading");
  setTimeout(() => {
    img.src = p.full || p.thumb;
    img.alt = p.title;
    img.onload = () => img.classList.remove("fading");
    img.onerror = () => { lbIndex++; showLbPhoto(); };
  }, 120);

  document.getElementById("lb-title").textContent = p.title || "(untitled)";
  document.getElementById("lb-meta").textContent =
    (p.photographer ? p.photographer + "  ·  " : "") + p.license + "  ·  " + (p.sourceName || p.source);
  document.getElementById("lb-counter").textContent =
    (lbIndex + 1) + " / " + lbQueue.length;
}

async function lbVote(decision) {
  const id = lbQueue[lbIndex];
  if (!id) return;
  await persistVote(id, decision);
  // flash the button
  const btn = document.getElementById(decision === "approved" ? "lb-approve" : "lb-reject");
  btn.style.background = decision === "approved" ? "#22c55e" : "#ef4444";
  btn.style.borderColor = btn.style.background;
  setTimeout(() => { btn.style.background = ""; btn.style.borderColor = ""; }, 300);
  lbIndex++;
  showLbPhoto();
}

// ── Keyboard ──
document.addEventListener("keydown", e => {
  const lb = document.getElementById("lightbox");
  if (!lb.classList.contains("open")) return;
  if (e.key === "ArrowRight" || e.key === "l") lbVote("approved");
  else if (e.key === "ArrowLeft" || e.key === "h") lbVote("rejected");
  else if (e.key === "Escape") closeLightbox();
});

function updateCounts() {
  const a = votes.approved.size, r = votes.rejected.size;
  const rem = photos.filter(p => !votes.approved.has(p.id) && !votes.rejected.has(p.id)).length;
  document.getElementById("cnt-approved").textContent  = a + " ✓";
  document.getElementById("cnt-rejected").textContent  = r + " ✗";
  document.getElementById("cnt-remaining").textContent = rem + " left";
  document.getElementById("fcnt-approved").textContent = a;
  document.getElementById("fcnt-rejected").textContent = r;
  document.getElementById("fcnt-unvoted").textContent  = rem;
  document.title = "South Bay Photo Review (" + rem + " remaining)";
  document.getElementById("lb-counter").textContent = (lbIndex + 1) + " / " + lbQueue.length;
}

function setFilter(f, btn) {
  gridFilter = f;
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  render();
}
function setSource(s, btn) {
  gridSource = s;
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  render();
}

render();
</script>
</body>
</html>`;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    const votes = loadVotes();
    const html = buildPage(votes);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  if (req.method === "POST" && req.url === "/vote") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const { id, decision } = JSON.parse(body);
        const votes = loadVotes();
        // remove from both, add to correct list
        votes.approved = votes.approved.filter(x => x !== id);
        votes.rejected = votes.rejected.filter(x => x !== id);
        if (decision === "approved") votes.approved.push(id);
        else if (decision === "rejected") votes.rejected.push(id);
        saveVotes(votes);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end("bad request");
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n📷 Photo review server running at http://localhost:${PORT}`);
  console.log(`   Votes saved to: ${VOTES_FILE}`);
  console.log(`   Ctrl+C to stop\n`);
  // auto-open
  const open = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${open} http://localhost:${PORT}`);
});
