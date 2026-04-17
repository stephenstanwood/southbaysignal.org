/**
 * Classifies an inbound email's civic relevance, so the intake webhook can
 * forward the right things to Stoa (council agendas, planning commission
 * updates, public hearings, RFP/RFQ notices) while keeping event newsletters
 * local to SBT. An email can be BOTH civic and event-bearing — they're not
 * mutually exclusive, so we return a flag rather than a single category.
 *
 * We're generous with false positives on purpose. Stoa has its own classifier
 * downstream that'll drop pure noise. False negatives would lose signal that
 * Stoa needs to surface to Stephen.
 */

/** Sender-domain fragments that strongly suggest civic/governance infrastructure. */
const CIVIC_SENDER_DOMAINS = [
  "civicplus.com",      // NotifyMe city updates
  "civicengagecentral.com",
  "civicengagedev.com",
  "civicclerk.com",
  "granicus.com",
  "granicusideas.com",
  "govdelivery.com",    // public sector email platform
  "opengov.com",        // procurement + civic notifications
  "legistar.com",
  "primegov.com",
  "accessgov.com",
  "novusagenda.com",
  "boardbook.org",
  "iqm2.com",
  "meetsilver.com",
  "agendaease.com",
  "publicpurchase.com",
  "planetbids.com",
  "demandstar.com",
  "bidnet.com",
  "sovra.com",
  "biddingo.com",
  "bonfirehub.com",
  "periscope.io",
  "caleprocure.ca.gov",
  "fiscal.ca.gov",      // CA Dept of Finance — bid/contract notifications
];

/** Subject patterns that suggest civic content (tested alongside domain). */
const CIVIC_SUBJECT_PATTERNS = [
  /\bagenda\b/i,
  /\bminutes\b/i,
  /\bpublic\s+hearing\b/i,
  /\bcouncil\s+(meeting|session)/i,
  /\bplanning\s+commission\b/i,
  /\bcity\s+council\b/i,
  /\btown\s+council\b/i,
  /\bboard\s+of\s+(supervisors|directors|commissioners)\b/i,
  /\bpublic\s+notice\b/i,
  /\brfp\b|\brfq\b|\brfi\b/i,
  /request\s+for\s+(proposals?|qualifications?|information)/i,
  /\bbid\s+(opportunity|award|notice|opening)\b/i,
  /\bsole\s+source\b/i,
  /\bmeeting\s+(cancelled|canceled|rescheduled|postponed|modified)/i,
  /\bmodified\s+agenda\b/i,
  /\bcommission\s+meeting\b/i,
  /\bprocurement\b/i,
  /\bcapital\s+improvement\s+(plan|project)/i,
];

export interface CivicClassification {
  /** True if the email contains civic/governance content Stoa should see. */
  isCivic: boolean;
  /** Primary reason the classifier fired, for logging/debugging. */
  reason: string;
}

export function classifyCivic(fromAddress: string, subject: string): CivicClassification {
  const from = (fromAddress || "").toLowerCase();
  const subj = subject || "";

  // Extract domain from "Name <foo@bar.com>" or raw "foo@bar.com"
  const addrMatch = from.match(/<([^>]+)>/) ?? [null, from];
  const email = addrMatch[1] || from;
  const domain = email.split("@")[1] ?? "";

  for (const frag of CIVIC_SENDER_DOMAINS) {
    if (domain.includes(frag) || email.includes(frag)) {
      return { isCivic: true, reason: `civic-sender:${frag}` };
    }
  }
  for (const pat of CIVIC_SUBJECT_PATTERNS) {
    if (pat.test(subj)) {
      return { isCivic: true, reason: `civic-subject:${pat.source}` };
    }
  }
  return { isCivic: false, reason: "none" };
}

export interface ForwardToStoaInput {
  from: string;
  to: string;
  subject: string;
  body: string;
  html?: string;
  receivedAt: string;
  messageId?: string;
  classification: string;
}

/**
 * Forward to Stoa's civic-forward endpoint. Silent fail on any error — this
 * is a best-effort side channel, never block the primary webhook response.
 */
export async function forwardToStoa(input: ForwardToStoaInput): Promise<void> {
  const secret = process.env.SBT_STOA_FORWARD_SECRET;
  const endpoint = process.env.SBT_STOA_FORWARD_URL ?? "https://stoa.works/api/admin/lookout/civic-forward";
  if (!secret) {
    console.warn("[civic-forward] SBT_STOA_FORWARD_SECRET not set — skipping forward");
    return;
  }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        subject: input.subject,
        body: input.body,
        html: input.html,
        receivedAt: input.receivedAt,
        messageId: input.messageId,
        sbtClassification: input.classification,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[civic-forward] Stoa responded ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[civic-forward] forward failed: ${(err as Error).message}`);
  }
}
