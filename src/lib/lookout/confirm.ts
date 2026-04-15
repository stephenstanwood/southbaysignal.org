/**
 * Auto-confirmation logic for inbound mailing-list subscriptions.
 *
 * When we subscribe the inbound address to a newsletter, the provider sends
 * a "please click this link to confirm" email. Rather than running a separate
 * script on a cron, we handle it inline in the intake webhook: detect the
 * subject, find the best-scoring link in the HTML body, GET it.
 *
 * This mirrors the logic in scripts/confirm-subscriptions.mjs — keep the two
 * in sync if one changes. The webhook path is authoritative; the script is
 * a backup for backfilling pending items.
 */

import type { InboundEmail } from "./types.js";

// Subject patterns that indicate "we need you to click to confirm."
// Intentionally broad — misses cost us a real signup; false positives just
// mean we run extra click attempts on newsletters that don't need confirming.
const CONFIRM_SUBJECTS =
  /confirm|verify|opt.?in|activate|validate|needed|register(ation)?|complete\s+(your\s+)?(signup|registration|subscription|sign\s*up)|finish\s+(your\s+)?(signup|sign\s*up|subscri)|action\s+required|pending|please\s+click/i;

// Subject patterns that indicate "you're already in, no action needed."
// These short-circuit before CONFIRM_SUBJECTS so we don't waste a click.
const ACK_SUBJECTS =
  /you\s+(have\s+been|are)\s+subscribed|successfully\s+subscribed|welcome\s+to|thanks\s+for\s+signing\s+up|thank\s+you\s+for\s+subscribing|subscription\s+confirmed/i;

export interface ConfirmEmailInput extends InboundEmail {
  /** Raw HTML body, if available. Confirm logic prefers HTML hrefs to plain-text URLs. */
  html?: string;
}

export type ConfirmOutcome =
  | { kind: "not-a-confirmation" }
  | { kind: "ack-only" }
  | { kind: "no-link-found" }
  | { kind: "clicked"; url: string; status: number }
  | { kind: "click-failed"; url: string; error: string };

export function looksLikeConfirmation(subject: string): boolean {
  if (!subject) return false;
  if (ACK_SUBJECTS.test(subject)) return false;
  return CONFIRM_SUBJECTS.test(subject);
}

export function looksLikeAck(subject: string): boolean {
  return ACK_SUBJECTS.test(subject ?? "");
}

/**
 * Extract the highest-scoring confirmation URL from an email body.
 *
 * Scoring has two layers:
 *   1. Keyword scoring on the URL path itself (confirm/verify/subscribe).
 *      Fast, works for most providers who encode action in the URL.
 *   2. Proximity scoring — if a URL appears within ~200 chars of "click"/
 *      "confirm"/"verify" in the plain-text body, boost it. This catches
 *      opaque-token URLs like Gmail's `mail/vf-[opaque]` that would otherwise
 *      score zero.
 *
 * Unsubscribe / image / schema URLs are heavily penalized so they never win.
 */
export function findConfirmationLink(html: string, text: string): string | null {
  const hrefMatches = [...(html || "").matchAll(/href=["'](https?:\/\/[^"'<>\s]+)["']/gi)].map((m) => m[1]);
  const textMatches = (text || "").match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const urls = Array.from(new Set([...hrefMatches, ...textMatches]));

  const ranked = urls
    .map((u) => ({ u, s: scoreUrl(u) + proximityBoost(u, text) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (ranked.length === 0) return null;
  return ranked[0].u.replace(/&amp;/g, "&");
}

function scoreUrl(u: string): number {
  let s = 0;
  if (/confirm/i.test(u)) s += 10;
  if (/verify|validate|activate/i.test(u)) s += 8;
  if (/subscri/i.test(u)) s += 6;
  if (/optin|opt-in/i.test(u)) s += 6;
  // Avoid unsubscribe, cancel, reject links.
  if (/unsubscri|unsub|\bcancel\b|reject|decline/i.test(u)) s -= 50;
  // Avoid asset / help / policy URLs.
  if (/\.(png|jpg|jpeg|gif|svg|css|js|woff2?|ico)(\?|$)/i.test(u)) s -= 20;
  if (/w3\.org|schema\.org|support\.|help\.|\/help\/|privacy|terms|\/tos/i.test(u)) s -= 15;
  return s;
}

/**
 * If a URL appears near confirm/click/verify keywords in the plain-text body,
 * give it a significant boost. This lets opaque-token confirmation URLs
 * (Gmail's `vf-`, etc.) beat zero-scored unknowns.
 */
function proximityBoost(url: string, text: string): number {
  if (!text) return 0;
  const idx = text.indexOf(url);
  if (idx < 0) return 0;

  // Look at ~300 chars before and ~100 chars after where the URL appears.
  // Confirmation language usually sits immediately before the link.
  const window = text.slice(Math.max(0, idx - 300), idx + 100).toLowerCase();

  let boost = 0;
  if (/click.{0,50}(link|below|here).{0,50}confirm|confirm.{0,80}click|click.{0,50}to\s+confirm/.test(window)) {
    boost += 12;
  } else if (/confirm\s+the\s+(request|subscription|signup|sign\s*up|forwarding)/.test(window)) {
    boost += 10;
  } else if (/click.{0,50}(link|below|here).{0,50}verify|verify.{0,80}click/.test(window)) {
    boost += 10;
  } else if (/\bconfirm\b|\bverify\b|\bactivate\b|\bvalidate\b/.test(window)) {
    // Weak signal — some mention of the action nearby
    boost += 4;
  }

  // Big penalty for cancel/unsubscribe language nearby
  if (/\bcancel\b|\bunsubscribe\b|do\s+not\s+.*click|accidentally\s+clicked/.test(window)) {
    boost -= 30;
  }

  return boost;
}

/**
 * Try to auto-confirm a subscription email. Returns a structured outcome
 * describing what happened — caller logs it.
 */
export async function tryAutoConfirm(email: ConfirmEmailInput): Promise<ConfirmOutcome> {
  if (looksLikeAck(email.subject)) return { kind: "ack-only" };
  if (!looksLikeConfirmation(email.subject)) return { kind: "not-a-confirmation" };

  const url = findConfirmationLink(email.html ?? "", email.body);
  if (!url) return { kind: "no-link-found" };

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "SouthBayToday/1.0 (+https://southbaytoday.org)" },
    });
    return { kind: "clicked", url, status: res.status };
  } catch (err) {
    return { kind: "click-failed", url, error: (err as Error).message };
  }
}
