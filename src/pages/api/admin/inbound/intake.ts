/**
 * Inbound-email intake webhook.
 *
 * Wired to Resend inbound on `in.southbaytoday.org` (catch-all subdomain;
 * use any local part — e.g. events@in..., tips@in...). Resend POSTs
 * `email.received` events here, signed with Svix headers. The payload is
 * METADATA ONLY — we fetch the full body via GET /emails/receiving/{id}.
 *
 * Current use: extract community events from city newsletters. Future uses
 * (tips, press releases, etc.) can branch off the same endpoint.
 *
 * IMPORTANT GOTCHAS (see LOOKOUT_INBOUND_HANDOFF.md):
 *   - Resend webhooks do NOT follow redirects. Point the webhook at
 *     https://www.southbaytoday.org/api/admin/inbound/intake (canonical host).
 *   - The default Resend API key is send-only. Create a Full access key.
 *   - Do not enable receiving on the apex domain — use a subdomain.
 *
 * Env vars required:
 *   RESEND_API_KEY            full-access key
 *   RESEND_WEBHOOK_SECRET     Svix signing secret for this webhook
 *   ANTHROPIC_API_KEY         for the event extractor
 *   BLOB_READ_WRITE_TOKEN     Vercel Blob for storage
 */

import type { APIRoute } from "astro";
import { Webhook } from "svix";
import { extractEvents, normalizeCityKey } from "../../../../lib/lookout/extractor.ts";
import {
  writeInboundEventsForEmail,
  readIntakeLog,
  writeIntakeLog,
  generateInboundEventId,
  dedupHashFor,
  contentHashFor,
} from "../../../../lib/lookout/storage.ts";
import { looksLikeConfirmation, looksLikeAck } from "../../../../lib/lookout/confirm.ts";
import { noteInboundFromSender } from "../../../../lib/lookout/tracker.ts";
import { classifyCivic, forwardToStoa } from "../../../../lib/lookout/civic-classifier.ts";
import { resolveRealSender } from "../../../../lib/lookout/resend-from.ts";
import type { InboundEmail, InboundEvent, InboundIntakeLog } from "../../../../lib/lookout/types.ts";

