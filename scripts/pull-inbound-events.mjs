/**
 * Pull inbound events from Vercel Blob → local JSON file.
 *
 * Runs on the Mac Mini as part of the nightly data sync. The intake webhook
 * (deployed on Vercel) writes to Blob when city newsletter emails arrive;
 * this script pulls that into src/data/south-bay/inbound-events.json so
 * generate-events.mjs can merge them into the main event pipeline.
 *
 * Usage: node scripts/pull-inbound-events.mjs
 *
 * Env: BLOB_READ_WRITE_TOKEN (from .env.local)
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { head, list } from "@vercel/blob";
import { writeFileAtomic } from "./lib/io.mjs";
import { todayPT } from "./lib/dates.mjs";
import {
  ACRONYM_FIXES,
  VIRTUAL_TITLE_SIGNALS,
  VIRTUAL_ADDRESS_SIGNALS,
} from "./social/lib/content-rules.mjs";
import { unwrapMany, isTrackerUrl } from "../src/lib/south-bay/unwrapTrackerUrl.mjs";
import { inboundReadProblems } from "./lib/inbound-shard-health.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.local
const envPath = join(__dirname, "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) {
      // Strip surrounding quotes (see feedback_env_quote_stripping memory)
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const OUT_PATH = join(__dirname, "..", "src", "data", "south-bay", "inbound-events.json");
const BLOB_KEY = "lookout/inbound-events.json";
const SHARD_PREFIX = "lookout/events-shards/";

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error("BLOB_READ_WRITE_TOKEN not set — refusing to preserve a stale inbound snapshot");
  process.exit(1);
}

const events = [];
// Classified so the strict guard can tell a couple of unreachable shards apart
// from the inbound source going dark. See lib/inbound-shard-health.mjs.
const shardErrors = [];
let listError = null;
let legacyError = null;

// 1. Legacy monolithic blob (pre-sharding) — keep reading until it's gone.
try {
  const meta = await head(BLOB_KEY, { token });
  if (meta?.url) {
    const res = await fetch(`${meta.url}?_cb=${Date.now()}`, { cache: "no-store" });
    if (res.ok) {
      const parsed = JSON.parse(await res.text());
      if (Array.isArray(parsed)) events.push(...parsed);
    }
  }
} catch (err) {
  if (err.name !== "BlobNotFoundError") {
    console.error("⚠️  legacy blob read failed:", err.message);
    legacyError = err.message;
  }
}

// 2. Per-email shards (race-free writes).
//
// The shard count grows without bound (860+ as of 2026-08), and a bare
// Promise.all over all of them opened that many sockets at once. Read with
// bounded concurrency and retry transient failures before recording an error;
// whatever still fails is then weighed by lib/inbound-shard-health.mjs, which
// degrades on a subset and blocks only on a systemic outage. Both halves were
// needed: retries alone still let one unreachable shard out of 860 abort the
// 2026-08-23/24 runs after the 40-minute scrape had already succeeded.
const SHARD_CONCURRENCY = 24;
const SHARD_ATTEMPTS = 3;

async function fetchShard(b) {
  let lastErr = null;
  for (let attempt = 1; attempt <= SHARD_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${b.url}?_cb=${Date.now()}`, { cache: "no-store" });
      if (res.ok) return JSON.parse(await res.text());
      // 4xx is a real, non-transient problem; retrying only wastes time.
      if (res.status < 500 && res.status !== 429) {
        shardErrors.push(`${b.pathname}: HTTP ${res.status}`);
        return null;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err.message;
    }
    if (attempt < SHARD_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    }
  }
  shardErrors.push(`${b.pathname}: ${lastErr} (after ${SHARD_ATTEMPTS} attempts)`);
  return null;
}

let shardTotal = 0;
try {
  // list() caps at 1000 per page and reports the rest through hasMore/cursor.
  // A single unpaginated call would therefore start silently dropping shards
  // the moment the count crosses 1000 — 866 as of 2026-08 — and a silent
  // undercount is the one failure this stage cannot detect: every shard it did
  // read succeeds, so the run looks perfectly clean. Page until the listing is
  // exhausted, and treat a non-advancing cursor as a listing failure rather
  // than looping forever.
  const blobs = [];
  let pageCursor;
  for (;;) {
    const page = await list({ prefix: SHARD_PREFIX, token, cursor: pageCursor, limit: 1000 });
    blobs.push(...page.blobs);
    if (!page.hasMore) break;
    if (!page.cursor || page.cursor === pageCursor) {
      throw new Error("shard listing reported more pages but did not advance the cursor");
    }
    pageCursor = page.cursor;
  }
  shardTotal = blobs.length;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(SHARD_CONCURRENCY, blobs.length) },
    async () => {
      while (cursor < blobs.length) {
        const arr = await fetchShard(blobs[cursor++]);
        if (Array.isArray(arr)) events.push(...arr);
      }
    }
  );
  await Promise.all(workers);
} catch (err) {
  console.error("⚠️  shard list failed:", err.message);
  listError = err.message;
}

// Dedup by id (legacy + shards overlap is possible).
const seen = new Set();
const unique = events.filter((e) => {
  if (!e || typeof e.id !== "string") return false;
  if (seen.has(e.id)) return false;
  seen.add(e.id);
  return true;
});
events.length = 0;
events.push(...unique);

// Only keep events that are still in the future and approved (or new — we trust the extractor)
const today = todayPT();
const fresh = events.filter((e) => {
  if (e.status === "rejected") return false;
  const date = (e.startsAt || "").slice(0, 10);
  return date >= today;
});

// Systematic normalization so the inbound file matches the upcoming-events
// hygiene guarantees. Title-case acronyms + auto-flag virtual events — the
// same passes generate-events runs at its tail, applied here too so audits
// against inbound-events.json never surface issues the upstream already fixes.
for (const e of fresh) {
  for (const field of ["title", "description"]) {
    if (!e[field]) continue;
    for (const [up, re] of ACRONYM_FIXES) e[field] = e[field].replace(re, up);
  }
  if (e.virtual !== true) {
    const title = e.title || "";
    const loc = e.location || "";
    if (VIRTUAL_TITLE_SIGNALS.some(r => r.test(title)) || VIRTUAL_ADDRESS_SIGNALS.some(r => r.test(loc))) {
      e.virtual = true;
    }
  }
}

// Resolve tracker-wrapped sourceUrls to their final destinations so links
// don't rot when the email campaign expires. Cached in url-unwrap-cache.json.
const trackerUrls = fresh
  .map((e) => e.sourceUrl)
  .filter((u) => u && isTrackerUrl(u));
if (trackerUrls.length) {
  const resolved = await unwrapMany(trackerUrls, { verbose: true });
  for (const e of fresh) {
    if (e.sourceUrl && resolved.has(e.sourceUrl)) {
      const final = resolved.get(e.sourceUrl);
      if (final && final !== e.sourceUrl) {
        e.sourceUrlOriginal = e.sourceUrl;
        e.sourceUrl = final;
      }
    }
  }
  // A tracker that failed to resolve is cached as identity by unwrapMany, so
  // without this the raw wrapper survives all the way to the public page.
  // That is worse than having no link: these tokens expire with the email
  // blast, and several encode the recipient (Mailchimp's `e=`, PatronPoint's
  // `contactHash`, ls.49ers.com's per-send path). Drop the link instead —
  // missing beats leaking, and detrack() downstream applies the same rule.
  let unresolvedTrackers = 0;
  for (const e of fresh) {
    if (e.sourceUrl && isTrackerUrl(e.sourceUrl)) {
      e.sourceUrlOriginal ??= e.sourceUrl;
      e.sourceUrl = null;
      unresolvedTrackers++;
    }
  }
  if (unresolvedTrackers) {
    console.log(`  🔗 dropped ${unresolvedTrackers} unresolved tracker URL(s) rather than publish them`);
  }
}

const out = {
  _meta: {
    pulledAt: new Date().toISOString(),
    totalInBlob: events.length,
    freshCount: fresh.length,
    shardTotal,
    shardFailures: shardErrors.length,
  },
  events: fresh,
};

// Warn in every mode — a degraded pull that still passes the guards should be
// visible in the nightly log, not silently indistinguishable from a clean one.
const readHealth = inboundReadProblems({ listError, shardTotal, shardErrors, legacyError });
for (const warning of readHealth.warnings) console.warn(`⚠️  ${warning}`);

if (process.env.SBT_STRICT_EVENT_REFRESH === "1") {
  let previous = null;
  try { previous = JSON.parse(readFileSync(OUT_PATH, "utf8")); } catch { /* first run */ }
  const previousTotal = Number(previous?._meta?.totalInBlob || 0);
  if (readHealth.blocking.length > 0) {
    throw new Error(`inbound source read failed: ${readHealth.blocking.join("; ")}`);
  }
  if (events.length === 0) {
    throw new Error("inbound source returned zero events");
  }
  if (previousTotal >= 20 && events.length < previousTotal * 0.5) {
    throw new Error(`inbound coverage regression: ${previousTotal}→${events.length} source events`);
  }
}

writeFileAtomic(OUT_PATH, JSON.stringify(out, null, 2));
const degraded = shardErrors.length ? ` — degraded: ${shardErrors.length}/${shardTotal} shards unreadable` : "";
console.log(`✅ inbound-events.json: ${fresh.length} events (${events.length} total in blob)${degraded}`);
