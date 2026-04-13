#!/usr/bin/env node
// Delete ALL posts before a cutoff date from all platforms.
// Usage: node scripts/social/nuke-old-posts.mjs [--cutoff YYYY-MM-DD] [--dry-run]
// Default cutoff: today in PT

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env
try {
  const lines = readFileSync(join(__dirname, "..", "..", ".env.local"), "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const cutoffIdx = args.indexOf("--cutoff");
const cutoff = cutoffIdx >= 0 ? args[cutoffIdx + 1] : new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

console.log(`Deleting all posts before ${cutoff}${dryRun ? " (DRY RUN)" : ""}\n`);

const BSKY_API = "https://bsky.social/xrpc";

// ── Bluesky ──
async function nukeBluesky() {
  console.log("=== BLUESKY ===");
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) { console.log("  No credentials"); return; }

  const authRes = await fetch(`${BSKY_API}/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password }),
  });
  if (!authRes.ok) { console.log("  Auth failed"); return; }
  const session = await authRes.json();
  const did = session.did;
  const token = session.accessJwt;

  let cursor = undefined;
  let deleted = 0;
  do {
    const url = `${BSKY_API}/app.bsky.feed.getAuthorFeed?actor=${did}&limit=50${cursor ? "&cursor=" + cursor : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const data = await res.json();
    const feed = data.feed || [];

    for (const item of feed) {
      const post = item.post;
      const createdAt = (post.record?.createdAt || "").slice(0, 10);
      const text = (post.record?.text || "").slice(0, 60);

      if (createdAt && createdAt < cutoff) {
        if (dryRun) {
          console.log(`  Would delete: ${createdAt} ${text}`);
        } else {
          const rkey = post.uri.split("/").pop();
          const delRes = await fetch(`${BSKY_API}/com.atproto.repo.deleteRecord`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", rkey }),
          });
          console.log(`  ${delRes.ok ? "Deleted" : "Failed"}: ${createdAt} ${text}`);
          await new Promise(r => setTimeout(r, 200));
        }
        deleted++;
      }
    }

    cursor = data.cursor;
    if (feed.length === 0) break;
  } while (cursor);

  console.log(`  Total: ${deleted}\n`);
}

// ── X (Twitter) ──
async function nukeX() {
  console.log("=== X ===");
  const { deletePost } = await import("./lib/platforms/x.mjs");

  // X API v2 doesn't have a simple "list my tweets" without user ID
  // Pull from our publish records instead
  const files = [
    join(__dirname, "..", "..", "src", "data", "south-bay", "social-approved-queue.json"),
  ];

  let deleted = 0;
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(f, "utf8"));
      const posts = Array.isArray(data) ? data : [];
      for (const p of posts) {
        if (!p.publishedTo) continue;
        for (const result of p.publishedTo) {
          if (result.platform !== "x" || !result.ok) continue;
          const postId = result.postId || result.id;
          if (!postId) continue;
          const pubDate = (p.publishedAt || "").slice(0, 10);
          if (pubDate && pubDate < cutoff) {
            if (dryRun) {
              console.log(`  Would delete: ${pubDate} ${postId}`);
            } else {
              try {
                await deletePost(postId);
                console.log(`  Deleted: ${pubDate} ${postId}`);
              } catch (e) {
                console.log(`  Failed: ${postId} ${e.message}`);
              }
              await new Promise(r => setTimeout(r, 200));
            }
            deleted++;
          }
        }
      }
    } catch {}
  }
  console.log(`  Total from records: ${deleted}\n`);
}

