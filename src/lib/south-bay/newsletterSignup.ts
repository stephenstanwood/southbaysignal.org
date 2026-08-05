// Double opt-in for the daily newsletter.
//
// The signup form used to write straight into the live Resend audience with
// `unsubscribed: false`. An unprotected public form that instantly subscribes
// is a standing invitation: between 2026-07-21 and 2026-08-01 roughly thirty
// bot signups landed that way — Gmail dot-variants of the same inboxes, role
// addresses (`payroll@`, `accountspayable@`), and out-of-area corporate domains
// — and every one of them received the daily broadcast, putting the sender
// reputation the real subscribers depend on at risk.
//
// Now a signup lands as `unsubscribed: true` (present in the audience, excluded
// from every broadcast) and only flips to subscribed when someone clicks a
// signed link in a confirmation email. Bots do not click confirmation links.

import { createHmac, timingSafeEqual } from "node:crypto";

export const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESEND_BASE = "https://api.resend.com";
export const FROM_ADDRESS = "The South Bay Today <stephen@southbaytoday.org>";

/**
 * Server-side env lookup. Vercel populates `process.env`; the Astro dev server
 * only surfaces `.env.local` through `import.meta.env`, so both are consulted
 * to keep local runs faithful to production.
 */
export function serverEnv(key: string): string | undefined {
  // `import.meta.env` only exists under Vite/Astro — this module is also
  // imported by plain-Node tests and scripts, where reading it would throw.
  const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
  return process.env[key] || viteEnv?.[key];
}

/**
 * Signing key for confirmation links. A dedicated secret is preferred, but the
 * Resend key is always present wherever this route runs and never leaves the
 * server, so the flow needs no new configuration to be safe.
 */
function signingSecret(): string {
  const dedicated = serverEnv("NEWSLETTER_CONFIRM_SECRET");
  if (dedicated) return dedicated;
  const fallback = serverEnv("RESEND_API_KEY");
  if (!fallback) throw new Error("no signing secret available");
  return `newsletter-confirm:${fallback}`;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function createConfirmToken(email: string, now = Date.now()): string {
  const payload = b64url(JSON.stringify({ e: email, x: now + CONFIRM_TTL_MS }));
  const sig = b64url(createHmac("sha256", signingSecret()).update(payload).digest());
  return `${payload}.${sig}`;
}

/**
 * Returns the email a token vouches for, or null if it is forged, expired, or
 * unverifiable. Never throws: a reader clicking a link should always land on a
 * page that explains itself, never on a 500.
 */
export function readConfirmToken(token: string, now = Date.now()): string | null {
  try {
    const [payload, sig] = String(token || "").split(".");
    if (!payload || !sig) return null;

    const expected = createHmac("sha256", signingSecret()).update(payload).digest();
    const provided = fromB64url(sig);
    // timingSafeEqual throws on a length mismatch, which is itself a rejection.
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

    const { e, x } = JSON.parse(fromB64url(payload).toString("utf8"));
    if (typeof e !== "string" || typeof x !== "number" || now > x) return null;
    return e;
  } catch {
    return null;
  }
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Best-effort per-IP throttle. Serverless instances are reused under Fluid
 * Compute but not shared, so this bounds a burst from one attacker against one
 * instance rather than acting as a global limit. Double opt-in is the real
 * control; this just keeps the audience and the mail budget from being flooded
 * while a bot is hammering the endpoint.
 */
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
const recentByIp = new Map<string, number[]>();

export function rateLimited(ip: string, now = Date.now()): boolean {
  if (!ip) return false;
  const cutoff = now - RATE_WINDOW_MS;
  const hits = (recentByIp.get(ip) || []).filter((t) => t > cutoff);
  hits.push(now);
  recentByIp.set(ip, hits);

  // Keep the map from growing without bound on a long-lived instance.
  if (recentByIp.size > 5000) {
    for (const [key, times] of recentByIp) {
      if (times.every((t) => t <= cutoff)) recentByIp.delete(key);
    }
  }
  return hits.length > RATE_MAX;
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "";
}

export function confirmationEmail(confirmUrl: string): { subject: string; html: string; text: string } {
  return {
    subject: "Confirm your South Bay Today subscription",
    text:
      `One more step and you're in.\n\n` +
      `Confirm your subscription: ${confirmUrl}\n\n` +
      `After that you'll get one email each morning at 6:00 AM with the day's plan ` +
      `and everything else we know about.\n\n` +
      `If you didn't sign up, ignore this — nothing happens without the link above.\n`,
    html: `<!DOCTYPE html>
<html lang="en"><body style="margin:0;padding:24px;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a2e">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #c8c4bc;border-radius:6px;padding:32px">
    <div style="font-size:20px;font-weight:700;margin-bottom:12px">One more step and you're in.</div>
    <p style="font-size:15px;line-height:1.55;margin:0 0 24px">
      Confirm your subscription and you'll get one email each morning at 6:00&nbsp;AM
      with the day's plan and everything else we know about.
    </p>
    <a href="${confirmUrl}" style="display:inline-block;padding:12px 22px;background:#1a1a2e;color:#fff;text-decoration:none;border-radius:4px;font-size:15px;font-weight:600">Confirm subscription</a>
    <p style="font-size:13px;line-height:1.5;color:#5b6478;margin:24px 0 0">
      If you didn't sign up, ignore this email — nothing happens without that link.
    </p>
  </div>
</body></html>`,
  };
}