/** Internal shape — InboundEmail plus raw html for confirmation link parsing. */
interface FetchedEmail extends InboundEmail {
  html: string;
}

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? "";
  if (!secret) return jsonError(500, "RESEND_WEBHOOK_SECRET not set");

  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!anthropicKey) return jsonError(500, "ANTHROPIC_API_KEY not set");

  const resendKey = process.env.RESEND_API_KEY ?? "";
  if (!resendKey) return jsonError(500, "RESEND_API_KEY not set");

  // 1. Verify Svix signature
  const svixId = request.headers.get("svix-id") ?? "";
  const svixTs = request.headers.get("svix-timestamp") ?? "";
  const svixSig = request.headers.get("svix-signature") ?? "";
  if (!svixId || !svixTs || !svixSig) return jsonError(400, "missing svix headers");

  const rawBody = await request.text();
  let payload: unknown;
  try {
    const wh = new Webhook(secret);
    payload = wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTs,
      "svix-signature": svixSig,
    });
  } catch (err) {
    console.error("[intake] signature verification failed:", (err as Error).message);
    return jsonError(401, "invalid signature");
  }

  // 2. Parse metadata from webhook payload
  const meta = extractWebhookMeta(payload);
  if (!meta) {
    console.error("[intake] could not parse payload");
    return jsonError(400, "unrecognized payload shape");
  }

  // 3. Dedup check — Svix can redeliver
  const hash = dedupHashFor(meta.from, meta.subject, meta.messageId || meta.emailId);
  const log = await readIntakeLog();
  if (log.some((l) => l.dedupHash === hash)) {
    console.log(`[intake] duplicate — ${meta.from} "${meta.subject.slice(0, 60)}"`);
    return Response.json({ ok: true, outcome: "duplicate" });
  }

  // 4. Fetch full email body
  let email: FetchedEmail;
  try {
    email = await fetchReceivedEmail(meta.emailId, resendKey, meta);
  } catch (err) {
    console.error("[intake] fetch received email failed:", (err as Error).message);
    return jsonError(502, "failed to fetch email body");
  }

  // 4.1. Content-based dedup — same email forwarded from a different address
  //      (e.g. Stephen forwards a chamber newsletter that already hit our
  //      inbox directly) hashes the same and short-circuits.
  const contentHash = contentHashFor(email.subject, email.body);
  if (log.some((l) => l.contentHash === contentHash)) {
    console.log(
      `[intake] content-duplicate — ${email.from} "${email.subject.slice(0, 60)}"`
    );
    await appendLog(log, {
      dedupHash: hash,
      contentHash,
      receivedAt: email.receivedAt,
      from: email.from,
      subject: email.subject,
      outcome: "duplicate",
      eventCount: 0,
    });
    return Response.json({ ok: true, outcome: "content-duplicate" });
  }

  // 4.5. Confirmation handling — short-circuit confirmation + ack emails
  //      before the extractor eats the LLM budget.
  //      NOTE: auto-click is DISABLED — Stephen clicks confirm links manually
  //      to avoid bot-flagging the sandcathype@gmail.com address. We still
  //      detect confirmation subjects and skip the extractor, but we don't
  //      follow the link.
  //      IMPORTANT: this block runs BEFORE the generic tracker update so
  //      confirmation/ack emails don't get counted toward receivedCount.
  if (looksLikeAck(email.subject)) {
    console.log(`[intake] ack-ignored — ${email.from} "${email.subject.slice(0, 60)}"`);
    await appendLog(log, {
      dedupHash: hash,
      contentHash,
      receivedAt: email.receivedAt,
      from: email.from,
      subject: email.subject,
      outcome: "ack-ignored",
      eventCount: 0,
    });
    return Response.json({ ok: true, outcome: "ack-ignored" });
  }

  if (looksLikeConfirmation(email.subject)) {
    console.log(
      `[intake] confirmation-pending (manual) — ${email.from} "${email.subject.slice(0, 60)}"`
    );
    await appendLog(log, {
      dedupHash: hash,
      contentHash,
      receivedAt: email.receivedAt,
      from: email.from,
      subject: email.subject,
      outcome: "confirmation-pending",
      eventCount: 0,
    });
    return Response.json({ ok: true, outcome: "confirmation-pending" });
  }

  // 4.7. Real-newsletter path: bump tracker receivedCount / lastReceivedAt and
  //      promote signup-posted/confirmed → receiving. This runs AFTER the
  //      confirmation short-circuits so opt-in emails don't skew counts.
  try {
    await noteInboundFromSender(email.from, email.receivedAt);
  } catch (err) {
    console.error("[intake] tracker update failed:", (err as Error).message);
  }

  // 4.8. Civic classification + optional forward to Stoa.
  //      Many city newsletter lists (CivicPlus NotifyMe, Granicus, etc.)
  //      double as governance feeds — council agendas, planning commission
  //      updates, public hearing notices, RFPs. Those belong in Stoa's
  //      pipeline too. Forward is fire-and-forget; never blocks the
  //      primary webhook response or prevents event extraction below.
  const civic = classifyCivic(email.from, email.subject);
  if (civic.isCivic) {
    console.log(`[intake] civic→stoa — ${email.from} "${email.subject.slice(0, 60)}" (${civic.reason})`);
    // Intentionally not awaited — fire-and-forget.
    void forwardToStoa({
      from: email.from,
      to: email.to,
      subject: email.subject,
      body: email.body,
      html: email.html,
      receivedAt: email.receivedAt,
      messageId: email.messageId,
      classification: civic.reason,
    });
  }

  // 5. Run the extractor
  let extracted;
  try {
    extracted = await extractEvents(email, { anthropicKey });
  } catch (err) {
    console.error("[intake] extractor failed:", (err as Error).message);
    await appendLog(log, {
      dedupHash: hash,
      contentHash,
      receivedAt: email.receivedAt,
      from: email.from,
      subject: email.subject,
      outcome: "extractor-error",
      eventCount: 0,
      error: (err as Error).message,
    });
    // Still 2xx so Resend doesn't retry — error is logged
    return Response.json({ ok: true, outcome: "extractor-error" });
  }

  // 6. Dedup against today vs past
  const todayIso = new Date().toISOString().slice(0, 10);
  const futureEvents = extracted.filter((e) => e.startsAt.slice(0, 10) >= todayIso);

  if (futureEvents.length === 0) {
    console.log(`[intake] no-events — ${email.from} "${email.subject.slice(0, 60)}"`);
    await appendLog(log, {
      dedupHash: hash,
      contentHash,
      receivedAt: email.receivedAt,
      from: email.from,
      subject: email.subject,
      outcome: "no-events",
      eventCount: 0,
    });
    return Response.json({ ok: true, outcome: "no-events" });
  }

  // 7. Persist extracted events — sharded per email (race-free: each
  //    webhook writes its own blob key, no read-modify-write on a shared blob).
  const fresh: InboundEvent[] = futureEvents.map((e) => ({
    id: generateInboundEventId(),
    receivedAt: email.receivedAt,
    fromEmail: email.from,
    emailSubject: email.subject,
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    location: e.location,
    description: e.description,
    sourceUrl: e.sourceUrl,
    cityKey: normalizeCityKey(e.cityName),
    cityName: e.cityName,
    status: "new",
  }));
  await writeInboundEventsForEmail(hash, fresh);

  await appendLog(log, {
    dedupHash: hash,
    contentHash,
    receivedAt: email.receivedAt,
    from: email.from,
    subject: email.subject,
    outcome: "events-extracted",
    eventCount: fresh.length,
  });

  console.log(
    `[intake] events-extracted — ${fresh.length} from ${email.from} "${email.subject.slice(0, 60)}"`
  );

  return Response.json({ ok: true, outcome: "events-extracted", count: fresh.length });
};

