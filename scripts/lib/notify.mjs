// Direct Discord cat-signal alerts from generator scripts.
//
// Use case: a script gets a hard error mid-run (API out of credits, hard 401, etc.)
// but recovers via cache/fallback so the run "succeeds" overall. The downstream
// Stop hook never sees a failure and Stephen doesn't get DM'd. This helper
// pings #tasks directly so the failure isn't silent.
//
// Per-key cooldown via /tmp so a noisy run only fires one DM. Best-effort —
// never throws, never blocks the caller.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileAtomic } from "./io.mjs";

const COOLDOWN_MIN = 60;

function cooldownFile(key) {
  const safe = key.replace(/[^a-z0-9-]/gi, "_");
  return join(tmpdir(), `sbt-notify-${safe}.ts`);
}

function inCooldown(key) {
  try {
    const f = cooldownFile(key);
    if (!existsSync(f)) return false;
    const last = parseInt(readFileSync(f, "utf8"), 10) || 0;
    return (Date.now() - last) / 60000 < COOLDOWN_MIN;
  } catch {
    return false;
  }
}

function stampCooldown(key) {
  try { writeFileAtomic(cooldownFile(key), String(Date.now())); } catch {}
}

/** Ping target for alert embeds. Unset means the embed posts without a ping. */
function mention() {
  const id = String(process.env.DISCORD_ALERT_USER_ID || "").trim();
  return /^\d{5,}$/.test(id) ? `<@${id}>` : "";
}

/**
 * Fire a red Discord DM. Returns immediately if cooldown active or no webhook.
 *
 * @param {object} opts
 * @param {string} opts.key   - Cooldown key (e.g. "recraft-credits"). One DM per key per hour.
 * @param {string} opts.title - Short bold title.
 * @param {string} opts.body  - Plain body. Markdown OK.
 */
export async function catSignal({ key, title, body }) {
  const webhook = process.env.DISCORD_WEBHOOK;
  if (!webhook) return;
  if (inCooldown(key)) return;
  stampCooldown(key);

  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // A literal "<@me>" is not valid Discord mention syntax — it renders as
        // plain text and pings nobody, which is how five days of blocked event
        // refreshes went unnoticed in Aug 2026. Real mentions need a numeric id.
        content: mention(),
        embeds: [{
          title: `🚨 ${title}`,
          description: body.slice(0, 1800),
          color: 0xe53935,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch {
    // never throw from a notify path
  }
}

/**
 * Convenience: "<api> API is out of credits / quota / etc." with a sensible default body.
 */
export async function notifyApiOut(api, detail = "") {
  await catSignal({
    key: `${api.toLowerCase()}-credits`,
    title: `${api} API out of credits`,
    body:
      `${api} just rejected a request with an out-of-credits / quota error.\n` +
      `Scripts that depend on it may be running in degraded mode.\n\n` +
      (detail ? `\`\`\`\n${detail.slice(0, 600)}\n\`\`\`` : ""),
  });
}
