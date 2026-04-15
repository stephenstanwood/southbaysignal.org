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

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { head } from "@vercel/blob";

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

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error("BLOB_READ_WRITE_TOKEN not set — skipping inbound events pull");
  process.exit(0);
}

let raw = null;
try {
  const meta = await head(BLOB_KEY, { token });
  if (meta?.url) {
    const res = await fetch(`${meta.url}?_cb=${Date.now()}`, { cache: "no-store" });
    if (res.ok) raw = await res.text();
  }
} catch (err) {
  if (err.name === "BlobNotFoundError") {
    console.log("ℹ️  No inbound events blob yet — writing empty file");
    writeFileSync(OUT_PATH, JSON.stringify({ events: [], _meta: { pulledAt: new Date().toISOString() } }, null, 2));
    process.exit(0);
  }
  console.error("❌ Failed to read blob:", err.message);
  process.exit(1);
}

let events = [];
try {
  events = raw ? JSON.parse(raw) : [];
} catch (err) {
  console.error("❌ Failed to parse blob JSON:", err.message);
  process.exit(1);
}

// Only keep events that are still in the future and approved (or new — we trust the extractor)
const today = new Date().toISOString().slice(0, 10);
const fresh = events.filter((e) => {
  if (e.status === "rejected") return false;
  const date = (e.startsAt || "").slice(0, 10);
  return date >= today;
});

const out = {
  _meta: {
    pulledAt: new Date().toISOString(),
    totalInBlob: events.length,
    freshCount: fresh.length,
  },
  events: fresh,
};

writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(`✅ inbound-events.json: ${fresh.length} events (${events.length} total in blob)`);
