#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Classify the newsletter audience and suppress bot signups.
//
// Before double opt-in landed (2026-08-05) the public form wrote straight into
// the live audience, and between 2026-07-21 and 2026-08-01 roughly thirty bot
// signups arrived and started receiving the daily broadcast. Suppressing them
// protects the sender reputation the real subscribers depend on.
//
// Suppress, never delete: an unsubscribed contact receives nothing, the record
// of what happened survives, and a misclassified human can be restored with a
// single PATCH (or can simply sign up again through the confirmed flow).
//
// Usage:
//   node scripts/newsletter/audit-audience.mjs              # report only
//   node scripts/newsletter/audit-audience.mjs --suppress   # act on the report
// ---------------------------------------------------------------------------

import { resendFetch, loadConfig } from "./lib.mjs";

const SUPPRESS = process.argv.includes("--suppress");

// Role inboxes. Nobody subscribes a payroll queue to a neighbourhood daily.
const ROLE_LOCALPARTS = /^(payroll|accountspayable|accounts|accounting|billing|contacto|info|admin|sales|noreply|no-reply|support|webmaster|office)$/i;

// Consumer mailbox providers — anything else is a workplace domain.
const FREE_PROVIDERS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
  "me.com", "mac.com", "comcast.net", "sbcglobal.net", "cox.net", "att.net",
  "verizon.net", "pacbell.net", "earthlink.net", "msn.com", "live.com", "proton.me",
  "protonmail.com", "fastmail.com", "hey.com", "duck.com", "ymail.com",
]);

// Regional consumer ISPs hand out per-market subdomains (Road Runner's
// triad.rr.com, nc.rr.com, …). Those are readers on home broadband, not staff
// at a company, so they must not fall through to the workplace-domain rule.
const CONSUMER_ISP_SUFFIXES = [".rr.com", ".charter.com", ".bresnan.net", ".windstream.net"];

function isConsumerMailbox(domain) {
  return FREE_PROVIDERS.has(domain) || CONSUMER_ISP_SUFFIXES.some((suffix) => domain.endsWith(suffix));
}

// The window in which the automated signups arrived.
const BURST_START = "2026-07-21";
const BURST_END = "2026-08-02";

function classify(contact) {
  const email = String(contact.email || "").toLowerCase();
  const [local = "", domain = ""] = email.split("@");
  const signedUp = String(contact.created_at || "").slice(0, 10);
  const inBurst = signedUp >= BURST_START && signedUp < BURST_END;

  // Gmail ignores dots, so `w.il.l.te.d.r.ick@` and `willtedrick@` are the same
  // inbox. Dots sprinkled mid-syllable are the signature of a bot enumerating
  // variants of one address, not a person's own spelling of their name.
  if (domain === "gmail.com" && (local.match(/\./g) || []).length >= 3) {
    return { verdict: "bot", reason: "gmail dot-variant" };
  }
  if (ROLE_LOCALPARTS.test(local)) {
    return { verdict: "bot", reason: "role inbox" };
  }
  if (inBurst && domain && !isConsumerMailbox(domain) && !contact.first_name && !contact.last_name) {
    return { verdict: "bot", reason: "unnamed workplace domain, signed up in the burst" };
  }
  return { verdict: "keep", reason: "" };
}

const cfg = loadConfig();
if (!cfg.audienceId) {
  console.error("no audienceId in newsletter-config.json");
  process.exit(1);
}

const listed = await resendFetch(`/audiences/${cfg.audienceId}/contacts`, { method: "GET" });
const contacts = Array.isArray(listed?.data) ? listed.data : [];
if (listed?.has_more) {
  console.warn("⚠️  audience listing reports more pages — this script only sees the first.");
}

const bots = [];
const keep = [];
for (const contact of contacts) {
  const { verdict, reason } = classify(contact);
  (verdict === "bot" ? bots : keep).push({ ...contact, reason });
}

const activeBots = bots.filter((c) => !c.unsubscribed);

console.log(`audience: ${contacts.length} contacts (${contacts.filter((c) => !c.unsubscribed).length} receiving mail)`);
console.log(`flagged as automated: ${bots.length} (${activeBots.length} still receiving mail)`);
for (const contact of bots) console.log(`   ✗ ${contact.email.padEnd(40)} ${contact.reason}`);
console.log(`retained: ${keep.length}`);
for (const contact of keep) console.log(`   ✓ ${contact.email}`);

if (!SUPPRESS) {
  console.log(`\nreport only — re-run with --suppress to unsubscribe the ${activeBots.length} flagged contact(s)`);
  process.exit(0);
}

let suppressed = 0;
for (const contact of activeBots) {
  try {
    await resendFetch(`/audiences/${cfg.audienceId}/contacts/${encodeURIComponent(contact.email)}`, {
      method: "PATCH",
      body: JSON.stringify({ unsubscribed: true }),
    });
    suppressed += 1;
  } catch (err) {
    console.error(`   ! ${contact.email}: ${err.message}`);
  }
}
console.log(`\nsuppressed ${suppressed}/${activeBots.length}`);
