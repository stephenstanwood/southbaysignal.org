// ---------------------------------------------------------------------------
// eventImages — shared 4-tier image resolver for events.
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
// Tier 3: Unsplash search by category.
//   Stored on event as `image` (full URL).
//   Free up to ~50 calls/hour with UNSPLASH_ACCESS_KEY. We cache one URL
//   per category so the whole run costs <20 calls. The pipeline is meant
//   to be Places → Unsplash → Recraft per the product rule, so Unsplash
//   sits ahead of paid Recraft as the safety net.
//
// Tier 4: Recraft generation, uploaded to Vercel Blob.
//   Stored on event as `image`.
//   Behind `RESOLVE_EVENT_IMAGES_RECRAFT=1` env flag — paid API, so
//   opt-in. Cached keyed by event fingerprint (title+venue+date).
//
// Pre-pass: every existing `e.image` is sanity-validated. URLs with raw
// HTML entities (`&amp;`, etc.) get decoded; URLs that fail the OG quality
// gate get dropped so the event re-enters the resolution chain.
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

// Decode HTML entities that survive in `content="..."` meta attributes.
// Without this, Eventbrite-style URLs come through with `&amp;` literally
// embedded in the query string, which Eventbrite's _next/image proxy then
// 500s on — every BioBlitz / CPR / fire-prep event ends up imageless.
function decodeHtmlEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&"); // must be last so we don't double-decode
}

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
        // Decode HTML entities first, then absolutize relative URLs.
        const decoded = decodeHtmlEntities(m[1]);
        return new URL(decoded, pageUrl).toString();
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
// Boundary chars include `/` so platform paths like ".../platform/logo/..."
// (Localist's wordmark CDN) match too — slipped through earlier and crammed
// the SJSU 224x42 banner into every SJSU event tile.
const BAD_OG_URL = /(?:^|[/_\-.])(?:logo|icon|favicon|default(?:[-_]image)?|placeholder|empty|blank|spacer|sprite|og[-_]default|share[-_]image|social[-_]share)(?:[/_\-.]|$)/i;
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
// Tier 3: Unsplash (category stock photo, free tier)
// ---------------------------------------------------------------------------

// Same shape as the search-query map in /api/unsplash-photo.ts. Keeping a
// local copy means ingest doesn't need a running dev server to resolve
// images — it goes straight to api.unsplash.com.
const UNSPLASH_CATEGORY_QUERIES = {
  food: "restaurant meal california",
  outdoor: "park nature outdoor california",
  museum: "museum art gallery interior",
  entertainment: "entertainment fun activity",
  wellness: "spa wellness relaxing",
  shopping: "boutique shopping retail",
  arts: "art gallery studio creative",
  events: "festival outdoor event crowd",
  sports: "sports stadium game",
  neighborhood: "california downtown street cafe",
  market: "farmers market fresh produce outdoor",
  community: "community event gathering outdoor",
  family: "family activity outdoor park",
  music: "live music concert performance",
  education: "campus university lecture hall",
  volunteer: "volunteer community service outdoor",
  health: "wellness healthcare community",
};

const UNSPLASH_UTM = "utm_source=south_bay_today&utm_medium=referral";

