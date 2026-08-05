import type { APIRoute } from "astro";
import config from "../../../data/south-bay/newsletter-config.json";
import { RESEND_BASE, readConfirmToken, serverEnv } from "../../../lib/south-bay/newsletterSignup";

export const prerender = false;

function redirect(status: "confirmed" | "expired" | "error") {
  const baseUrl = import.meta.env.SITE || "https://southbaytoday.org";
  return new Response(null, {
    status: 302,
    headers: { Location: new URL(`/newsletters?subscription=${status}`, baseUrl).toString() },
  });
}

export const GET: APIRoute = async ({ url }) => {
  const email = readConfirmToken(url.searchParams.get("token") || "");
  if (!email) return redirect("expired");

  const audienceId = (config as { audienceId?: string | null }).audienceId;
  const apiKey = serverEnv("RESEND_API_KEY");
  if (!audienceId || !apiKey) return redirect("error");

  // Resend keys contacts by email, so this flips the pending row created at
  // signup rather than adding a second one.
  const res = await fetch(
    `${RESEND_BASE}/audiences/${audienceId}/contacts/${encodeURIComponent(email)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ unsubscribed: false }),
    },
  );

  return redirect(res.ok ? "confirmed" : "error");
};
