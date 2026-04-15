/**
 * One-shot: add (or upsert) a row in the prod tracker blob.
 *
 * Usage:
 *   node scripts/lookout/add-tracker-row.mjs <id>
 *
 * Reads the entry from scripts/lookout/targets.json and writes a tracker
 * row with status `signup-posted` (i.e. signed up, awaiting first email).
 * Idempotent — if a row with the id already exists, it just flips status.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { head, put } from "@vercel/blob";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local manually (no dotenv dep)
try {
  const env = readFileSync(join(__dirname, "../../.env.local"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {}

const BLOB_KEY = "lookout/newsletter-tracker.json";
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error("BLOB_READ_WRITE_TOKEN not set");
  process.exit(1);
}

const id = process.argv[2];
if (!id) {
  console.error("usage: node scripts/lookout/add-tracker-row.mjs <id>");
  process.exit(1);
}

const targetsPath = join(__dirname, "targets.json");
const { targets } = JSON.parse(readFileSync(targetsPath, "utf8"));
const target = targets.find((t) => t.id === id);
if (!target) {
  console.error(`target not found in targets.json: ${id}`);
  process.exit(1);
}

const meta = await head(BLOB_KEY, { token });
const res = await fetch(`${meta.url}?_cb=${Date.now()}`);
const doc = await res.json();

const existing = doc.targets.find((t) => t.id === id);
const now = new Date().toISOString();

if (existing) {
  existing.status = "signup-posted";
  existing.attemptedAt = now;
  console.log(`flipped existing row ${id} → signup-posted`);
} else {
  doc.targets.push({
    ...target,
    status: "signup-posted",
    attemptedAt: now,
    receivedCount: 0,
    seenFromAddresses: [],
    seenFromDomains: [],
  });
  console.log(`added new row ${id} (status: signup-posted)`);
}

doc.updatedAt = now;

await put(BLOB_KEY, JSON.stringify(doc, null, 2), {
  access: "public",
  token,
  allowOverwrite: true,
  cacheControlMaxAge: 0,
  contentType: "application/json",
});

console.log("done. tracker now has", doc.targets.length, "targets");