async function fetchUnsplashByCategory(category) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return null;
  const query = UNSPLASH_CATEGORY_QUERIES[String(category || "").toLowerCase()]
    || `${category || "california"} california`;
  try {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=10&orientation=squarish`,
      {
        headers: { Authorization: `Client-ID ${key}`, "User-Agent": OG_UA },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const results = data.results ?? [];
    if (!results.length) return null;
    // Take a deterministic-ish first-of-top-5 to keep cache hits stable
    // across runs while still varying category-to-category.
    const photo = results[0];
    if (!photo) return null;
    // Required by Unsplash terms — fire-and-forget the download endpoint.
    if (photo.links?.download_location) {
      fetch(photo.links.download_location, {
        headers: { Authorization: `Client-ID ${key}` },
      }).catch(() => {});
    }
    return {
      image: photo.urls?.small || photo.urls?.regular || null,
      photographer: photo.user?.name || null,
      photographerUrl: photo.user?.links?.html ? `${photo.user.links.html}?${UNSPLASH_UTM}` : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier 4: Recraft
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
  if (!cache.byCategory) cache.byCategory = {};
  const stats = {
    total: events.length,
    prevalidated_decoded: 0, // pre-existing image had &amp; / entities, decoded
    prevalidated_dropped: 0, // pre-existing image failed validation, re-resolving
    tier1: 0, // venue lookup hits
    tier2_cached: 0, // OG cache hits
    tier2_fetched: 0, // OG new fetches (success)
    tier2_missed: 0, // OG tried but no image found
    tier2_rejected: 0, // OG fetched but failed quality gate
    tier3_unsplash_cached: 0, // Unsplash cache hits (per category)
    tier3_unsplash_fetched: 0, // Unsplash new fetches
    tier3_unsplash_skipped: 0, // no key / failed
    tier4_recraft_cached: 0,
    tier4_recraft_generated: 0,
    tier4_recraft_skipped: 0, // would've recraft-gen'd but over budget / disabled
    preexisting: 0, // event already had a healthy photoRef or image
    final_missing: 0, // event still has nothing after all tiers (alarm signal)
  };

  // --- Pre-pass: sanity-check existing `e.image` URLs ----------------------
  // Source feeds (and historical OG cache hits) sometimes carry HTML-entity-
  // encoded URLs (&amp; instead of &) that 5xx when the browser tries to
  // load them. Decode silently; if the URL still looks broken, drop it so
  // the resolver can retry through later tiers.
  for (const e of events) {
    if (!e.image || typeof e.image !== "string") continue;
    if (/&(amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/i.test(e.image)) {
      const decoded = decodeHtmlEntities(e.image);
      if (decoded !== e.image) {
        if (!dryRun) e.image = decoded;
        stats.prevalidated_decoded++;
      }
    }
    // Cheap sanity check — must be a valid http(s) URL. Anything weirder
    // (data:, javascript:, malformed) is dropped so we resolve fresh.
    try {
      const u = new URL(e.image);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        if (!dryRun) e.image = null;
        stats.prevalidated_dropped++;
      }
    } catch {
      if (!dryRun) e.image = null;
      stats.prevalidated_dropped++;
    }
  }

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
  const needUnsplash = []; // events that didn't get an OG image
  await mapConcurrent(needOG, async (e) => {
    const url = e.url;
    if (!url) { needUnsplash.push(e); return; }
    // Cache hit?
    if (cache.byUrl[url]) {
      const hit = cache.byUrl[url];
      if (hit.image) {
        if (!dryRun) e.image = hit.image;
        stats.tier2_cached++;
        return;
      }
      // Negative cache — previously tried + failed. Try Unsplash next.
      needUnsplash.push(e);
      return;
    }
    // New fetch.
    const img = await fetchOgImage(url);
    if (!img) {
      cache.byUrl[url] = { image: null, fetchedAt: new Date().toISOString() };
      stats.tier2_missed++;
      needUnsplash.push(e);
      return;
    }
    // Quality gate: reject tiny/logo/placeholder OG images so a CMS-default
    // doesn't block a proper Unsplash/Recraft fallback. Rejection is cached
    // too so we don't re-validate every run.
    const v = await validateOgImage(img);
    if (!v.ok) {
      cache.byUrl[url] = {
        image: null,
        rejected: img,
        rejectReason: v.reason,
        fetchedAt: new Date().toISOString(),
      };
      stats.tier2_rejected++;
      needUnsplash.push(e);
      return;
    }
    cache.byUrl[url] = { image: img, fetchedAt: new Date().toISOString() };
    if (!dryRun) e.image = img;
    stats.tier2_fetched++;
  }, concurrency);

  // --- Tier 3: Unsplash by category (free, 50/hr) --------------------------
  // Cached per category so the whole run uses ≤ N calls regardless of how
  // many events fall through. If UNSPLASH_ACCESS_KEY is missing, every
  // event slides straight to Tier 4 (Recraft) — log once so we notice.
  const needRecraft = [];
  let warnedNoUnsplashKey = false;
  for (const e of needUnsplash) {
    const cat = String(e.category || "community").toLowerCase();
    let cached = cache.byCategory[cat];
    if (!cached || !cached.image) {
      if (!process.env.UNSPLASH_ACCESS_KEY) {
        if (!warnedNoUnsplashKey) {
          console.warn("[eventImages] UNSPLASH_ACCESS_KEY not set — Tier 3 disabled, falling through to Recraft");
          warnedNoUnsplashKey = true;
        }
        stats.tier3_unsplash_skipped++;
        needRecraft.push(e);
        continue;
      }
      const fetched = await fetchUnsplashByCategory(cat);
      if (!fetched?.image) {
        stats.tier3_unsplash_skipped++;
        needRecraft.push(e);
        continue;
      }
      cache.byCategory[cat] = {
        image: fetched.image,
        photographer: fetched.photographer,
        photographerUrl: fetched.photographerUrl,
        fetchedAt: new Date().toISOString(),
      };
      cached = cache.byCategory[cat];
      stats.tier3_unsplash_fetched++;
    } else {
      stats.tier3_unsplash_cached++;
    }
    if (!dryRun) e.image = cached.image;
  }

  // --- Tier 4: Recraft (opt-in, budgeted) ----------------------------------
  let recraftUsed = 0;
  for (const e of needRecraft) {
    const fp = fingerprint(e);
    const cached = cache.byFingerprint[fp];
    if (cached?.image) {
      if (!dryRun) e.image = cached.image;
      stats.tier4_recraft_cached++;
      continue;
    }
    if (!enableRecraft || recraftUsed >= maxRecraft) {
      stats.tier4_recraft_skipped++;
      continue;
    }
    if (dryRun) {
      stats.tier4_recraft_skipped++;
      continue;
    }
    try {
      const url = await generateRecraft(e);
      cache.byFingerprint[fp] = { image: url, tier: "recraft", generatedAt: new Date().toISOString() };
      e.image = url;
      stats.tier4_recraft_generated++;
      recraftUsed++;
    } catch (err) {
      console.warn(`[eventImages] recraft failed for "${e.title}": ${err.message}`);
      stats.tier4_recraft_skipped++;
    }
  }

  // --- Final safety check — flag any event still without an image ---------
  for (const e of events) {
    if (!e.photoRef && !e.image) stats.final_missing++;
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
