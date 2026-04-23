/**
 * Hourly reconcile of the newsletter tracker against Resend's inbox.
 *
 * Why: the inline webhook does most of the work, but we want a belt-and-
 * suspenders safety net in case a webhook delivery is dropped, a write is
 * lost, or the matcher misses a sender that later shows up tagged.
 *
 * What this does: pulls the last ~48h of inbound from Resend's
 * /emails/receiving API, classifies each, and bumps tracker state with
 * the same scoring logic used by noteInboundFromSender. Single atomic
 * read-modify-write of the tracker blob.
 *
 * Auth:
 *   - Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically
 *     when configured in vercel.json.
 *   - Manual invocation supported via ?key=<ADMIN_KEY>.
 */

import type { APIRoute } from "astro";
import { readTracker, writeTracker } from "../../../../lib/lookout/tracker.ts";
import { looksLikeAck, looksLikeConfirmation } from "../../../../lib/lookout/confirm.ts";
import { resolveRealSender, SELF_INFRA_DOMAINS as IGNORE_DOMAINS } from "../../../../lib/lookout/resend-from.ts";
import type { NewsletterTarget } from "../../../../lib/lookout/tracker.ts";

export const prerender = false;

// Look this many hours back on each run. The webhook handles the freshly-
// arrived emails; this is only a catch-up. 48h gives plenty of overlap
// without re-processing the entire history every hour.
const LOOKBACK_HOURS = 48;

interface ResendListItem {
  id: string;
  from: string;
  to: string[];
  subject: string;
  created_at: string;
  message_id?: string;
  reply_to?: string[];
  headers?: Record<string, unknown>;
}

interface ResendDetail extends ResendListItem {
  /* detail endpoint adds body fields we don't use here */
}

