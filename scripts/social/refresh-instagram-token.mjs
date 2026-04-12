#!/usr/bin/env node
// ---------------------------------------------------------------------------
// South Bay Today — Instagram Token Refresher
// Refreshes the long-lived Instagram access token before it expires (60 days).
// Run weekly via launchd on the Mac Mini.
// Usage: node scripts/social/refresh-instagram-token.mjs [--dry-run]
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", "..", ".env.local");
const dryRun = process.argv.includes("--dry-run");

function loadEnv() {
  const text = readFileSync(ENV_PATH, "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function updateEnvValue(key, newValue) {
  const text = readFileSync(ENV_PATH, "utf8");
  const re = new RegExp(`^(${key})=.*$`, "m");
  if (!re.test(text)) {
    throw new Error(`${key} not found in .env.local`);
  }
  const updated = text.replace(re, `$1=${newValue}`);
  writeFileSync(ENV_PATH, updated, "utf8");
}

async function main() {
  const env = loadEnv();
  const currentToken = env.INSTAGRAM_ACCESS_TOKEN;
  if (!currentToken) {
    console.error("ERROR: INSTAGRAM_ACCESS_TOKEN not found in .env.local");
    process.exit(1);
  }

  console.log(`[ig-refresh] current token: ...${currentToken.slice(-8)}`);

  if (dryRun) {
    console.log("[ig-refresh] dry run — skipping API call");
    return;
  }

  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", currentToken);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`ERROR: refresh failed (${res.status}): ${body}`);
    process.exit(1);
  }

  const data = await res.json();
  const newToken = data.access_token;
  const expiresIn = data.expires_in;

  if (!newToken) {
    console.error("ERROR: no access_token in response", data);
    process.exit(1);
  }

  updateEnvValue("INSTAGRAM_ACCESS_TOKEN", newToken);

  const expiryDate = new Date(Date.now() + expiresIn * 1000);
  console.log(`[ig-refresh] token refreshed successfully`);
  console.log(`[ig-refresh] new token: ...${newToken.slice(-8)}`);
  console.log(`[ig-refresh] expires in ${Math.round(expiresIn / 86400)} days (${expiryDate.toISOString()})`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
