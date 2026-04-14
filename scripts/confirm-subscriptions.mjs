/**
 * Fetches received emails from Resend, finds confirmation emails,
 * extracts the confirmation link, and GETs it.
 *
 * Usage: node scripts/confirm-subscriptions.mjs
 *
 * Processed email IDs are cached in /tmp/sbt-confirmed-emails.json
 * so re-running is safe and won't double-click.
 *
 * When you subscribe a batch of city mailing lists to the inbound address,
 * run this script to auto-click the CivicPlus / NotifyMe / custom confirmation
 * emails. It won't unsubscribe, and it skips welcome/ack emails.
 */
import fs from "fs";

const env = fs.readFileSync("/Users/stephenstanwood/Projects/southbaytoday.org/.env.local", "utf8");
env.split("\n").forEach(l => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
});

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.error("RESEND_API_KEY not set in .env.local");
  process.exit(1);
}
const CACHE_FILE = "/tmp/sbt-confirmed-emails.json";

const seen = new Set(
  fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : []
);

const listRes = await fetch("https://api.resend.com/emails/receiving?limit=50", {
  headers: { Authorization: `Bearer ${apiKey}` },
});
const list = await listRes.json();
const emails = list.data || [];

// Keywords that identify confirmation / opt-in emails that still need a click.
// Explicitly excludes "You have been subscribed" welcome emails (acknowledgments).
const CONFIRM_SUBJECTS = /confirm|verify|opt.?in|activate|validate|needed/i;
const ACK_SUBJECTS = /you have been subscribed|successfully subscribed|welcome to/i;

let processed = 0, skipped = 0, failed = 0;

for (const e of emails) {
  if (seen.has(e.id)) { skipped++; continue; }
  if (ACK_SUBJECTS.test(e.subject || "")) { seen.add(e.id); skipped++; continue; }
  if (!CONFIRM_SUBJECTS.test(e.subject || "")) { skipped++; continue; }

  const res = await fetch(`https://api.resend.com/emails/receiving/${e.id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    console.log(`  ✗ fetch failed ${e.id}: ${res.status}`);
    failed++;
    continue;
  }
  const full = await res.json();
  // Prefer URLs from HTML href attributes (properly terminated),
  // then fall back to text regex for plain-text emails.
  const hrefMatches = [...(full.html || "").matchAll(/href=["'](https?:\/\/[^"'<>\s]+)["']/gi)].map(m => m[1]);
  const textMatches = ((full.text || "").match(/https?:\/\/[^\s"'<>]+/g) || []);
  const urls = [...new Set([...hrefMatches, ...textMatches])];
  const scoreUrl = (u) => {
    let s = 0;
    if (/confirm/i.test(u)) s += 10;
    if (/verify|validate|activate/i.test(u)) s += 8;
    if (/subscri/i.test(u)) s += 6;
    if (/optin|opt-in/i.test(u)) s += 6;
    if (/unsubscri/i.test(u)) s -= 20; // avoid unsubscribing!
    if (/\.(png|jpg|gif|css|js|woff)(\?|$)/i.test(u)) s -= 20;
    if (/w3\.org|schema\.org/i.test(u)) s -= 20;
    return s;
  };
  const ranked = urls
    .map(u => ({ u, s: scoreUrl(u) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (ranked.length === 0) {
    console.log(`  ? no confirm link found in: ${e.subject}`);
    failed++;
    continue;
  }

  const target = ranked[0].u.replace(/&amp;/g, "&");
  console.log(`\nFROM:    ${e.from}`);
  console.log(`SUBJECT: ${e.subject}`);
  console.log(`CLICK:   ${target.slice(0, 120)}${target.length > 120 ? "..." : ""}`);

  try {
    const clickRes = await fetch(target, { redirect: "follow" });
    console.log(`RESULT:  HTTP ${clickRes.status} ${clickRes.statusText}`);
    if (clickRes.ok || (clickRes.status >= 300 && clickRes.status < 400)) {
      seen.add(e.id);
      processed++;
    } else {
      failed++;
    }
  } catch (err) {
    console.log(`  ✗ click failed: ${err.message}`);
    failed++;
  }
}

fs.writeFileSync(CACHE_FILE, JSON.stringify([...seen]));

console.log(`\n─────────────────────────────────────────`);
console.log(`processed: ${processed}  |  skipped: ${skipped}  |  failed: ${failed}`);
console.log(`total received emails in resend: ${emails.length}`);
