#!/usr/bin/env node
/**
 * photo-review.mjs
 * Fetches photos from Flickr, Unsplash (if key available), and Wikimedia Commons
 * for the South Bay area, then generates a local HTML picker (photo-review.html).
 *
 * Run: node scripts/photo-review.mjs
 * Then open: photo-review.html in your browser
 *
 * Click photos to select, then "Copy Selected" to paste the list back to Claude.
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Load .env.local
if (existsSync(join(ROOT, ".env.local"))) {
  const env = readFileSync(join(ROOT, ".env.local"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const FLICKR_KEY = process.env.FLICKR_API_KEY;
const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY || null;

if (!FLICKR_KEY) { console.error("❌ FLICKR_API_KEY not set"); process.exit(1); }

const UA = "SouthBaySignal/1.0 (southbaysignal.org; educational/noncommercial)";

// Photos permanently removed from the curated set — never re-add on regeneration
// Canonical list lives in blocked-photos.mjs (shared with build-curated-photos.mjs)
import { BLOCKED_IDS } from "./blocked-photos.mjs";

// ── Flickr ────────────────────────────────────────────────────────────────────
const SB_BBOX = "-122.20,37.19,-121.77,37.47";
const CC_LICENSES = "4,5,6,9,10";

function licenseLabel(id) {
  return { "4": "CC BY", "5": "CC BY-SA", "6": "CC BY-ND", "9": "CC0", "10": "PDM" }[String(id)] || "CC";
}

async function flickrFetch(tags) {
  const params = new URLSearchParams({
    method: "flickr.photos.search",
    api_key: FLICKR_KEY,
    bbox: SB_BBOX,
    tags,
    tag_mode: "any",
    license: CC_LICENSES,
    sort: "interestingness-desc",
    per_page: "50",
    page: "1",
    extras: "url_m,url_l,owner_name,license,title,tags",
    content_type: "1",
    safe_search: "1",
    format: "json",
    nojsoncallback: "1",
  });
  const res = await fetch(`https://www.flickr.com/services/rest/?${params}`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Flickr ${res.status}`);
  const data = await res.json();
  if (data.stat !== "ok") throw new Error(`Flickr: ${data.message}`);
  return { photos: data.photos.photo, total: parseInt(data.photos.total, 10) };
}

async function fetchFlickr() {
  console.log("📷 Flickr: fetching photos...");
  const tagSets = [
    "aerial,satellite,drone,overhead,birdseye",
    "nature,landscape,scenery,park,trail,hills,bay,creek,reservoir",
    "architecture,skyline,cityscape,downtown,landmark",
  ];
  const seen = new Set();
  const results = [];
  let maxTotal = 0;

  for (const tags of tagSets) {
    try {
      const { photos, total } = await flickrFetch(tags);
      maxTotal = Math.max(maxTotal, total);
      for (const p of photos) {
        if (!p.url_m || seen.has(p.id)) continue;
        seen.add(p.id);
        results.push({
          source: "flickr",
          id: `flickr-${p.id}`,
          thumb: p.url_m,
          full: p.url_l || p.url_m,
          title: p.title || "(untitled)",
          photographer: p.ownername || "",
          photoPage: `https://www.flickr.com/photos/${p.owner}/${p.id}`,
          license: licenseLabel(p.license),
        });
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) { console.warn(`  Flickr tags "${tags}" failed: ${e.message}`); }
  }

  console.log(`  → ${results.length} photos (pool: ~${maxTotal} CC-licensed in region)`);
  return { photos: results, poolSize: maxTotal };
}

// ── Unsplash ──────────────────────────────────────────────────────────────────

async function unsplashFetch(query, perPage = 30) {
  const params = new URLSearchParams({ query, per_page: String(perPage), orientation: "landscape" });
  const res = await fetch(`https://api.unsplash.com/search/photos?${params}`, {
    headers: { Authorization: `Client-ID ${UNSPLASH_KEY}`, "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Unsplash ${res.status}`);
  return res.json();
}

async function fetchUnsplash() {
  if (!UNSPLASH_KEY) {
    console.log("⚪ Unsplash: skipping (no UNSPLASH_ACCESS_KEY)");
    return { photos: [], poolSize: 0 };
  }
  console.log("🌄 Unsplash: fetching photos...");
  const queries = [
    "South Bay California aerial",
    "Silicon Valley landscape",
    "San Jose California",
    "Santa Clara County nature",
    "Bay Area aerial view",
  ];
  const seen = new Set();
  const results = [];
  let maxTotal = 0;

  for (const query of queries) {
    try {
      const data = await unsplashFetch(query, 20);
      maxTotal = Math.max(maxTotal, data.total || 0);
      for (const p of data.results ?? []) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        results.push({
          source: "unsplash",
          id: `unsplash-${p.id}`,
          thumb: p.urls.small,
          full: p.urls.regular,
          title: p.alt_description || p.description || "(untitled)",
          photographer: p.user?.name || "",
          photoPage: p.links?.html || "",
          license: "Unsplash",
        });
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (e) { console.warn(`  Unsplash "${query}" failed: ${e.message}`); }
  }

  console.log(`  → ${results.length} photos (pool: ~${maxTotal} total matching)`);
  return { photos: results, poolSize: maxTotal };
}

// ── Wikimedia Commons ─────────────────────────────────────────────────────────

async function wikimediaCategorySearch(category, limit = 50) {
  const params = new URLSearchParams({
    action: "query", list: "categorymembers",
    cmtitle: `Category:${category}`, cmtype: "file",
    cmlimit: String(limit), format: "json", origin: "*",
  });
  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`WM category ${res.status}`);
  const data = await res.json();
  return (data.query?.categorymembers ?? []).map(m => m.title);
}

async function wikimediaGeosearch(lat, lon, radius = 50000, limit = 100) {
  const params = new URLSearchParams({
    action: "query", list: "geosearch",
    gsnamespace: "6", gscoord: `${lat}|${lon}`,
    gsradius: String(radius), gslimit: String(limit),
    format: "json", origin: "*",
  });
  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`WM geo ${res.status}`);
  const data = await res.json();
  return (data.query?.geosearch ?? []).map(g => g.title);
}

async function wikimediaGetThumbs(titles) {
  const results = [];
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50).join("|");
    const params = new URLSearchParams({
      action: "query", titles: batch,
      prop: "imageinfo", iiprop: "url|extmetadata|size",
      iiurlwidth: "400", format: "json", origin: "*",
    });
    try {
      const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
        headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const page of Object.values(data.query?.pages ?? {})) {
        const ii = page.imageinfo?.[0];
        if (!ii?.thumburl) continue;
        // only allow common raster photo formats
        if (!/\.(jpe?g|png|webp)$/i.test(page.title)) continue;
        const meta = ii.extmetadata ?? {};
        const license = (meta.LicenseShortName?.value || "CC").replace(/<[^>]+>/g, "").trim();
        if (/all rights reserved/i.test(license)) continue;
        const desc = (meta.ImageDescription?.value || "").replace(/<[^>]+>/g, "").trim().slice(0, 120);
        const author = (meta.Artist?.value || "").replace(/<[^>]+>/g, "").trim().slice(0, 60);
        results.push({
          source: "wikimedia",
          id: `wm-${page.pageid}`,
          thumb: ii.thumburl,
          full: ii.url,
          title: desc || page.title.replace(/^File:/, "").replace(/\.[^.]+$/, ""),
          photographer: author || "Wikimedia Commons",
          photoPage: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
          license,
        });
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (e) { console.warn(`  WM thumb batch failed: ${e.message}`); }
  }
  return results;
}

async function fetchWikimedia() {
  console.log("🌐 Wikimedia Commons: fetching photos...");
  const allTitles = new Set();

  // Geosearch centered on South Bay
  try {
    const geo = await wikimediaGeosearch(37.3382, -121.8863, 50000, 100);
    geo.forEach(t => allTitles.add(t));
    console.log(`  → geosearch: ${geo.length} files`);
  } catch (e) { console.warn(`  Geosearch failed: ${e.message}`); }
  await new Promise(r => setTimeout(r, 300));

  // Categories — aerial, satellite, nature, architecture
  const categories = [
    // Aerial / satellite
    "Aerial_photographs_of_Santa_Clara_County,_California",
    "Aerial_photographs_of_San_Jose,_California",
    "Aerial_photographs_of_Cupertino",
    "Sentinel-1_images_of_California",
    "Satellite_images_of_Santa_Clara_County",
    "Aerial_photographs_of_San_Francisco_Bay_Area",
    "Aerial_photographs_of_Mountain_View,_California",
    "Aerial_photographs_of_Palo_Alto,_California",
    // Nature / landscape
    "Parks_in_Santa_Clara_County,_California",
    "Nature_of_Santa_Clara_County,_California",
    "Creeks_of_Santa_Clara_County,_California",
    "Hills_of_Santa_Clara_County,_California",
    "San_Francisco_Bay_Area_scenery",
    // Water / infrastructure
    "Santa_Clara_Valley_Water_District",
    "Reservoirs_of_Santa_Clara_County,_California",
    // Architecture / landmarks
    "Apple_Park",
    "Levi's_Stadium",
    "SAP_Center",
    "Santana_Row",
    "Stanford_University_campus",
  ];

  for (const cat of categories) {
    try {
      const members = await wikimediaCategorySearch(cat, 30);
      members.forEach(t => allTitles.add(t));
      console.log(`  → ${cat}: ${members.length} files`);
      await new Promise(r => setTimeout(r, 200));
    } catch (e) { /* skip missing categories silently */ }
  }

  const titleList = [...allTitles];
  console.log(`  → ${titleList.length} unique files — fetching thumbnails...`);
  const photos = await wikimediaGetThumbs(titleList);
  console.log(`  → ${photos.length} usable photos`);
  return { photos, poolSize: titleList.length };
}

