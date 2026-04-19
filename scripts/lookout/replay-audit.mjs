/**
 * Replay tracker-audit entries onto the live tracker.
 *
 * Each user-initiated mutation (mark.ts, delete.ts) writes a tiny per-entry
 * blob under lookout/tracker-audit/ before touching the main blob. If the
 * tracker ever gets wiped again (race, fat-finger, etc.), this script lists
 * every audit entry, sorts by timestamp, and re-applies them.
 *
 * Usage:
 *   node scripts/lookout/reseed-from-targets.mjs    # restore row existence
 *   node scripts/lookout/resync-from-resend.mjs     # restore "receiving" from inbox
 *   node scripts/lookout/replay-audit.mjs           # restore manual status edits
 */

import { head, list, put } from "@vercel/blob";

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) { console.error("need BLOB_READ_WRITE_TOKEN"); process.exit(1); }

const TRACKER_KEY = "lookout/newsletter-tracker.json";
const AUDIT_PREFIX = "lookout/tracker-audit/";

const meta = await head(TRACKER_KEY, { token });
const doc = await (await fetch(`${meta.url}?_cb=${Date.now()}`)).json();
console.log(`tracker: ${doc.targets.length} targets`);

const entries = [];
let cursor = undefined;
while (true) {
  const r = await list({ token, prefix: AUDIT_PREFIX, cursor, limit: 1000 });
  for (const b of r.blobs) {
    try {
      const e = await (await fetch(`${b.url}?_cb=${Date.now()}`)).json();
      entries.push(e);
    } catch (err) {
      console.warn(`skip ${b.pathname}: ${err.message}`);
    }
  }
  if (!r.hasMore) break;
  cursor = r.cursor;
}
console.log(`audit entries: ${entries.length}`);
entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

const byId = new Map(doc.targets.map((t) => [t.id, t]));
const deleted = new Set(doc.deletedIds ?? []);
let applied = 0;
for (const e of entries) {
  if (e.action === "status-change") {
    const t = byId.get(e.id);
    if (!t) continue;
    if (t.status !== e.toStatus) { t.status = e.toStatus; t.attemptedAt = e.at; applied++; }
  } else if (e.action === "delete") {
    if (!deleted.has(e.id)) { deleted.add(e.id); applied++; }
  }
}
doc.deletedIds = Array.from(deleted);
doc.targets = doc.targets.filter((t) => !deleted.has(t.id));
doc.updatedAt = new Date().toISOString();

await put(TRACKER_KEY, JSON.stringify(doc, null, 2), {
  access: "public", token, allowOverwrite: true, cacheControlMaxAge: 0,
  contentType: "application/json",
});
console.log(`replayed ${applied} entries onto ${doc.targets.length} targets`);
