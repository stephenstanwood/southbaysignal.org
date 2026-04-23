// ---------------------------------------------------------------------------
// eventImages — shared 3-tier image resolver for events.
//
// Called at ingest time (generate-events.mjs) so every event gets an image
// once and keeps it across regens. No more "fix it today, leak-break
// tomorrow" churn from API-time resolution.
//
// Tier 1: Venue name → Google Places photoRef (from places.json).
//   Stored on event as `photoRef` (UI proxies via /api/place-photo).
//   Free, instant, ~40% coverage.
//
// Tier 2: Scrape og:image / twitter:image from event URL.
//   Stored on event as `image` (full URL).
//   Cached persistently in event-image-cache.json keyed by URL so we
//   never re-fetch the same page across regens.
//
// Tier 3: Recraft generation, uploaded to Vercel Blob.
//   Stored on event as `image`.
//   Behind `RESOLVE_EVENT_IMAGES_RECRAFT=1` env flag — paid API, so
//   opt-in. Cached keyed by event fingerprint (title+venue+date).
//
// Budgets / safety:
//   - OG scraping: 5 concurrent, 8s timeout, skip on any error.
//   - Recraft: skipped unless env flag set; MAX_RECRAFT per run caps spend.
//   - Cache is a committed JSON file — no network on cache hit.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const PLACES_PATH = join(REPO_ROOT, "src", "data", "south-bay", "places.json");
const CACHE_PATH = join(REPO_ROOT, "src", "data", "south-bay", "event-image-cache.json");

// ---------------------------------------------------------------------------
// Venue → photoRef lookup (Tier 1)
// ---------------------------------------------------------------------------

