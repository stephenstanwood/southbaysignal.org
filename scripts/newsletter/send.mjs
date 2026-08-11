#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Send today's newsletter.
//
// Default (through scheduled-send.mjs): creates a Resend Broadcast for the
// configured audience and sends it. Direct real-broadcast invocation is blocked
// because it would bypass the checkout preflight.
// --test <email>: skips broadcasts, sends a one-shot to that address (for QA).
// --dry-run: builds the HTML but doesn't call Resend.
//
// Usage:
//   node scripts/newsletter/send.mjs --test stephen@stanwood.dev
//   node scripts/newsletter/scheduled-send.mjs                        # broadcast
//   node scripts/newsletter/send.mjs --date 2026-05-06 --dry-run
// ---------------------------------------------------------------------------

import {
  assembleNewsletterData, finalizeNewsletterImages, renderEmail, resendFetch,
  publishNewsletterArchive, recordNewsletterSend, sendNewsletterDiscordDm,
  todayPT, loadConfig, FROM_ADDRESS, REPLY_TO,
  loadNewsletterDataDefects, formatDataDefectEscalation,
} from "./lib.mjs";
import { generateNewsletterHero } from "./generate-hero.mjs";
import { assertVerifiedCheckoutToken } from "./scheduled-preflight.mjs";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
}
function bool(name) { return args.includes(`--${name}`); }

const date = flag("date") || todayPT();
const testTo = flag("test");
const dryRun = bool("dry-run");
const editorial = !bool("no-editorial");

async function main() {
  if (!testTo && !dryRun) {
    assertVerifiedCheckoutToken({
      expectedHead: process.env.SBT_NEWSLETTER_PREFLIGHT_HEAD,
      log: console.log,
    });
  }

  const cfg = loadConfig();
  if (!cfg.audienceId) {
    console.error("no audienceId in newsletter-config.json — run setup-audience.mjs first");
    process.exit(1);
  }

  // Don't burn generation (Recraft hero + LLM editorial) on a real run when the
  // audience has no subscribers. QA paths (--test/--dry-run) still build below.
  if (!testTo && !dryRun) {
    const contactsResp = await resendFetch(`/audiences/${cfg.audienceId}/contacts`, { method: "GET" }).catch(() => null);
    const contactCount = Array.isArray(contactsResp?.data) ? contactsResp.data.filter((c) => !c.unsubscribed).length : 0;
    if (contactCount === 0) {
      console.log("newsletter: audience has 0 contacts — skipping generation entirely (no hero, no editorial, no send). Add subscribers to enable.");
      return;
    }
  }

  // Real broadcasts regenerate the designed day-plan hero poster first; skip for
  // QA (--test/--dry-run) to avoid burning Recraft credits. A failure falls back
  // to the first card's photo, so it never blocks the send.
  if (!testTo && !dryRun) {
    try {
      await generateNewsletterHero(date);
    } catch (err) {
      console.warn(`⚠️  newsletter hero gen failed: ${err.message} — using card-image fallback`);
    }
  }

  const data = await assembleNewsletterData(date, { editorial });
  await finalizeNewsletterImages(data);
  const { subject, html } = renderEmail(data);

  console.log(`subject: ${subject}`);
  console.log(`events: ${data.todayEvents.length}, featured: ${data.featuredEvents.length}, openings: ${data.recentOpenings.length}, history: ${data.todayHistory.length}, meetings: ${data.civicMeetings.length}, conversation: ${data.redditPosts.length}`);
  console.log(`editorial: ${data.editorialMeta?.status || "unknown"}`);

  if (!data.dayPlan && !data.todayEvents.length) {
    console.error("⚠️  No day-plan AND no events for today — refusing to send empty newsletter.");
    process.exit(1);
  }

  if (dryRun) {
    console.log("dry-run: skipping send");
    return;
  }

  if (testTo) {
    const res = await resendFetch("/emails", {
      method: "POST",
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: testTo,
        reply_to: REPLY_TO,
        subject,
        html,
      }),
    });
    console.log(`sent test → ${testTo}: ${res.id}`);
    return;
  }

  const broadcast = await resendFetch("/broadcasts", {
    method: "POST",
    body: JSON.stringify({
      audience_id: cfg.audienceId,
      from: FROM_ADDRESS,
      reply_to: REPLY_TO,
      subject,
      html,
      name: `daily-${date}`,
    }),
  });
  console.log(`broadcast created: ${broadcast.id}`);

  const sendRes = await resendFetch(`/broadcasts/${broadcast.id}/send`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  console.log(`broadcast sent: ${JSON.stringify(sendRes)}`);

  // Daily Discord DM is OFF by default (Stephen turned it off 2026-06-18).
  // The email broadcast + public archive still run; the cat-signal DM only
  // fires when NEWSLETTER_DISCORD_DM=1 is explicitly set. Do not re-enable
  // unconditionally.
  const dmEnabled = process.env.NEWSLETTER_DISCORD_DM === "1";
  let dmError = null;
  let archiveUrl = null;
  try {
    archiveUrl = await publishNewsletterArchive(data, html);
    console.log(`newsletter archive: ${archiveUrl}`);
    if (dmEnabled) {
      await sendNewsletterDiscordDm(data, subject, archiveUrl);
      console.log("discord DM sent");
    } else {
      console.log("discord DM skipped (NEWSLETTER_DISCORD_DM not set)");
    }
  } catch (err) {
    dmError = err;
    console.error(`discord DM failed: ${err.message}`);
  }

  await recordNewsletterSend({ data, subject, broadcastId: broadcast.id, archiveUrl });
  console.log("newsletter send recorded");

  // The editorial pass just filed any SOURCE-DATA defects it found (duplicate
  // events, bare form links, missing prices). Print them so the 2pm digest
  // sweep relays them into triage — otherwise they sit unread in a gitignored
  // file and ship again tomorrow, which is exactly what happened through
  // 2026-08-04. Reporting only; never fails the send.
  try {
    const escalation = formatDataDefectEscalation(loadNewsletterDataDefects(), { today: data.date });
    if (escalation) console.log(`\n${escalation}`);
  } catch (err) {
    console.warn(`data-defect report failed: ${err.message}`);
  }

  if (dmError) throw dmError;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
