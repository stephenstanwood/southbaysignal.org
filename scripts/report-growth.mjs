#!/usr/bin/env node
// Read-only growth report from Vercel Web Analytics.
// Uses complete Pacific-time days so an early-morning scheduled run does not
// compare a partial Friday with a complete prior Friday.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadEnvLocal } from "./lib/env.mjs";

// Lets a long-lived VERCEL_TOKEN in .env.local take over when the Vercel CLI's
// OAuth token lapses — that token expires every few weeks and silently took
// the weekly growth report offline from 2026-07-16 onward.
loadEnvLocal();

const TEAM_ID = process.env.VERCEL_TEAM_ID ?? "team_qOPCwp8ArAsCRpm9sNjGbMc3";
const PROJECT_ID = process.env.VERCEL_PROJECT_ID ?? "prj_yIxdy6XFGBAtePrHMzc0FH7ucYS5";
const API = "https://api.vercel.com/v1/query/web-analytics/visits/aggregate";
const jsonMode = process.argv.includes("--json");
const asOfArg = process.argv.find((arg) => arg.startsWith("--as-of="))?.slice(8);

function dateInPacific(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shiftDate(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function windowEnding(end, days) {
  return { since: shiftDate(end, -(days - 1)), until: end, days };
}

function previousWindow(window) {
  const until = shiftDate(window.since, -1);
  return windowEnding(until, window.days);
}

function readToken() {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  if (process.env.VERCEL_ACCESS_TOKEN) return process.env.VERCEL_ACCESS_TOKEN;

  const authPath = join(homedir(), "Library", "Application Support", "com.vercel.cli", "auth.json");
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    if (auth.token) {
      // The CLI's OAuth token is short-lived. Say so up front rather than
      // letting the API answer with an opaque 403 "invalidToken".
      const expiresAt = Number(auth.expiresAt);
      if (Number.isFinite(expiresAt)) {
        const expiryMs = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
        if (expiryMs < Date.now()) {
          throw new Error(
            `The Vercel CLI token expired on ${new Date(expiryMs).toISOString().slice(0, 10)}. `
            + "Run `vercel login`, or add a long-lived VERCEL_TOKEN to .env.local.",
          );
        }
      }
      return auth.token;
    }
  } catch (err) {
    if (/expired/.test(err?.message ?? "")) throw err;
    // The error below explains both supported authentication paths.
  }
  throw new Error("Vercel authentication is unavailable. Set VERCEL_TOKEN or sign in with the Vercel CLI.");
}

async function query(token, window, by, limit) {
  const params = new URLSearchParams({
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    since: window.since,
    until: window.until,
    by,
  });
  if (limit) params.set("limit", String(limit));

  const response = await fetch(`${API}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Vercel Analytics returned ${response.status}: ${body.slice(0, 300)}`);
  }
  const payload = await response.json();
  return Array.isArray(payload.data) ? payload.data : [];
}

function totals(rows) {
  return rows.reduce(
    (sum, row) => ({
      visitors: sum.visitors + Number(row.visitors ?? 0),
      pageviews: sum.pageviews + Number(row.pageviews ?? 0),
    }),
    { visitors: 0, pageviews: 0 },
  );
}

function percentChange(current, previous) {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function compare(currentRows, previousRows) {
  const current = totals(currentRows);
  const previous = totals(previousRows);
  return {
    ...current,
    previous,
    changePercent: {
      visitors: percentChange(current.visitors, previous.visitors),
      pageviews: percentChange(current.pageviews, previous.pageviews),
    },
  };
}

function cleanTop(rows, field, count = 12) {
  return rows
    .filter((row) => row[field] !== "Others")
    .slice(0, count)
    .map((row) => ({
      [field]: row[field] || "(direct / unknown)",
      visitors: Number(row.visitors ?? 0),
      pageviews: Number(row.pageviews ?? 0),
    }));
}

function formatChange(value) {
  if (value === null) return "new";
  return `${value >= 0 ? "+" : ""}${value}%`;
}

function formatMetric(label, current) {
  return `${label}: ${current.visitors.toLocaleString()} visitors (${formatChange(current.changePercent.visitors)}), ${current.pageviews.toLocaleString()} pageviews (${formatChange(current.changePercent.pageviews)})`;
}

const token = readToken();
const today = asOfArg ?? dateInPacific();
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("--as-of must use YYYY-MM-DD.");
const completeThrough = shiftDate(today, -1);
const last7 = windowEnding(completeThrough, 7);
const prior7 = previousWindow(last7);
const last30 = windowEnding(completeThrough, 30);
const prior30 = previousWindow(last30);

const [days7, daysPrior7, days30, daysPrior30, pageRows, referrerRows, countryRows] = await Promise.all([
  query(token, last7, "day"),
  query(token, prior7, "day"),
  query(token, last30, "day"),
  query(token, prior30, "day"),
  query(token, last30, "requestPath", 100),
  query(token, last30, "referrerHostname", 100),
  query(token, last30, "country", 100),
]);

const referrers = cleanTop(referrerRows, "referrerHostname");
const aiPattern = /(^|\.)(chatgpt\.com|gemini\.google\.com|claude\.ai|perplexity\.ai|copilot\.microsoft\.com)$/i;
const report = {
  generatedAt: new Date().toISOString(),
  completeThrough,
  windows: { last7, prior7, last30, prior30 },
  traffic: {
    last7Days: compare(days7, daysPrior7),
    last30Days: compare(days30, daysPrior30),
  },
  topPages: cleanTop(pageRows, "requestPath"),
  topReferrers: referrers,
  aiReferrers: referrers.filter((row) => aiPattern.test(row.referrerHostname)),
  topCountries: cleanTop(countryRows, "country", 8),
};

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`South Bay Today growth report — complete days through ${completeThrough}`);
  console.log(formatMetric("Last 7 days", report.traffic.last7Days));
  console.log(formatMetric("Last 30 days", report.traffic.last30Days));
  console.log("\nTop pages (30 days)");
  for (const row of report.topPages.slice(0, 8)) console.log(`  ${row.visitors.toLocaleString().padStart(5)}  ${row.requestPath}`);
  console.log("\nTop referrers (30 days)");
  for (const row of report.topReferrers.slice(0, 8)) console.log(`  ${row.visitors.toLocaleString().padStart(5)}  ${row.referrerHostname}`);
  console.log(`\nAI referrals: ${report.aiReferrers.length ? report.aiReferrers.map((row) => `${row.referrerHostname} (${row.visitors})`).join(", ") : "none in the top referrers"}`);
}