function normVenue(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

let _venueLookup = null;
function getVenueLookup() {
  if (_venueLookup) return _venueLookup;
  _venueLookup = new Map();
  try {
    const data = JSON.parse(readFileSync(PLACES_PATH, "utf8"));
    const places = data.places || [];
    for (const p of places) {
      if (!p?.photoRef || !p?.name) continue;
      _venueLookup.set(normVenue(p.name), p.photoRef);
    }
  } catch (err) {
    console.warn(`[eventImages] places.json load failed: ${err.message}`);
  }
  return _venueLookup;
}

export function lookupVenuePhoto(venue) {
  if (!venue) return null;
  const norm = normVenue(venue);
  if (!norm) return null;
  const lookup = getVenueLookup();
  const exact = lookup.get(norm);
  if (exact) return exact;
  // Substring — only for place names ≥9 chars to avoid spurious hits.
  for (const [placeName, photoRef] of lookup) {
    if (placeName.length < 9) continue;
    if (norm.includes(placeName) || placeName.includes(norm)) return photoRef;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persistent cache
// ---------------------------------------------------------------------------

function loadCache() {
  if (!existsSync(CACHE_PATH)) {
    return { byUrl: {}, byFingerprint: {}, generatedAt: null };
  }
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return { byUrl: {}, byFingerprint: {}, generatedAt: null };
  }
}

function saveCache(cache) {
  cache.generatedAt = new Date().toISOString();
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Tier 2: OG image scrape
// ---------------------------------------------------------------------------

const OG_TIMEOUT_MS = 8000;
const OG_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15";

function extractOgImage(html, pageUrl) {
  if (!html) return null;
  // Prefer og:image, then twitter:image, then <link rel="image_src">.
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      try {
        // Absolutize relative URLs.
        return new URL(m[1], pageUrl).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function fetchOgImage(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OG_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": OG_UA,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    return extractOgImage(html, url);
  } catch {
    return null;
  }
}

// OG image quality gate. Reject tiny files, wrong content types, and obvious
// logo/icon/placeholder filename patterns so a CMS-default OG image doesn't
// lock out Tier 3 Recraft later. Called right after extractOgImage.
const BAD_OG_URL = /(?:^|[/_\-.])(?:logo|icon|favicon|default(?:[-_]image)?|placeholder|empty|blank|spacer|sprite|og[-_]default|share[-_]image|social[-_]share)(?:[-_.]|\.|$)/i;
const OG_MIN_BYTES = 4000;       // < 4KB → almost certainly a logo
const OG_MAX_BYTES = 10_000_000; // > 10MB → not a sane OG image
const OG_VALIDATE_TIMEOUT_MS = 5000;

async function validateOgImage(imageUrl) {
  if (!imageUrl) return { ok: false, reason: "empty url" };
  if (BAD_OG_URL.test(imageUrl)) return { ok: false, reason: "filename pattern" };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OG_VALIDATE_TIMEOUT_MS);
    // Many CDNs reject HEAD; use GET with Range to cap the download at 1 byte
    // when possible. Falls back to normal GET if Range is ignored.
    const res = await fetch(imageUrl, {
      signal: ctrl.signal,
      headers: { "User-Agent": OG_UA, Range: "bytes=0-0" },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok && res.status !== 206) {
      // Some hosts 403 Range but serve GET fine. Don't reject on first fail.
      return { ok: true, warn: `range ${res.status}` };
    }

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct && !ct.startsWith("image/")) return { ok: false, reason: `non-image content-type: ${ct}` };

    // Content-Range: "bytes 0-0/12345" → total length after the slash.
    // Falls back to Content-Length when the server ignored Range.
    let totalBytes = 0;
    const cr = res.headers.get("content-range");
    if (cr) {
      const m = cr.match(/\/(\d+)\s*$/);
      if (m) totalBytes = parseInt(m[1], 10);
    }
    if (!totalBytes) totalBytes = parseInt(res.headers.get("content-length") || "0", 10);

    if (totalBytes && totalBytes < OG_MIN_BYTES) return { ok: false, reason: `too small: ${totalBytes}B` };
    if (totalBytes && totalBytes > OG_MAX_BYTES) return { ok: false, reason: `too large: ${totalBytes}B` };

    return { ok: true };
  } catch (err) {
    // Network errors shouldn't cause us to reject — keep the image and move on.
    return { ok: true, warn: err.message };
  }
}

// Simple concurrency limiter.
async function mapConcurrent(items, fn, concurrency = 5) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Tier 3: Recraft
// ---------------------------------------------------------------------------

function fingerprint(event) {
  const parts = [
    (event.title || "").toLowerCase().trim(),
    (event.venue || "").toLowerCase().trim(),
    (event.city || "").toLowerCase().trim(),
  ];
  return parts.join("|").replace(/[^a-z0-9|]+/g, "-").slice(0, 120);
}

function recraftPrompt(event) {
  const title = event.title || "event";
  const venue = event.venue || event.city || "South Bay";
  const catHints = {
    food: "cozy restaurant scene, warm light, editorial food photography style",
    arts: "gallery wall with abstract artwork, soft modern lighting",
    music: "live music stage, colorful lights, editorial photography",
    entertainment: "concert hall or theater interior, warm ambient light",
    outdoor: "California hills and trees, golden hour, editorial landscape photography",
    community: "welcoming community space, diverse group, editorial photography",
    family: "bright playful indoor community space with soft modern graphics",
    sports: "clean stadium or court shot, editorial sports photography",
    education: "modern classroom or workshop setting, warm light",
    wellness: "calm minimalist wellness studio, soft natural light",
    shopping: "artisan market stalls, bright produce or crafts, editorial photography",
    museum: "museum gallery interior, spotlights on exhibits",
  };
  const hint = catHints[String(event.category || "").toLowerCase()]
    || "tasteful editorial photograph of a local event, muted palette";
  return `Editorial photograph illustrating "${title}" at ${venue}. ${hint}. No text. No logos. Natural composition, rich subtle colors, California light. Horizontal 3:2 aspect ratio.`;
}

async function generateRecraft(event) {
  const { generateRecraftImage, uploadToBlob } = await import(
    /* vite-ignore */ "../../../scripts/social/lib/recraft.mjs"
  );
  const prompt = recraftPrompt(event);
  const { buffer } = await generateRecraftImage({ prompt, size: "3:2" });
  const slug = fingerprint(event).replace(/\|/g, "-");
  const url = await uploadToBlob(buffer, `event-images/${slug}-${Date.now()}.png`);
  return url;
}

// ---------------------------------------------------------------------------
// Public API: resolveEventImages
// ---------------------------------------------------------------------------

/**
 * Resolve images for a batch of events in place.
 * Each event gets one of:
 *   - `photoRef` (Tier 1 — Places photo path)
 *   - `image`    (Tier 2 OG scrape, or Tier 3 Recraft — full URL)
 *
 * Options:
 *   - enableRecraft: boolean (default: process.env.RESOLVE_EVENT_IMAGES_RECRAFT === "1")
 *   - maxRecraft:    cap per run (default 30) to bound spend.
 *   - concurrency:   OG scrape concurrency (default 6)
 *   - dryRun:        don't mutate events or write cache; return stats + candidates only.
 */
export async function resolveEventImages(events, opts = {}) {
  const enableRecraft = opts.enableRecraft ?? (process.env.RESOLVE_EVENT_IMAGES_RECRAFT === "1");
  const maxRecraft = opts.maxRecraft ?? 30;
  const concurrency = opts.concurrency ?? 6;
  const dryRun = !!opts.dryRun;

  const cache = loadCache();
  const stats = {
    total: events.length,
    tier1: 0, // venue lookup hits
    tier2_cached: 0, // OG cache hits
    tier2_fetched: 0, // OG new fetches (success)
    tier2_missed: 0, // OG tried but no image found
    tier2_rejected: 0, // OG fetched but failed quality gate
    tier3_cached: 0,
    tier3_generated: 0,
    tier3_skipped: 0, // would've recraft-gen'd but over budget / disabled
    preexisting: 0, // event already had photoRef or image
  };

  // --- Tier 1: venue → photoRef (synchronous) ------------------------------
  const needOG = []; // events that don't have a photoRef/image after Tier 1
  for (const e of events) {
    if (e.photoRef || e.image) {
      stats.preexisting++;
      continue;
    }
    const ref = lookupVenuePhoto(e.venue);
    if (ref) {
      if (!dryRun) e.photoRef = ref;
      stats.tier1++;
      continue;
    }
    needOG.push(e);
  }

  // --- Tier 2: OG scrape with persistent cache -----------------------------
  const needRecraft = [];
  await mapConcurrent(needOG, async (e) => {
    const url = e.url;
    if (!url) { needRecraft.push(e); return; }
    // Cache hit?
    if (cache.byUrl[url]) {
      const hit = cache.byUrl[url];
      if (hit.image) {
        if (!dryRun) e.image = hit.image;
        stats.tier2_cached++;
        return;
      }
      // Negative cache — previously tried + failed. Try Recraft.
      needRecraft.push(e);
      return;
    }
    // New fetch.
    const img = await fetchOgImage(url);
    if (!img) {
      cache.byUrl[url] = { image: null, fetchedAt: new Date().toISOString() };
      stats.tier2_missed++;
      needRecraft.push(e);
      return;
    }
    // Quality gate: reject tiny/logo/placeholder OG images so a CMS-default
    // doesn't block a proper Recraft generation. Rejection is cached too
    // so we don't re-validate every run.
    const v = await validateOgImage(img);
    if (!v.ok) {
      cache.byUrl[url] = {
        image: null,
        rejected: img,
        rejectReason: v.reason,
        fetchedAt: new Date().toISOString(),
      };
      stats.tier2_rejected++;
      needRecraft.push(e);
      return;
    }
    cache.byUrl[url] = { image: img, fetchedAt: new Date().toISOString() };
    if (!dryRun) e.image = img;
    stats.tier2_fetched++;
  }, concurrency);

  // --- Tier 3: Recraft (opt-in, budgeted) ----------------------------------
  let recraftUsed = 0;
  for (const e of needRecraft) {
    const fp = fingerprint(e);
    const cached = cache.byFingerprint[fp];
    if (cached?.image) {
      if (!dryRun) e.image = cached.image;
      stats.tier3_cached++;
      continue;
    }
    if (!enableRecraft || recraftUsed >= maxRecraft) {
      stats.tier3_skipped++;
      continue;
    }
    if (dryRun) {
      stats.tier3_skipped++;
      continue;
    }
    try {
      const url = await generateRecraft(e);
      cache.byFingerprint[fp] = { image: url, tier: "recraft", generatedAt: new Date().toISOString() };
      e.image = url;
      stats.tier3_generated++;
      recraftUsed++;
    } catch (err) {
      console.warn(`[eventImages] recraft failed for "${e.title}": ${err.message}`);
      stats.tier3_skipped++;
    }
  }

  if (!dryRun) saveCache(cache);
  return stats;
}

/**
 * One-off: re-validate every positive entry in byUrl and drop the ones that
 * fail the current quality gate. Use after tightening the validator so the
 * next generate-events run refetches (and likely falls through to Recraft)
 * for the junk entries.
 */
export async function revalidateOgCache({ concurrency = 6, dryRun = false } = {}) {
  const cache = loadCache();
  const entries = Object.entries(cache.byUrl || {}).filter(([, v]) => v?.image);
  const stats = { total: entries.length, kept: 0, rejected: 0, errors: 0 };

  await mapConcurrent(entries, async ([pageUrl, entry]) => {
    try {
      const v = await validateOgImage(entry.image);
      if (v.ok) {
        stats.kept++;
        return;
      }
      if (!dryRun) {
        cache.byUrl[pageUrl] = {
          image: null,
          rejected: entry.image,
          rejectReason: v.reason,
          fetchedAt: new Date().toISOString(),
        };
      }
      stats.rejected++;
    } catch {
      stats.errors++;
    }
  }, concurrency);

  if (!dryRun) saveCache(cache);
  return stats;
}
