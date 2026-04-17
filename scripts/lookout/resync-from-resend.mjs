/**
 * Rebuild the newsletter tracker's "seen" / "received" state from Resend's
 * /emails/receiving API — the ground truth for what actually hit the webhook.
 *
 * Why not the intake log? It's blob-stored, capped at 500 entries, and can
 * lose writes. Resend's server is the authoritative source.
 *
 * Why list + per-email detail fetch? The list endpoint reports `from` as our
 * receiving address (the envelope MAIL FROM). The detail endpoint
 * /emails/receiving/{id} returns the real message-From header.
 *
 * This script:
 *   1. Paginates the full Resend inbox
 *   2. Fetches detail for each (throttled) to get true From
 *   3. Reads tracker once, resets all seen/count/status in memory
 *   4. Smart-matches each email to an existing target and bumps state
 *   5. Writes tracker ONCE at the end (atomic — no stale-read windows)
 *
 * Does NOT auto-add rows. Unmatched senders print at the end for manual
 * review.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { head, put, del } from "@vercel/blob";

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const env = readFileSync(join(__dirname, "../../.env.local"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const token = process.env.BLOB_READ_WRITE_TOKEN;
const resendKey = process.env.RESEND_API_KEY;
if (!token || !resendKey) {
  console.error("need BLOB_READ_WRITE_TOKEN and RESEND_API_KEY");
  process.exit(1);
}

const TRACKER_KEY = "lookout/newsletter-tracker.json";

// ── Resend pagination ──────────────────────────────────────────────────────

async function resendGet(path) {
  const res = await fetch(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${resendKey}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`resend ${path}: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

async function fetchAllReceived() {
  const out = [];
  let after = null;
  while (true) {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("after", after);
    const page = await resendGet(`/emails/receiving?${qs}`);
    const data = page.data ?? [];
    out.push(...data);
    if (!page.has_more || data.length === 0) break;
    after = data[data.length - 1].id;
    // polite pause
    await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

// ── Blob I/O ───────────────────────────────────────────────────────────────

async function readTracker() {
  const meta = await head(TRACKER_KEY, { token });
  const res = await fetch(`${meta.url}?_cb=${Date.now()}`, { cache: "no-store" });
  return res.json();
}

async function writeTracker(doc) {
  try {
    await del(TRACKER_KEY, { token });
  } catch {}
  await put(TRACKER_KEY, JSON.stringify(doc, null, 2), {
    access: "public", token, allowOverwrite: true, cacheControlMaxAge: 0,
    contentType: "application/json",
  });
}

// ── Matching (mirrors src/lib/lookout/tracker.ts) ──────────────────────────

function parseFromHeader(raw) {
  if (!raw) return { address: "", displayName: "", domain: "" };
  const trimmed = raw.trim();
  const m = trimmed.match(/^(.*?)\s*<([^>]+)>\s*$/);
  const address = (m ? m[2] : trimmed).toLowerCase().trim();
  const displayName = m ? m[1].replace(/^["']|["']$/g, "").trim() : "";
  const domain = address.split("@")[1] ?? "";
  return { address, displayName, domain };
}

function normalizeKey(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const STOPWORDS = new Set([
  "www", "mail", "mailer", "mails", "email", "emails", "news", "newsletter",
  "info", "hello", "contact", "subscribe", "updates", "update", "noreply",
  "donotreply", "bounces", "list", "lists", "campaign", "campaigns", "relay",
  "smtp", "ccsend", "mailchimpapp", "mailgun", "sendgrid", "sparkpost",
  "constantcontact", "hubspot", "klaviyo", "mailjet", "mandrill", "postmark",
  "squarespace", "wix", "civicplus", "opengov", "libraryaware",
  "com", "org", "net", "edu", "gov", "info", "biz", "co",
  "city", "town", "county", "the", "and", "for", "inc",
]);

function tokenize(s) {
  return (s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

function senderIdentityFragments(domain) {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  const skip = new Set(["www", "mail", "mailer", "news", "email", "em", "m", "smtp", "relay", "ccsend", "ccsend2", "list-manage", "list", "lt", "campaign", "go", "click", "e"]);
  const filtered = parts.filter((p) => !skip.has(p));
  if (filtered.length > 1) filtered.pop();
  return filtered;
}

function scoreMatch(target, s) {
  if ((target.seenFromAddresses ?? []).some((a) => a.toLowerCase() === s.address)) return 1000;
  if (s.domain && (target.seenFromDomains ?? []).some((d) => d.toLowerCase() === s.domain)) return 900;
  if (target.signupUrl) {
    try {
      const host = new URL(target.signupUrl).hostname.toLowerCase().replace(/^www\./, "");
      if (host === s.domain) return 850;
    } catch {}
  }
  const targetKey = normalizeKey(target.name);
  const targetIdKey = normalizeKey(target.id);
  const fragments = [
    ...senderIdentityFragments(s.domain),
    normalizeKey(s.displayName),
    normalizeKey(s.address.split("@")[0] || ""),
  ].filter((f) => f.length >= 5);
  let best = 0;
  for (const frag of fragments) {
    const fragKey = normalizeKey(frag);
    if (!fragKey) continue;
    if (fragKey === targetKey || fragKey === targetIdKey) best = Math.max(best, 700);
    else if (targetKey.includes(fragKey) || fragKey.includes(targetKey)) best = Math.max(best, 650);
    else if (targetIdKey.includes(fragKey) || fragKey.includes(targetIdKey)) best = Math.max(best, 600);
  }
  if (best > 0) return best;
  const senderTokens = new Set([
    ...tokenize(s.displayName),
    ...tokenize(s.domain),
    ...tokenize(s.address.split("@")[0] || ""),
  ]);
  const targetTokens = new Set([...tokenize(target.name), ...tokenize(target.id)]);
  let overlap = 0;
  for (const t of senderTokens) if (targetTokens.has(t)) overlap++;
  if (overlap >= 2) return 450 + overlap * 20;
  return 0;
}

const MATCH_THRESHOLD = 450;
function findMatch(doc, fromHeader) {
  const sender = parseFromHeader(fromHeader);
  if (!sender.address) return { match: null, score: 0 };
  let bestScore = 0, best = null;
  for (const t of doc.targets) {
    const s = scoreMatch(t, sender);
    if (s > bestScore) { bestScore = s; best = t; }
  }
  return bestScore >= MATCH_THRESHOLD ? { match: best, score: bestScore } : { match: null, score: bestScore };
}

// ── Classify email types ───────────────────────────────────────────────────

function isConfirmationSubject(subject) {
  const s = subject ?? "";
  return (
    /confirm|verify|activate|welcome/i.test(s) ||
    /complete.*(registration|signup|sign.up)/i.test(s) ||
    /please.*confirm/i.test(s) ||
    /subscription.+(change|confirmation)/i.test(s) ||
    /thank.*you.*for.*subscribing/i.test(s) ||
    /you.*(have been|are now|'?ve been).*subscribed to/i.test(s) ||  // CivicPlus NotifyMe
    /you have successfully subscribed/i.test(s) ||
    /opt.?in|opt-in/i.test(s)
  );
}

// ── Run ────────────────────────────────────────────────────────────────────

console.log("fetching Resend receiving list...");
const listItems = await fetchAllReceived();
console.log(`received-list entries: ${listItems.length}`);

console.log("fetching detail for each (to get real From header)...");
const details = [];
for (let i = 0; i < listItems.length; i++) {
  const item = listItems[i];
  try {
    const detail = await resendGet(`/emails/receiving/${item.id}`);
    details.push({
      id: item.id,
      from: detail.from ?? item.from,
      replyTo: Array.isArray(item.reply_to) ? item.reply_to[0] : null,
      subject: detail.subject ?? item.subject,
      receivedAt: detail.created_at ?? item.created_at,
      messageId: detail.message_id ?? item.message_id,
    });
  } catch (err) {
    console.warn(`  [${i}] detail fetch failed for ${item.id}: ${err.message}`);
  }
  if (i % 10 === 9) process.stdout.write(`  ${i + 1}/${listItems.length}\r`);
  await new Promise((r) => setTimeout(r, 120));
}
console.log(`\ndetail fetches: ${details.length}`);

// Sort chronologically
details.sort((a, b) => (a.receivedAt ?? "").localeCompare(b.receivedAt ?? ""));

// Prefer reply_to as the true sender when Resend's detail.from is our own address
const SELF_ADDRESSES = new Set(["events@in.southbaytoday.org"]);
for (const e of details) {
  const { address } = parseFromHeader(e.from);
  if (SELF_ADDRESSES.has(address) && e.replyTo) {
    e.from = e.replyTo;
  }
}

// Read tracker once
console.log("\nreading tracker...");
const doc = await readTracker();
console.log(`  targets: ${doc.targets.length}, tombstones: ${(doc.deletedIds ?? []).length}`);

// Reset all state in memory
for (const t of doc.targets) {
  t.receivedCount = 0;
  delete t.lastReceivedAt;
  t.seenFromAddresses = [];
  t.seenFromDomains = [];
  if (t.status === "receiving") t.status = "signup-posted";
}

// Classify & match
const IGNORE_DOMAINS = new Set(["in.southbaytoday.org", "southbaytoday.org", "stanwood.dev", "gmail.com"]);
let skippedConfirm = 0;
let skippedIgnore = 0;
let matched = 0;
let promoted = 0;
const unmatched = new Map();
const matchReport = new Map();

for (const e of details) {
  const { address, domain } = parseFromHeader(e.from);
  if (!address) continue;
  if (IGNORE_DOMAINS.has(domain)) { skippedIgnore++; continue; }
  if (isConfirmationSubject(e.subject)) { skippedConfirm++; continue; }

  const { match, score } = findMatch(doc, e.from);
  if (!match) {
    const key = `${e.from}  —  ${e.subject?.slice(0, 60)}`;
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
    continue;
  }
  matched++;
  match.lastReceivedAt = e.receivedAt;
  match.receivedCount = (match.receivedCount ?? 0) + 1;
  const promotable = ["signup-posted", "confirmed", "needs-manual", "retry", "not-attempted", "failed"];
  if (promotable.includes(match.status)) {
    if (match.status !== "receiving") promoted++;
    match.status = "receiving";
  }
  if (!match.seenFromAddresses.includes(address)) match.seenFromAddresses.push(address);
  if (domain && !(match.seenFromDomains ?? []).includes(domain)) {
    match.seenFromDomains = [...(match.seenFromDomains ?? []), domain];
  }
  const prev = matchReport.get(match.id) ?? { name: match.name, count: 0, score };
  matchReport.set(match.id, { name: match.name, count: prev.count + 1, score: Math.max(prev.score, score) });
}

doc.updatedAt = new Date().toISOString();
await writeTracker(doc);

console.log(`\nskipped (confirmation emails): ${skippedConfirm}`);
console.log(`skipped (self/infra senders): ${skippedIgnore}`);
console.log(`matched: ${matched}, promoted to receiving: ${promoted}`);
if (matchReport.size > 0) {
  console.log(`\nmatches by target:`);
  for (const [id, { name, count, score }] of [...matchReport.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(count).padStart(3)}  ${name}  [${id}]  score=${score}`);
  }
}
if (unmatched.size > 0) {
  console.log(`\nunmatched senders (review manually):`);
  for (const [key, n] of [...unmatched.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${key}`);
  }
}
