/**
 * Types for the inbound-email event intake pipeline.
 *
 * Cities email newsletters to in@lookout.southbaytoday.org. Resend delivers
 * them, a webhook lands at /api/admin/events/intake, and an LLM extracts
 * concrete events into InboundEvent records stored in Vercel Blob.
 */

export interface InboundEmail {
  from: string;
  to: string;
  subject: string;
  body: string; // text or stripped html
  receivedAt: string;
  messageId: string;
}

/**
 * A single event extracted from an inbound newsletter.
 * Shape is designed to round-trip cleanly into generate-events.mjs, which
 * merges inbound events alongside playwright-scraped events.
 */
export interface InboundEvent {
  /** Stable id, prefixed `inbound_`. */
  id: string;
  /** ISO timestamp the email was received. */
  receivedAt: string;
  /** Sender email (for debugging / dedup by source). */
  fromEmail: string;
  /** Email subject. */
  emailSubject: string;

  // ── Extracted event fields ──
  title: string;
  /** ISO 8601 with America/Los_Angeles offset. */
  startsAt: string;
  /** ISO 8601 or null if not specified. */
  endsAt: string | null;
  /** Venue name + address if given. */
  location: string | null;
  description: string;
  sourceUrl: string | null;
  /** Normalized city key (e.g. "saratoga", "campbell"). May be null if LLM couldn't determine. */
  cityKey: string | null;
  /** City as the LLM returned it (human-readable). */
  cityName: string | null;

  // ── Review workflow ──
  status: "new" | "approved" | "rejected";
  notes?: string | null;
}

export interface InboundIntakeLog {
  /** Hash of from+subject+messageId — used to dedup re-delivered webhooks. */
  dedupHash: string;
  receivedAt: string;
  from: string;
  subject: string;
  outcome: "events-extracted" | "no-events" | "extractor-error" | "duplicate";
  eventCount: number;
  error?: string;
}
