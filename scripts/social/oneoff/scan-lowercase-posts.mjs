// One-off: scan recent posts on every social platform for lowercase-start
// posts (the "this afternoon" bug from the case-mangling rewriter). Reports
// matches; does NOT modify anything. Used 2026-04-26 to find the Vienna Teng
// + Milpitas films posts that escaped capitalization.

import { readFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";

function loadEnv() {
  const lines = readFileSync(".env.local", "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
  const m = {};
  for (const l of lines) {
    const i = l.indexOf("=");
    if (i > 0) m[l.slice(0, i)] = l.slice(i + 1).replace(/^"|"$/g, "");
  }
  return m;
}

const E = loadEnv();

function flag(text) {
  return /^[a-z]/.test(text || "") ? "⚠ LOWER" : "  OK   ";
}

function head(text) {
  return (text || "").slice(0, 90).replace(/\n+/g, " ");
}

// ── X / Twitter (OAuth 1.0a) ─────────────────────────────────────────────
function pe(s) {
  return encodeURIComponent(s).replace(/[!*()']/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function xAuth(method, url, query) {
  const oa = [
    ["oauth_consumer_key", E.X_API_KEY],
    ["oauth_nonce", randomBytes(16).toString("hex")],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", Math.floor(Date.now() / 1000).toString()],
    ["oauth_token", E.X_ACCESS_TOKEN],
    ["oauth_version", "1.0"],
  ];
  const all = [...oa, ...Object.entries(query || {})];
  const sorted = [...all].sort((a, b) => a[0].localeCompare(b[0]));
  const ps = sorted.map(([k, v]) => `${pe(k)}=${pe(v)}`).join("&");
  const base = `${method.toUpperCase()}&${pe(url)}&${pe(ps)}`;
  const key = `${pe(E.X_API_SECRET)}&${pe(E.X_ACCESS_TOKEN_SECRET)}`;
  const sig = createHmac("sha1", key).update(base).digest("base64");
  return "OAuth " + [...oa, ["oauth_signature", sig]].map(([k, v]) => `${pe(k)}="${pe(v)}"`).join(", ");
}

async function scanX() {
  console.log("\n=== X (twitter) ===");
  const meUrl = "https://api.twitter.com/2/users/me";
  const me = await (await fetch(meUrl, { headers: { Authorization: xAuth("GET", meUrl, {}) } })).json();
  const uid = me?.data?.id;
  if (!uid) {
    console.log("X user lookup failed:", JSON.stringify(me).slice(0, 300));
    return [];
  }
  const tweetsUrl = `https://api.twitter.com/2/users/${uid}/tweets`;
  const params = { max_results: "30", "tweet.fields": "created_at,text" };
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const r = await fetch(`${tweetsUrl}?${qs}`, { headers: { Authorization: xAuth("GET", tweetsUrl, params) } });
  const j = await r.json();
  if (j.errors || j.error) {
    console.log("X tweets fetch failed:", JSON.stringify(j).slice(0, 300));
    return [];
  }
  const arr = j.data || [];
  const lower = [];
  for (const t of arr) {
    console.log(flag(t.text), "|", t.created_at, "| id:", t.id, "|", head(t.text));
    if (/^[a-z]/.test(t.text)) lower.push({ platform: "x", id: t.id, created_at: t.created_at, text: t.text });
  }
  return lower;
}

// ── Bluesky ─────────────────────────────────────────────────────────────
async function scanBluesky() {
  console.log("\n=== Bluesky ===");
  const handle = E.BLUESKY_HANDLE;
  if (!handle) return [];
  const r = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${handle}&limit=20`);
  const j = await r.json();
  const feed = j.feed || [];
  const lower = [];
  for (const item of feed) {
    const post = item.post;
    const text = post.record?.text || "";
    console.log(flag(text), "|", post.indexedAt, "| uri:", post.uri, "|", head(text));
    if (/^[a-z]/.test(text)) lower.push({ platform: "bluesky", uri: post.uri, indexedAt: post.indexedAt, text });
  }
  return lower;
}

// ── Threads ─────────────────────────────────────────────────────────────
async function scanThreads() {
  console.log("\n=== Threads ===");
  const tok = E.THREADS_ACCESS_TOKEN, uid = E.THREADS_USER_ID;
  if (!tok || !uid) return [];
  const r = await fetch(`https://graph.threads.net/v1.0/${uid}/threads?fields=id,text,timestamp&limit=20&access_token=${tok}`);
  const j = await r.json();
  if (j.error) { console.log("Threads error:", JSON.stringify(j.error)); return []; }
  const lower = [];
  for (const p of j.data || []) {
    console.log(flag(p.text), "|", p.timestamp, "| id:", p.id, "|", head(p.text));
    if (/^[a-z]/.test(p.text || "")) lower.push({ platform: "threads", id: p.id, timestamp: p.timestamp, text: p.text });
  }
  return lower;
}

// ── Instagram ───────────────────────────────────────────────────────────
async function scanInstagram() {
  console.log("\n=== Instagram ===");
  const tok = E.INSTAGRAM_ACCESS_TOKEN, uid = E.INSTAGRAM_USER_ID;
  if (!tok || !uid) return [];
  const r = await fetch(`https://graph.instagram.com/v23.0/${uid}/media?fields=id,caption,timestamp&limit=20&access_token=${tok}`);
  const j = await r.json();
  if (j.error) { console.log("IG error:", JSON.stringify(j.error)); return []; }
  const lower = [];
  for (const p of j.data || []) {
    console.log(flag(p.caption), "|", p.timestamp, "| id:", p.id, "|", head(p.caption));
    if (/^[a-z]/.test(p.caption || "")) lower.push({ platform: "instagram", id: p.id, timestamp: p.timestamp, caption: p.caption });
  }
  return lower;
}

// ── Facebook ────────────────────────────────────────────────────────────
async function scanFacebook() {
  console.log("\n=== Facebook ===");
  const tok = E.FB_PAGE_ACCESS_TOKEN, pid = E.FB_PAGE_ID;
  if (!tok || !pid) return [];
  const r = await fetch(`https://graph.facebook.com/v21.0/${pid}/posts?fields=id,message,created_time&limit=20&access_token=${tok}`);
  const j = await r.json();
  if (j.error) { console.log("FB error:", JSON.stringify(j.error)); return []; }
  const lower = [];
  for (const p of j.data || []) {
    console.log(flag(p.message), "|", p.created_time, "| id:", p.id, "|", head(p.message));
    if (/^[a-z]/.test(p.message || "")) lower.push({ platform: "facebook", id: p.id, created_time: p.created_time, message: p.message });
  }
  return lower;
}

// ── Mastodon ────────────────────────────────────────────────────────────
async function scanMastodon() {
  console.log("\n=== Mastodon ===");
  const tok = E.MASTODON_ACCESS_TOKEN, uid = E.MASTODON_ACCOUNT_ID;
  if (!tok || !uid) return [];
  const r = await fetch(`https://mastodon.social/api/v1/accounts/${uid}/statuses?limit=20`);
  const arr = await r.json();
  const lower = [];
  for (const s of arr) {
    const text = (s.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    console.log(flag(text), "|", s.created_at, "| id:", s.id, "|", head(text));
    if (/^[a-z]/.test(text)) lower.push({ platform: "mastodon", id: s.id, created_at: s.created_at, text });
  }
  return lower;
}

// ── Main ────────────────────────────────────────────────────────────────
const all = [];
all.push(...await scanX());
all.push(...await scanBluesky());
all.push(...await scanThreads());
all.push(...await scanInstagram());
all.push(...await scanFacebook());
all.push(...await scanMastodon());

console.log("\n\n========== SUMMARY ==========");
console.log("Total lowercase-start posts:", all.length);
const byPlat = all.reduce((m, p) => ({ ...m, [p.platform]: (m[p.platform] || 0) + 1 }), {});
console.log("By platform:", byPlat);
console.log("\nList:");
for (const p of all) {
  const ts = p.created_at || p.indexedAt || p.timestamp || p.created_time;
  const id = p.id || p.uri;
  const text = p.text || p.caption || p.message;
  console.log(`  - [${p.platform}] ${ts} | ${id}`);
  console.log(`    ${head(text)}`);
}
