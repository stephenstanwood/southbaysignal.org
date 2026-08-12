#!/usr/bin/env node
// Google Search Console API client for the weekly SEO sweep.
//
// Auth is a service account, not OAuth: a service account has no consent screen
// to babysit and no refresh token to expire, so an unattended Mini job can hold
// it forever. Google accepts a service account as a normal Search Console user —
// add its `client_email` under Settings → Users and permissions on the property.
//
// The JWT is signed by hand with node:crypto rather than pulling in
// google-auth-library. It is ~30 lines, it works identically in both repos, and
// it keeps a dependency out of two package.json files for one weekly script.
//
// Every export returns `{ ok: false, reason }` instead of throwing when
// credentials are absent, because a missing key must degrade the sweep to its
// crawl-only legs — never abort the run.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const WEBMASTERS = "https://www.googleapis.com/webmasters/v3";
const INSPECTION = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

// Write scope: the sweep submits sitemaps, so readonly is not enough.
const SCOPES = [
  "https://www.googleapis.com/auth/webmasters",
  "https://www.googleapis.com/auth/webmasters.readonly",
].join(" ");

/**
 * Load the service-account JSON from the environment.
 *
 * Accepts, in order: an inline JSON blob, the same blob base64-encoded (easier
 * to paste into a one-line .env without mangling the PEM newlines), or a path
 * to a key file on disk.
 */
export function loadCredentials(env = process.env) {
  const inline = env.GSC_SERVICE_ACCOUNT_JSON?.trim();
  const file = env.GSC_SERVICE_ACCOUNT_FILE?.trim();

  let raw = null;
  if (inline) {
    // A base64 blob never starts with '{'; an inline JSON blob always does.
    raw = inline.startsWith("{") ? inline : Buffer.from(inline, "base64").toString("utf8");
  } else if (file) {
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      return { ok: false, reason: `GSC_SERVICE_ACCOUNT_FILE unreadable: ${error.message}` };
    }
  }

  if (!raw) {
    return {
      ok: false,
      reason:
        "no Search Console credentials — set GSC_SERVICE_ACCOUNT_JSON (raw or base64) or GSC_SERVICE_ACCOUNT_FILE",
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `service-account JSON did not parse: ${error.message}` };
  }

  if (!parsed.client_email || !parsed.private_key) {
    return { ok: false, reason: "service-account JSON is missing client_email or private_key" };
  }

  return { ok: true, credentials: parsed };
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/** Exchange a self-signed JWT for an access token (RFC 7523 flow). */
async function fetchAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: SCOPES,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  // .env round-trips turn real newlines into the two characters \ and n.
  const signature = signer.sign(credentials.private_key.replace(/\\n/g, "\n"), "base64url");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.error_description ?? body.error ?? `HTTP ${response.status}`;
    throw new Error(`token exchange failed: ${detail}`);
  }
  return body.access_token;
}

/**
 * Build an authenticated client, or explain why we cannot.
 *
 * The token is fetched once and reused for the process lifetime; a sweep never
 * runs long enough to outlive the 1-hour expiry.
 */
export async function createClient(env = process.env) {
  const loaded = loadCredentials(env);
  if (!loaded.ok) return loaded;

  let token;
  try {
    token = await fetchAccessToken(loaded.credentials);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  async function call(url, { method = "GET", body } = {}) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    // Sitemap submission returns 204 with an empty body.
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const detail = parsed.error?.message ?? `HTTP ${response.status}`;
      throw new Error(detail);
    }
    return parsed;
  }

  return {
    ok: true,
    serviceAccount: loaded.credentials.client_email,

    /** Every property this service account can see. */
    async listSites() {
      const { siteEntry = [] } = await call(`${WEBMASTERS}/sites`);
      return siteEntry;
    },

    /**
     * Submitted sitemaps, including Google's own error and warning counts —
     * the cheapest read of "is Search Console unhappy with our sitemap".
     */
    async listSitemaps(siteUrl) {
      const { sitemap = [] } = await call(
        `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
      );
      return sitemap;
    },

    /** Idempotent: re-submitting a known sitemap re-triggers a fetch. */
    async submitSitemap(siteUrl, sitemapUrl) {
      await call(
        `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
        { method: "PUT" },
      );
      return { submitted: sitemapUrl };
    },

    /**
     * Index status for one URL — coverage state, canonical Google picked,
     * crawl result, and any robots/fetch problem.
     *
     * Quota is 2,000 inspections per property per day, so callers sample rather
     * than inspect the whole sitemap.
     */
    async inspectUrl(siteUrl, inspectionUrl) {
      const result = await call(INSPECTION, {
        method: "POST",
        body: { siteUrl, inspectionUrl, languageCode: "en-US" },
      });
      return result.inspectionResult ?? {};
    },

    /**
     * Search Analytics rows. `dimensions` is typically ["query"], ["page"], or
     * both; the caller decides what it is mining for.
     */
    async searchAnalytics(siteUrl, { startDate, endDate, dimensions, rowLimit = 500, type }) {
      const { rows = [] } = await call(
        `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          method: "POST",
          body: {
            startDate,
            endDate,
            dimensions,
            rowLimit,
            ...(type ? { type } : {}),
          },
        },
      );
      return rows;
    },
  };
}

/** YYYY-MM-DD for `daysAgo` days before today, in UTC. */
export function daysAgo(days) {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString().slice(0, 10);
}
