// ---------------------------------------------------------------------------
// link-health.mjs
//
// Classifies the outcome of fetching a curated outbound link.
//
// A plain status check is not enough for the two failure modes that actually
// bit us. Both were found on 2026-09-09 in data nothing audited:
//
//   campbellfarmersmarket.com  → 200, after redirecting to hugedomains.com.
//     The Campbell farmers' market card had been pointing at a domain-squatter
//     "this domain is for sale" page. Status-only checks call that healthy.
//
//   lgcr.com  → TLS failure. The host serves a Pantheon default certificate
//     that does not cover the name, so a browser shows an interstitial before
//     the page ever loads. Node reports this as a fetch error, indistinguishable
//     from a timeout unless you read err.cause.code.
//
// Both are worse than a 404 for a reader: one looks like the site, the other
// looks like the site is dangerous.
//
// The classifier is pure so it can be tested without network access.
// ---------------------------------------------------------------------------

/** Hosts that serve "this domain is for sale" pages with a 200. */
export const PARKING_HOSTS = [
  "hugedomains.com",
  "afternic.com",
  "dan.com",
  "sedo.com",
  "sedoparking.com",
  "buydomains.com",
  "undeveloped.com",
  "domainmarket.com",
  "squadhelp.com",
  "atom.com",
];

/**
 * Certificate faults a browser refuses to click through — wrong name, expired,
 * self-signed. These block the reader, so they are hard findings.
 */
export const TLS_ERROR_CODES = [
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_SSL_WRONG_VERSION_NUMBER",
];

/**
 * Certificate chains that are merely incomplete: the server omitted an
 * intermediate. Browsers repair this on their own by fetching the issuer named
 * in the AIA extension; Node does not, so it fails where a reader would not.
 * cinequest.org does exactly this and serves the real festival site at 200.
 * Report it — a sloppy chain is worth telling a venue about — but do not call
 * it broken.
 */
export const TLS_CHAIN_WARN_CODES = [
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
];

const PARKED_TITLE = /\b(is for sale|domain (?:is )?for sale|buy this domain|parked (?:free )?courtesy)\b/i;

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True when the response landed on a known domain-parking host, or the page
 * title reads like a for-sale placeholder. Checked against the FINAL url so a
 * redirect off the configured domain is what gets judged.
 */
export function looksParked({ finalUrl = "", title = "" } = {}) {
  const host = hostOf(finalUrl);
  if (host && PARKING_HOSTS.some((p) => host === p || host.endsWith(`.${p}`))) return true;
  return PARKED_TITLE.test(title);
}

/**
 * Classify one checked link.
 *
 *   ok         — reachable and pointing where it should
 *   broken     — 4xx/5xx, DNS failure, or timeout
 *   parked     — resolves to a domain-for-sale page (200, but useless)
 *   tls        — certificate error a browser blocks the page on
 *   suspicious — bot-blocked (403/406/429), or an incomplete cert chain a
 *                browser repairs itself; usually fine for a real reader
 *
 * Only `broken`, `parked`, and `tls` are hard findings.
 */
export function classifyLink({ status, errorCode, finalUrl, title } = {}) {
  if (status == null) {
    if (errorCode && TLS_ERROR_CODES.includes(errorCode)) return "tls";
    if (errorCode && TLS_CHAIN_WARN_CODES.includes(errorCode)) return "suspicious";
    return "broken";
  }
  if (status >= 200 && status < 300) {
    return looksParked({ finalUrl, title }) ? "parked" : "ok";
  }
  if (status === 403 || status === 406 || status === 429) return "suspicious";
  return "broken";
}

export const HARD_BUCKETS = new Set(["broken", "parked", "tls"]);

/**
 * Pull { label, url } pairs out of a curated `*-data.ts` file without importing
 * it. Each object literal contributes at most one link, labelled by its `title`
 * (or `id`) so a finding names the card a reader would click.
 */
export function extractLinks(src, { urlKey = "url" } = {}) {
  const out = [];
  for (const block of src.split(/^\s*\{$/gm)) {
    const url = block.match(new RegExp(`\\b${urlKey}:\\s*"([^"]+)"`));
    if (!url) continue;
    const label =
      block.match(/\btitle:\s*"([^"]+)"/) ||
      block.match(/\bname:\s*"([^"]+)"/) ||
      block.match(/\bid:\s*"([^"]+)"/);
    out.push({ label: label ? label[1] : url[1], url: url[1] });
  }
  return out;
}