async function resendGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`resend ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchRecentReceived(apiKey: string, sinceIso: string): Promise<ResendListItem[]> {
  const out: ResendListItem[] = [];
  let after: string | null = null;
  // Safety cap so we never spin forever; 10 pages * 100 = 1000 emails plenty.
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("after", after);
    const body = await resendGet<{ data: ResendListItem[]; has_more: boolean }>(
      `/emails/receiving?${qs}`,
      apiKey
    );
    const data = body.data ?? [];
    for (const item of data) {
      if (item.created_at < sinceIso) return out; // older than lookback window — stop
      out.push(item);
    }
    if (!body.has_more || data.length === 0) break;
    after = data[data.length - 1].id;
  }
  return out;
}

// ── Scoring — mirrors the logic in tracker.ts to keep the two in sync ────

function parseFromHeader(raw: string): { address: string; displayName: string; domain: string } {
  if (!raw) return { address: "", displayName: "", domain: "" };
  const trimmed = raw.trim();
  const m = trimmed.match(/^(.*?)\s*<([^>]+)>\s*$/);
  const address = (m ? m[2] : trimmed).toLowerCase().trim();
  const displayName = m ? m[1].replace(/^["']|["']$/g, "").trim() : "";
  const domain = address.split("@")[1] ?? "";
  return { address, displayName, domain };
}
function normalizeKey(s: string): string {
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
function tokenize(s: string): string[] {
  return (s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}
function senderIdentityFragments(domain: string): string[] {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  const skip = new Set(["www", "mail", "mailer", "news", "email", "em", "m", "smtp", "relay", "ccsend", "ccsend2", "list-manage", "list", "lt", "campaign", "go", "click", "e"]);
  const filtered = parts.filter((p) => !skip.has(p));
  if (filtered.length > 1) filtered.pop();
  return filtered;
}
function scoreMatch(target: NewsletterTarget, s: { address: string; displayName: string; domain: string }): number {
  if ((target.seenFromAddresses ?? []).some((a) => a.toLowerCase() === s.address)) return 1000;
  if (s.domain && (target.seenFromDomains ?? []).some((d) => d.toLowerCase() === s.domain)) return 900;
  if (target.signupUrl) {
    try {
      const host = new URL(target.signupUrl).hostname.toLowerCase().replace(/^www\./, "");
      if (host === s.domain) return 850;
    } catch { /* ignore */ }
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
  const senderTokens = new Set<string>([
    ...tokenize(s.displayName),
    ...tokenize(s.domain),
    ...tokenize(s.address.split("@")[0] || ""),
  ]);
  const targetTokens = new Set<string>([...tokenize(target.name), ...tokenize(target.id)]);
  let overlap = 0;
  for (const t of senderTokens) if (targetTokens.has(t)) overlap++;
  if (overlap >= 2) return 450 + overlap * 20;
  return 0;
}
const MATCH_THRESHOLD = 450;

// ── Handler ─────────────────────────────────────────────────────────────────

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const cronSecret = process.env.CRON_SECRET ?? "";
  const adminKey = process.env.ADMIN_KEY ?? "";
  const providedKey = url.searchParams.get("key") ?? "";
  const authed =
    (cronSecret && bearer === cronSecret) ||
    (adminKey && (providedKey === adminKey || bearer === adminKey));
  if (!authed) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const resendKey = process.env.RESEND_API_KEY ?? "";
  if (!resendKey) return Response.json({ ok: false, error: "RESEND_API_KEY not set" }, { status: 500 });

  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  let listItems: ResendListItem[];
  try {
    listItems = await fetchRecentReceived(resendKey, since);
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }

  // Fetch detail for each to recover true From header (list endpoint hides it).
  const details: ResendListItem[] = [];
  for (const item of listItems) {
    try {
      const d = await resendGet<ResendDetail>(`/emails/receiving/${item.id}`, resendKey);
      details.push({
        ...item,
        from: d.from ?? item.from,
        subject: d.subject ?? item.subject,
        reply_to: d.reply_to ?? item.reply_to,
        headers: d.headers,
      });
    } catch {
      /* skip */
    }
  }

  const doc = await readTracker();
  const now = new Date().toISOString();

  let matched = 0;
  let promoted = 0;
  let skippedConfirmAck = 0;
  let skippedIgnore = 0;
  const unmatched: string[] = [];
  const touched = new Set<string>();

  details.sort((a, b) => a.created_at.localeCompare(b.created_at));

  for (const e of details) {
    // Gmail forwarding rewrites the envelope From, so `detail.from` for most
    // inbound traffic is `events@in.southbaytoday.org`. Recover the original
    // sender via headers.from → reply_to → listed value.
    const from = resolveRealSender(e.from, e.headers, e.reply_to);
    const { address, domain, displayName } = parseFromHeader(from);
    if (!address) continue;
    if (IGNORE_DOMAINS.has(domain)) { skippedIgnore++; continue; }
    if (looksLikeAck(e.subject) || looksLikeConfirmation(e.subject)) { skippedConfirmAck++; continue; }

    let bestScore = 0;
    let best: NewsletterTarget | null = null;
    for (const t of doc.targets) {
      const s = scoreMatch(t, { address, displayName, domain });
      if (s > bestScore) { bestScore = s; best = t; }
    }
    if (!best || bestScore < MATCH_THRESHOLD) {
      unmatched.push(`${from} | ${e.subject?.slice(0, 60) ?? ""}`);
      continue;
    }

    // Only bump once per (messageId, target) so repeated runs don't inflate count.
    const dedupKey = `${e.message_id ?? e.id}::${best.id}`;
    // Stamp a lightweight marker on the target row via an extra field.
    // If this ever gets large, move to a separate "seen message ids" blob.
    best.seenMessageIds = best.seenMessageIds ?? [];
    if (best.seenMessageIds.includes(dedupKey)) continue;
    best.seenMessageIds.push(dedupKey);
    // Cap to last 200 per row so the blob doesn't blow up.
    if (best.seenMessageIds.length > 200) best.seenMessageIds = best.seenMessageIds.slice(-200);

    matched++;
    touched.add(best.id);
    best.lastReceivedAt = e.created_at;
    best.receivedCount = (best.receivedCount ?? 0) + 1;
    const promotable = ["signup-posted", "confirmed", "needs-manual", "retry", "not-attempted", "failed"];
    if (promotable.includes(best.status)) {
      if (best.status !== "receiving") promoted++;
      best.status = "receiving";
    }
    if (!best.seenFromAddresses.includes(address)) best.seenFromAddresses.push(address);
    if (domain && !(best.seenFromDomains ?? []).includes(domain)) {
      best.seenFromDomains = [...(best.seenFromDomains ?? []), domain];
    }
  }

  if (touched.size > 0 || unmatched.length > 0) {
    await writeTracker(doc);
  }

  return Response.json({
    ok: true,
    ranAt: now,
    lookbackHours: LOOKBACK_HOURS,
    totalFetched: details.length,
    matched,
    promoted,
    touchedTargets: touched.size,
    skippedConfirmAck,
    skippedIgnore,
    unmatched: unmatched.slice(0, 40), // return first few for visibility
    unmatchedCount: unmatched.length,
  });
}

export const GET: APIRoute = ({ request }) => handle(request);
export const POST: APIRoute = ({ request }) => handle(request);