async function appendLog(existing: InboundIntakeLog[], entry: InboundIntakeLog): Promise<void> {
  // Keep the last 500 log entries
  const next = [...existing, entry].slice(-500);
  await writeIntakeLog(next);
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface WebhookMeta {
  emailId: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  messageId: string;
}

function extractWebhookMeta(payload: unknown): WebhookMeta | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== "email.received") return null;

  const data = p.data as Record<string, unknown> | undefined;
  if (!data) return null;

  const emailId = stringFrom(data.email_id) || stringFrom(data.id);
  if (!emailId) return null;

  return {
    emailId,
    from: stringFrom(data.from),
    to: stringFrom(data.to) || stringFrom(data.recipient),
    subject: stringFrom(data.subject),
    receivedAt: stringFrom(data.created_at) || new Date().toISOString(),
    messageId: stringFrom(data.message_id),
  };
}

async function fetchReceivedEmail(
  emailId: string,
  apiKey: string,
  fallback: WebhookMeta
): Promise<FetchedEmail> {
  // NOTE: endpoint is /emails/receiving/{id} — NOT /received-emails/{id}.
  // Getting this wrong returns confusing 405s. See handoff doc gotcha #2.
  const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  const text = stringFrom(data.text);
  const html = stringFrom(data.html);
  const body = text || stripHtml(html);

  const listedFrom = stringFrom(data.from) || fallback.from;
  const from = resolveRealSender(listedFrom, data.headers, data.reply_to);

  return {
    from,
    to: stringFrom(data.to) || fallback.to,
    subject: stringFrom(data.subject) || fallback.subject,
    body,
    html,
    receivedAt: stringFrom(data.created_at) || fallback.receivedAt,
    messageId: stringFrom(data.message_id) || fallback.messageId,
  };
}

function stringFrom(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0) return String(v[0]);
  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