// ── Threads ──
async function nukeThreads() {
  console.log("=== THREADS ===");
  const token = process.env.THREADS_ACCESS_TOKEN;
  const userId = process.env.THREADS_USER_ID;
  if (!token || !userId) { console.log("  No credentials"); return; }

  let deleted = 0;
  let url = `https://graph.threads.net/v1.0/${userId}/threads?fields=id,text,timestamp&limit=50&access_token=${token}`;

  while (url) {
    const res = await fetch(url);
    if (!res.ok) { console.log("  Fetch failed:", res.status); break; }
    const data = await res.json();

    for (const post of (data.data || [])) {
      const createdAt = (post.timestamp || "").slice(0, 10);
      const text = (post.text || "").slice(0, 60);

      if (createdAt && createdAt < cutoff) {
        if (dryRun) {
          console.log(`  Would delete: ${createdAt} ${text}`);
        } else {
          const delRes = await fetch(`https://graph.threads.net/v1.0/${post.id}?access_token=${token}`, { method: "DELETE" });
          console.log(`  ${delRes.ok ? "Deleted" : "Failed"}: ${createdAt} ${text}`);
          await new Promise(r => setTimeout(r, 500));
        }
        deleted++;
      }
    }

    url = data.paging?.next || null;
  }
  console.log(`  Total: ${deleted}\n`);
}

// ── Facebook ──
async function nukeFacebook() {
  console.log("=== FACEBOOK ===");
  const token = process.env.FACEBOOK_PAGE_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  if (!token || !pageId) { console.log("  No credentials"); return; }

  let deleted = 0;
  let url = `https://graph.facebook.com/v21.0/${pageId}/feed?fields=id,message,created_time&limit=50&access_token=${token}`;

  while (url) {
    const res = await fetch(url);
    if (!res.ok) { console.log("  Fetch failed:", res.status); break; }
    const data = await res.json();

    for (const post of (data.data || [])) {
      const createdAt = (post.created_time || "").slice(0, 10);
      const text = (post.message || "").slice(0, 60);

      if (createdAt && createdAt < cutoff) {
        if (dryRun) {
          console.log(`  Would delete: ${createdAt} ${text}`);
        } else {
          const delRes = await fetch(`https://graph.facebook.com/v21.0/${post.id}?access_token=${token}`, { method: "DELETE" });
          console.log(`  ${delRes.ok ? "Deleted" : "Failed"}: ${createdAt} ${text}`);
          await new Promise(r => setTimeout(r, 500));
        }
        deleted++;
      }
    }

    url = data.paging?.next || null;
  }
  console.log(`  Total: ${deleted}\n`);
}

// ── Mastodon ──
async function nukeMastodon() {
  console.log("=== MASTODON ===");
  const token = process.env.MASTODON_ACCESS_TOKEN;
  const instance = process.env.MASTODON_INSTANCE || "https://mastodon.social";
  if (!token) { console.log("  No credentials"); return; }

  // Get account ID
  const meRes = await fetch(`${instance}/api/v1/accounts/verify_credentials`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meRes.ok) { console.log("  Auth failed"); return; }
  const me = await meRes.json();

  let deleted = 0;
  let maxId = undefined;

  while (true) {
    const url = `${instance}/api/v1/accounts/${me.id}/statuses?limit=40${maxId ? "&max_id=" + maxId : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const statuses = await res.json();
    if (statuses.length === 0) break;

    for (const status of statuses) {
      const createdAt = (status.created_at || "").slice(0, 10);
      const text = (status.content || "").replace(/<[^>]*>/g, "").slice(0, 60);

      if (createdAt && createdAt < cutoff) {
        if (dryRun) {
          console.log(`  Would delete: ${createdAt} ${text}`);
        } else {
          const delRes = await fetch(`${instance}/api/v1/statuses/${status.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
          console.log(`  ${delRes.ok ? "Deleted" : "Failed"}: ${createdAt} ${text}`);
          await new Promise(r => setTimeout(r, 200));
        }
        deleted++;
      }
    }

    maxId = statuses[statuses.length - 1].id;
  }
  console.log(`  Total: ${deleted}\n`);
}

await nukeBluesky();
await nukeX();
await nukeThreads();
await nukeFacebook();
await nukeMastodon();

console.log("Done");
