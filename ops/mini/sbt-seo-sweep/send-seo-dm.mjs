#!/usr/bin/env node
// send-seo-dm.mjs — guarded Discord DM for the weekly SBT SEO sweep
// routine. Mirrors stoa-tech-frontier/send-frontier-dm.mjs: loads the bot token
// from ~/.claude/channels/discord/.env, refuses any message not starting with an
// allowed prefix, and POSTs to Stephen's DM channel. Usage:
//   node send-seo-dm.mjs [--dry-run] "🔍 SBT SEO sweep (...) ..."
import fs from "node:fs";
import os from "node:os";

const allowedPrefixes = [
  "🔍 SBT SEO sweep",
  "⚠️ sbt-seo-sweep:",
];

function loadEnv(path) {
  const env = {};
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch {
    return env;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input.trim();
}

const dryRun = process.argv.includes("--dry-run");
const args = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
const content = (args.join(" ") || (await readStdin())).trim();

if (!content) {
  console.error("Usage: send-seo-dm.mjs [--dry-run] <message>");
  process.exit(64);
}

if (!allowedPrefixes.some((prefix) => content.startsWith(prefix))) {
  console.error("Refusing sbt-seo-sweep Discord message: not an allowed alert type.");
  process.exit(78);
}

if (dryRun) {
  console.log("dry-run: allowed sbt-seo-sweep alert\n---\n" + content);
  process.exit(0);
}

const envPath = `${os.homedir()}/.claude/channels/discord/.env`;
const env = { ...loadEnv(envPath), ...process.env };
const token = env.DISCORD_BOT_TOKEN;
const channel = env.DISCORD_DM_CHANNEL || "1486102002474811524";

if (!token) {
  console.error("DISCORD_BOT_TOKEN is missing");
  process.exit(69);
}

// Discord hard-caps a message at 2000 chars; truncate well under it and point at
// the radar for the rest so a long digest never 400s.
const MAX_LEN = 1900;
let body = content;
if (body.length > MAX_LEN) {
  body = body.slice(0, MAX_LEN - 40).trimEnd() + "\n… (truncated — see the sweep report)";
}

try {
  const response = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: body }),
  });
  if (!response.ok) {
    // Never echo the request (it carries the bot token); status is enough.
    console.error(`Discord POST failed: ${response.status} (check token/channel)`);
    process.exit(75);
  }
  console.log(`discord sent: ${response.status}`);
} catch (err) {
  console.error(`Discord POST error: ${err?.name || "fetch failed"}`);
  process.exit(75);
}
