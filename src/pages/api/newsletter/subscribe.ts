import type { APIRoute } from "astro";
import config from "../../../data/south-bay/newsletter-config.json";
import {
  RESEND_BASE,
  FROM_ADDRESS,
  clientIp,
  confirmationEmail,
  createConfirmToken,
  isValidEmail,
  rateLimited,
  serverEnv,
} from "../../../lib/south-bay/newsletterSignup";

export const prerender = false;

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ok(extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ ok: true, ...extra }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export const POST: APIRoute = async ({ request }) => {
  let body: { email?: string; name?: string; website?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid JSON");
  }

  // Honeypot: the form renders a hidden "website" field that a person never
  // sees and never fills. Report success so the bot has nothing to tune against.
  if (String(body.website ?? "").trim()) return ok({ pending: true });

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !isValidEmail(email)) return jsonError(400, "valid email required");

  if (rateLimited(clientIp(request))) {
    return jsonError(429, "too many signups from this address — try again later");
  }

  const audienceId = (config as { audienceId?: string | null }).audienceId;
  if (!audienceId) return jsonError(500, "newsletter audience not configured");

  const apiKey = serverEnv("RESEND_API_KEY");
  if (!apiKey) return jsonError(500, "RESEND_API_KEY not set");

  const [first, ...rest] = (body.name ?? "").trim().split(/\s+/).filter(Boolean);

  // Land as unsubscribed: present in the audience, excluded from every
  // broadcast until the confirmation link is clicked.
  const res = await fetch(`${RESEND_BASE}/audiences/${audienceId}/contacts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      first_name: first || undefined,
      last_name: rest.join(" ") || undefined,
      unsubscribed: true,
    }),
  });

  const text = await res.text();
  let detail: unknown = null;
  try { detail = JSON.parse(text); } catch { detail = text; }

  const message = typeof detail === "object" && detail && "message" in detail
    ? String((detail as { message: unknown }).message)
    : String(text);

  // "Already exists" covers both a pending signup and a live subscriber. Re-send
  // the confirmation either way rather than leaking which one this address is.
  if (!res.ok && !/already exists/i.test(message)) {
    return jsonError(res.status || 500, message || "subscribe failed");
  }

  // Always the canonical origin, never `request.url` — a preview deployment
  // would otherwise email confirmation links pointing at a host that stops
  // resolving as soon as the preview is superseded.
  const baseUrl = import.meta.env.SITE || "https://southbaytoday.org";
  const confirmUrl = new URL(
    `/api/newsletter/confirm?token=${encodeURIComponent(createConfirmToken(email))}`,
    baseUrl,
  ).toString();
  const { subject, html, text: plain } = confirmationEmail(confirmUrl);

  const sent = await fetch(`${RESEND_BASE}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: email, subject, html, text: plain }),
  });

  if (!sent.ok) {
    return jsonError(502, "could not send the confirmation email — try again in a minute");
  }

  return ok({ pending: true });
};
