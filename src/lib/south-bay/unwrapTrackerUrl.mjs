// ---------------------------------------------------------------------------
// unwrapTrackerUrl — resolve email-newsletter tracker URLs to their final
// destination, then strip tracking params (utm_*, mc_*, fbclid, etc.).
//
// Why: city newsletters arrive with link-wrapping like cc.rs6.net (Constant
// Contact), list-manage.com/track/click (Mailchimp), connect.cdm.org/site/R
// (Convio), email.live.stanford.edu/c (dotdigital), wordfly, cmail19. Those
// URLs are tied to a single email blast — they expire, look ugly when shared,
// and offer no preview when previewed in iMessage / Slack. Resolving once at
// ingest gives us durable canonical URLs (eventbrite, ticketmaster, the
// venue's own page).
//
// Cached persistently (url-unwrap-cache.json) so we never re-fetch the same
// tracker. Failures cache the original URL so a broken redirect doesn't
// retry on every regen.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CACHE_PATH = join(REPO_ROOT, "src", "data", "south-bay", "url-unwrap-cache.json");

const USER_AGENT = "Mozilla/5.0 (compatible; SouthBayTodayBot/1.0; +https://southbaytoday.org)";
const FETCH_TIMEOUT_MS = 12_000;
const CONCURRENCY = 3;
const POLITE_DELAY_MS = 200;

// Hosts/path patterns that wrap a real destination URL inside a redirect.
// Conservative — only match patterns we KNOW are tracker wrappers, not
// every URL with a query string.
const TRACKER_PATTERNS = [
  /\bcc\.rs6\.net\/tn\.jsp/i,                  // Constant Contact
  /\.list-manage\.com\/track\/click/i,          // Mailchimp
  /\bconnect\.cdm\.org\/site\/R\b/i,            // Convio / Blackbaud
  /\bemail\.live\.stanford\.edu\/c\//i,         // Stanford dotdigital
  /\bclick\.fanmail\./i,                        // SJ Earthquakes / Marketo
  /\bcmail\d+\.com\/t\//i,                      // Campaign Monitor
  /\be\.wordfly\.com\/click\?/i,                // WordFly
  /\bemail-link\.parentsquare\.com\b/i,         // ParentSquare
  /\bct\.sendgrid\.net\b/i,                     // SendGrid click tracking
  /\bclick\.icptrack\.com\b/i,                  // iContact
  /\btrk\.klclick\d*\.com\b/i,                  // Klaviyo
  /\bclicks\.aweber\.com\b/i,                   // AWeber
  /\bbit\.ly\b/i,                               // Bit.ly shorteners
  /\btinyurl\.com\b/i,                          // TinyURL
];

// Tracking params to strip from the FINAL resolved URL (still useful to
// keep affiliate tags like `aff=` for Eventbrite — those carry attribution
// the venue cares about and don't degrade UX).
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "mc_cid", "mc_eid",
  "dm_i", "dm_t",
  "_hsenc", "_hsmi",
  "fbclid", "gclid", "msclkid", "yclid",
  "_ga", "_gl",
  "ref_src", "ref_url",
  "vero_id", "vero_conv",
  "ck_subscriber_id",
  "trk", "trkCampaign",
]);

export function isTrackerUrl(url) {
  if (!url || typeof url !== "string") return false;
  return TRACKER_PATTERNS.some((re) => re.test(url));
}

export function stripTrackingParams(url) {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        u.searchParams.delete(key);
        changed = true;
      }
    }
    if (!changed) return url;
    // If query is now empty, drop the trailing ?
    const result = u.toString();
    return result.endsWith("?") ? result.slice(0, -1) : result;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Persistent cache
// ---------------------------------------------------------------------------

function loadCache() {
  if (!existsSync(CACHE_PATH)) return { byUrl: {}, generatedAt: null };
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (!raw.byUrl) raw.byUrl = {};
    return raw;
  } catch {
    return { byUrl: {}, generatedAt: null };
  }
}

function saveCache(cache) {
  cache.generatedAt = new Date().toISOString();
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

async function resolveOne(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Use GET (HEAD is rejected by many tracker endpoints with 405).
    // redirect: "follow" is the default — fetch chases up to 20 hops and
    // exposes the final URL via response.url.
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    // Even 4xx/5xx final pages still expose the resolved URL — tracker
    // worked, the destination just blocks bots. Keep the resolved URL.
    if (res.url && res.url !== url) {
      return stripTrackingParams(res.url);
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve a list of URLs with bounded concurrency and a small politeness
// delay. Returns a Map(originalUrl → resolvedUrl). Uses the persistent
// cache; new resolutions are written back to the cache at the end.
export async function unwrapMany(urls, { verbose = false } = {}) {
  const cache = loadCache();
  const result = new Map();
  const todo = [];
  for (const u of urls) {
    if (!u) continue;
    if (result.has(u)) continue;
    if (!isTrackerUrl(u)) {
      // Not a tracker — return as-is (still useful for the caller).
      result.set(u, u);
      continue;
    }
    if (cache.byUrl[u]) {
      result.set(u, cache.byUrl[u]);
      continue;
    }
    todo.push(u);
  }

  if (verbose) {
    console.log(`  🔗 unwrap: ${urls.length} input, ${todo.length} new (cache hit ${urls.length - todo.length})`);
  }

  let resolved = 0;
  let failed = 0;
  const queue = todo.slice();
  async function worker() {
    while (queue.length) {
      const u = queue.shift();
      const finalUrl = await resolveOne(u);
      if (finalUrl) {
        cache.byUrl[u] = finalUrl;
        result.set(u, finalUrl);
        resolved++;
      } else {
        // Cache the failure as identity so we don't keep re-fetching.
        cache.byUrl[u] = u;
        result.set(u, u);
        failed++;
      }
      await sleep(POLITE_DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length || 1) }, worker));

  if (todo.length) saveCache(cache);

  if (verbose) {
    console.log(`  🔗 unwrap done: ${resolved} resolved, ${failed} kept original`);
  }
  return result;
}

// Convenience: resolve a single URL synchronously against the cache, or
// async-resolve and persist if missing. Used when only one event needs it.
export async function unwrapOne(url) {
  const m = await unwrapMany([url]);
  return m.get(url) ?? url;
}
