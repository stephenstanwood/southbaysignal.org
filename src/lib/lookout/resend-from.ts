/**
 * Resolve the real sender of an inbound Resend email.
 *
 * Gmail forwarding (sandcathype@gmail.com → events@in.southbaytoday.org) causes
 * Resend's top-level `from` field on GET /emails/receiving/:id to return the
 * envelope recipient (events@in.southbaytoday.org) instead of the original
 * sender. The real `From:` header is preserved verbatim in `detail.headers.from`
 * and sometimes in `detail.reply_to`.
 *
 * Without this resolver every forwarded newsletter is logged as "unmatched
 * inbound sender" and no tracker row flips to receiving.
 */

export const SELF_INFRA_DOMAINS = new Set([
  "in.southbaytoday.org",
  "southbaytoday.org",
  "stanwood.dev",
  "gmail.com",
]);

function domainOf(raw: string): string {
  if (!raw) return "";
  const m = raw.match(/<([^>]+)>/);
  const addr = (m ? m[1] : raw).toLowerCase().trim();
  return addr.split("@")[1] ?? "";
}

/**
 * Return the real sender string (`"Name" <addr@host>` or raw email).
 * Falls back to the listed value only when nothing better is available.
 */
export function resolveRealSender(
  listedFrom: string,
  detailHeaders: unknown,
  detailReplyTo: unknown
): string {
  const listedDomain = domainOf(listedFrom);
  if (listedDomain && !SELF_INFRA_DOMAINS.has(listedDomain)) return listedFrom;

  if (detailHeaders && typeof detailHeaders === "object") {
    const h = detailHeaders as Record<string, unknown>;
    const hdrFrom = typeof h.from === "string" ? h.from : "";
    if (hdrFrom && !SELF_INFRA_DOMAINS.has(domainOf(hdrFrom))) return hdrFrom;
  }

  if (Array.isArray(detailReplyTo) && detailReplyTo[0]) {
    const rt = String(detailReplyTo[0]);
    if (rt && !SELF_INFRA_DOMAINS.has(domainOf(rt))) return rt;
  }

  return listedFrom;
}
