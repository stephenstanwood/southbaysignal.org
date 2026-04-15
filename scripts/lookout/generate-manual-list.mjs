#!/usr/bin/env node
/**
 * Generate a prioritized manual-click list for Stephen.
 * Writes MANUAL_SIGNUP_LIST.md at the repo root, sorted by priority + category.
 *
 * Run: node scripts/lookout/generate-manual-list.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { targets } = JSON.parse(readFileSync(join(__dirname, "targets.json"), "utf8"));

function cityLabel(key) {
  if (!key) return "";
  return key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function googleSearchUrl(name, city) {
  const loc = cityLabel(city) || "south bay";
  const q = `${name} ${loc} newsletter email signup`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

const byPriority = { 1: [], 2: [], 3: [] };
for (const t of targets) {
  const p = t.priority || 3;
  (byPriority[p] ??= []).push(t);
}

const categoryOrder = [
  "city",
  "chamber",
  "library",
  "museum",
  "arts",
  "venue",
  "news",
  "business-district",
  "parks",
  "nature",
  "food",
  "school",
  "transit",
  "other",
];

function sortByCat(a, b) {
  const ai = categoryOrder.indexOf(a.category);
  const bi = categoryOrder.indexOf(b.category);
  if (ai !== bi) return ai - bi;
  return a.name.localeCompare(b.name);
}

const lines = [];
lines.push("# Manual Newsletter Signup List — South Bay Today");
lines.push("");
lines.push(`**${targets.length} targets** to subscribe sandcathype@gmail.com to. Gmail forwards to events@in.southbaytoday.org where the pipeline extracts events.`);
lines.push("");
lines.push("Use `events@in.southbaytoday.org` directly **OR** use `sandcathype@gmail.com` (forwards identically). The Gmail address is preferred because it has higher sender reputation with mailing list platforms.");
lines.push("");
lines.push("**After each signup:** no action needed — the webhook auto-clicks confirmation links and tracks receipt in `/admin/newsletters?key=...`.");
lines.push("");

for (const p of [1, 2, 3]) {
  const group = byPriority[p] || [];
  if (group.length === 0) continue;
  const label = p === 1 ? "🔴 PRIORITY 1 (highest)" : p === 2 ? "🟠 PRIORITY 2 (medium)" : "🟢 PRIORITY 3 (low)";
  lines.push(`## ${label} — ${group.length} targets`);
  lines.push("");

  const byCat = {};
  for (const t of group) (byCat[t.category] ??= []).push(t);

  for (const cat of categoryOrder) {
    const items = byCat[cat];
    if (!items || items.length === 0) continue;
    items.sort((a, b) => a.name.localeCompare(b.name));
    lines.push(`### ${cat} (${items.length})`);
    lines.push("");
    for (const t of items) {
      const notes = t.notes ? ` — _${t.notes}_` : "";
      lines.push(`- [ ] [${t.name}](${googleSearchUrl(t.name, t.city)})${notes}`);
    }
    lines.push("");
  }
}

lines.push("---");
lines.push("");
lines.push("## Tips");
lines.push("");
lines.push("- **CivicPlus cities** (Saratoga, Campbell, Los Altos, Los Gatos, Gilroy, Morgan Hill, Monte Sereno, Milpitas) now require creating a free account before you can subscribe. Create one CivicPlus account per site — painful but one-time.");
lines.push("- **Chambers** mostly use ChamberMaster / GrowthZone — find the 'Newsletter Signup' link in their footer or 'About' page.");
lines.push("- **WAF-blocked big cities** (Palo Alto, Mountain View, Sunnyvale, Santa Clara, Cupertino, San Jose) have bot-protected signup pages. Signing up via a real browser should work fine.");
lines.push("- **Newspapers** (Mercury News, Palo Alto Online) usually have a newsletter signup page with 10+ options — pick the 'events' / 'things to do' / 'daily headlines' list.");
lines.push("- **Skip anything that requires a full account with password** (unless you actually want an account). The tracker's `status: needs-manual` just means I couldn't auto-subscribe — YOU can still decide to pass.");
lines.push("");
lines.push("## What happens after you subscribe");
lines.push("");
lines.push("1. Mailing list sends confirmation email → Gmail → Resend → webhook → **auto-clicked**");
lines.push("2. First real newsletter arrives → Gmail → Resend → webhook → Claude Haiku extracts events → Vercel Blob → Mini pulls nightly → merged into site");
lines.push("3. Tracker at `/admin/newsletters?key=<ADMIN_KEY>` updates to `receiving` automatically");
lines.push("");
lines.push("**Admin key:** `sbt_cdc1df30b8f7c200f5074404d322dab1`");

writeFileSync(join(__dirname, "..", "..", "MANUAL_SIGNUP_LIST.md"), lines.join("\n"));
console.log("wrote MANUAL_SIGNUP_LIST.md");