// ── HTML review page ──────────────────────────────────────────────────────────

function buildHtml(sources) {
  const all = sources.flatMap(s => s.photos.map(p => ({ ...p, sourceName: s.name })))
    .filter(p => !BLOCKED_IDS.has(p.id));
  const poolInfo = sources.map(s => `${s.name}: ~${s.poolSize} in region`).join("  ·  ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>South Bay Photo Review</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, sans-serif; background: #f0ede6; color: #1a1a1a; }
  header {
    background: #1a1a1a; color: #f5f5f0; padding: 12px 20px;
    display: flex; align-items: center; gap: 12px;
    position: sticky; top: 0; z-index: 10;
  }
  header h1 { font-size: 14px; font-weight: 700; flex: 1; }
  .stats { font-size: 12px; color: #aaa; }
  .copy-btn {
    background: #22c55e; color: #fff; border: none;
    padding: 7px 16px; border-radius: 5px; font-size: 12px;
    font-weight: 700; cursor: pointer; white-space: nowrap;
  }
  .copy-btn:disabled { background: #555; cursor: default; }
  .copy-btn.copied { background: #16a34a; }
  .filters {
    padding: 10px 20px; background: #fff;
    border-bottom: 1px solid #e0ddd6;
    display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
  }
  .filter-btn {
    padding: 4px 11px; border: 1px solid #ccc;
    border-radius: 20px; background: none; cursor: pointer; font-size: 11px;
  }
  .filter-btn.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  .pool-info { padding: 6px 20px; font-size: 10px; color: #999; background: #fff; border-bottom: 1px solid #e0ddd6; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 3px; padding: 12px 20px;
  }
  .photo-card {
    position: relative; cursor: pointer; overflow: hidden;
    border-radius: 3px; aspect-ratio: 1; background: #ccc;
  }
  .photo-card img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.15s; }
  .photo-card:hover img { transform: scale(1.05); }
  .photo-card.selected { outline: 4px solid #22c55e; outline-offset: -4px; }
  .check {
    position: absolute; top: 5px; right: 5px;
    width: 22px; height: 22px; border-radius: 50%;
    background: #22c55e; color: #fff; font-size: 12px;
    display: none; align-items: center; justify-content: center; font-weight: 700;
  }
  .photo-card.selected .check { display: flex; }
  .lic-badge {
    position: absolute; bottom: 5px; left: 5px;
    font-size: 8px; background: rgba(0,0,0,0.65); color: #fff;
    padding: 2px 4px; border-radius: 2px; font-family: monospace;
  }
  .src-badge {
    position: absolute; top: 5px; left: 5px;
    font-size: 8px; font-weight: 700;
    padding: 2px 5px; border-radius: 2px;
  }
  .src-flickr { background: #ff0084; color: #fff; }
  .src-wikimedia { background: #3b82f6; color: #fff; }
  .src-unsplash { background: #000; color: #fff; }
  .src-inaturalist { background: #74ac00; color: #fff; }
  .src-nasa { background: #0b3d91; color: #fff; }
  .empty { padding: 40px; color: #999; text-align: center; }
  .photo-title {
    position: absolute; bottom: 0; left: 0; right: 0;
    background: linear-gradient(transparent, rgba(0,0,0,0.75));
    color: #fff; font-size: 9px; padding: 16px 5px 5px;
    opacity: 0; transition: opacity 0.15s;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .photo-card:hover .photo-title { opacity: 1; }
</style>
</head>
<body>

<header>
  <h1>South Bay Photo Review — click to select, then Copy Selected → paste to Claude</h1>
  <span class="stats" id="stats">0 selected</span>
  <button class="copy-btn" id="copy-btn" disabled onclick="copySelected()">Copy Selected</button>
</header>

<div class="filters">
  <span style="font-size:11px;color:#666">Source:</span>
  <button class="filter-btn active" onclick="setFilter('all',this)">All (<span id="cnt-all">0</span>)</button>
  <button class="filter-btn" onclick="setFilter('flickr',this)">Flickr (<span id="cnt-flickr">0</span>)</button>
  <button class="filter-btn" onclick="setFilter('wikimedia',this)">Wikimedia (<span id="cnt-wikimedia">0</span>)</button>
  <button class="filter-btn" onclick="setFilter('unsplash',this)">Unsplash (<span id="cnt-unsplash">0</span>)</button>
  <button class="filter-btn" onclick="setFilter('inaturalist',this)">iNaturalist (<span id="cnt-inaturalist">0</span>)</button>
  <button class="filter-btn" onclick="setFilter('nasa',this)">NASA (<span id="cnt-nasa">0</span>)</button>
  <button class="filter-btn" onclick="setFilter('selected',this)">Selected (<span id="cnt-selected">0</span>)</button>
</div>
<div class="pool-info">${poolInfo}</div>

<div class="grid" id="grid"></div>

<script>
const photos = ${JSON.stringify(all)};
const selected = new Set();
let filter = "all";

function init() {
  document.getElementById("cnt-all").textContent = photos.length;
  ["flickr","wikimedia","unsplash","inaturalist","nasa"].forEach(s =>
    document.getElementById("cnt-" + s).textContent = photos.filter(p => p.source === s).length
  );
  render();
}

function visible() {
  if (filter === "all") return photos;
  if (filter === "selected") return photos.filter(p => selected.has(p.id));
  return photos.filter(p => p.source === filter);
}

function render() {
  const grid = document.getElementById("grid");
  const list = visible();
  if (!list.length) { grid.innerHTML = '<div class="empty">Nothing to show.</div>'; return; }
  grid.innerHTML = list.map(p => \`
    <div class="photo-card\${selected.has(p.id) ? " selected" : ""}" onclick="toggle('\${p.id}')">
      <img src="\${p.thumb}" alt="\${p.title}" onerror="this.closest('.photo-card').style.display='none'">
      <span class="check">✓</span>
      <span class="src-badge src-\${p.source}">\${p.sourceName}</span>
      <span class="lic-badge">\${p.license}</span>
      <div class="photo-title">\${p.title}</div>
    </div>
  \`).join("");
}

function toggle(id) {
  selected.has(id) ? selected.delete(id) : selected.add(id);
  render();
  const n = selected.size;
  document.getElementById("stats").textContent = n + " selected";
  document.getElementById("copy-btn").disabled = n === 0;
  document.getElementById("cnt-selected").textContent = n;
}

function setFilter(f, btn) {
  filter = f;
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  render();
}

function copySelected() {
  const chosen = photos.filter(p => selected.has(p.id));
  navigator.clipboard.writeText(JSON.stringify(chosen, null, 2)).then(() => {
    const btn = document.getElementById("copy-btn");
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = "Copy Selected"; btn.classList.remove("copied"); }, 2000);
  });
}

init();
</script>
</body>
</html>`;
}

// ── iNaturalist ───────────────────────────────────────────────────────────────
// Public API — no key needed. CC-licensed wildlife/nature observations.

async function fetchINaturalist() {
  console.log("🦋 iNaturalist: fetching observations...");
  const results = [];
  const seen = new Set();

  // South Bay bounding box
  const baseParams = {
    swlat: "37.19", swlng: "-122.20", nelat: "37.47", nelng: "-121.77",
    photo_licensed: "true",
    license: "cc-by,cc-by-sa,cc-by-nd,cc0,pd",
    quality_grade: "research",
    photos: "true",
    captive: "false",
    per_page: "100",
    order_by: "votes",
    order: "desc",
  };

  const iconicTaxa = ["Aves", "Plantae", "Mammalia", "Amphibia", "Reptilia", "Fungi", "Insecta"];

  for (const taxon of iconicTaxa) {
    try {
      const params = new URLSearchParams({ ...baseParams, iconic_taxa: taxon });
      const res = await fetch(`https://api.inaturalist.org/v1/observations?${params}`, {
        headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`iNat ${res.status}`);
      const data = await res.json();

      for (const obs of data.results ?? []) {
        const photo = obs.photos?.[0];
        if (!photo?.url || seen.has(photo.id)) continue;
        seen.add(photo.id);
        const thumbUrl = photo.url.replace(/\/square\./, "/medium.");
        const fullUrl = photo.url.replace(/\/square\./, "/large.");
        const license = (photo.license_code || "cc").toUpperCase().replace("CC-", "CC ");
        const commonName = obs.taxon?.preferred_common_name || obs.taxon?.name || "Wildlife";
        const location = obs.place_guess || "South Bay";
        results.push({
          source: "inaturalist",
          id: `inat-${photo.id}`,
          thumb: thumbUrl,
          full: fullUrl,
          title: `${commonName} — ${location}`,
          photographer: obs.user?.login || "iNaturalist",
          photoPage: `https://www.inaturalist.org/observations/${obs.id}`,
          license,
        });
      }
      await new Promise(r => setTimeout(r, 400));
    } catch (e) { console.warn(`  iNat ${taxon} failed: ${e.message}`); }
  }

  console.log(`  → ${results.length} observations`);
  return { photos: results, poolSize: results.length };
}

// ── NASA Image & Video Library ────────────────────────────────────────────────
// Public API — no key needed. Great for Ames Research Center + aerials.

async function fetchNASA() {
  console.log("🚀 NASA: fetching photos...");
  const results = [];
  const seen = new Set();

  const queries = [
    "Ames Research Center",
    "San Jose California",
    "Santa Clara Valley",
    "Silicon Valley aerial",
    "San Francisco Bay aerial",
    "California wildfire",
    "Moffett Field",
  ];

  for (const q of queries) {
    try {
      const params = new URLSearchParams({ q, media_type: "image", page_size: "20" });
      const res = await fetch(`https://images-api.nasa.gov/search?${params}`, {
        headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`NASA ${res.status}`);
      const data = await res.json();

      for (const item of data.collection?.items ?? []) {
        const meta = item.data?.[0];
        const link = item.links?.[0];
        if (!meta?.nasa_id || !link?.href || seen.has(meta.nasa_id)) continue;
        seen.add(meta.nasa_id);
        const thumbUrl = link.href;
        // NASA image asset URLs follow a predictable pattern
        const baseUrl = thumbUrl.replace(/~thumb\.jpg$/, "");
        const fullUrl = `${baseUrl}~orig.jpg`;
        results.push({
          source: "nasa",
          id: `nasa-${meta.nasa_id}`,
          thumb: thumbUrl,
          full: fullUrl,
          title: meta.title || "(untitled)",
          photographer: meta.photographer || meta.center || "NASA",
          photoPage: `https://images.nasa.gov/details/${meta.nasa_id}`,
          license: "Public Domain",
        });
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) { console.warn(`  NASA "${q}" failed: ${e.message}`); }
  }

  console.log(`  → ${results.length} photos`);
  return { photos: results, poolSize: results.length };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const [flickr, unsplash, wikimedia, inaturalist, nasa] = await Promise.all([
    fetchFlickr(),
    fetchUnsplash(),
    fetchWikimedia(),
    fetchINaturalist(),
    fetchNASA(),
  ]);

  const sources = [
    { name: "Flickr",       ...flickr       },
    { name: "Unsplash",     ...unsplash     },
    { name: "Wikimedia",    ...wikimedia    },
    { name: "iNaturalist",  ...inaturalist  },
    { name: "NASA",         ...nasa         },
  ];

  // Write photo-data.json for the review server
  const allPhotos = sources.flatMap(s => s.photos.map(p => ({ ...p, sourceName: s.name })));
  const dataPath = join(ROOT, "photo-data.json");
  writeFileSync(dataPath, JSON.stringify(allPhotos, null, 2));

  const total = allPhotos.length;
  console.log(`\n✅ Done — ${total} photos total`);
  sources.forEach(s => console.log(`   ${s.name}: ${s.photos.length} shown (pool: ~${s.poolSize})`));
  console.log(`\n👉 Run: node scripts/photo-review-server.mjs`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
