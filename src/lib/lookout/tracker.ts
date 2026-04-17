/**
 * Newsletter subscription tracker.
 *
 * Tracks the state of every newsletter / mailing list we've tried to
 * subscribe `sandcathype@gmail.com` to. The subscribe script writes rows
 * as it attempts each signup. The intake webhook updates rows when real
 * emails arrive from a tracked sender.
 *
 * Storage: Vercel Blob in prod, filesystem locally (same pattern as the
 * events/log stores).
 *
 * Access: /admin/newsletters?key=<ADMIN_KEY> renders the table.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { put, head } from "@vercel/blob";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function dataPath(name: string): string {
  return join(__dirname, "../../../src/data/south-bay", name);
}

const TRACKER_PATH = dataPath("newsletter-tracker.json");
const TRACKER_BLOB_KEY = "lookout/newsletter-tracker.json";

// ── Types ───────────────────────────────────────────────────────────────────

export type SubscribeStatus =
  | "not-attempted" // row exists but we haven't hit the form yet
  | "signup-posted" // we submitted the form, waiting for confirmation email
  | "confirmed" // confirmation email auto-clicked or direct add
  | "receiving" // at least one real newsletter has arrived
  | "failed" // subscribe attempt failed
  | "needs-manual" // requires a human click — CAPTCHA, multi-step, SSO, etc.
  | "retry" // signup attempted but failed (CC throttle, form error, etc.) — come back to this later
  | "blocked"; // site refused / terms-incompatible

export type ProviderType =
  | "civicplus_notifyme"
  | "mailchimp"
  | "constant_contact"
  | "squarespace"
  | "chambermaster"
  | "libraryaware"
  | "generic_html_form"
  | "unknown";

export interface NewsletterTarget {
  /** Stable id — kebab-case slug, e.g. "saratoga-source". */
  id: string;
  /** Display name. */
  name: string;
  /** Signup page URL. */
  signupUrl: string;
  /** Which south bay city/region this serves (best-effort). */
  city?: string;
  /** High-level category for grouping in the UI. */
  category:
    | "city"
    | "chamber"
    | "library"
    | "museum"
    | "parks"
    | "arts"
    | "business-district"
    | "school"
    | "transit"
    | "other";
  /** Detected or known provider. */
  provider: ProviderType;
  /** Priority: 1 = highest (big cities, weekly volume), 3 = lowest. */
  priority: 1 | 2 | 3;
  /** Notes / quirks for Stephen. */
  notes?: string;

  // ── Runtime state (updated by subscribe script + webhook) ──
  status: SubscribeStatus;
  /** ISO timestamp of the most recent subscribe attempt. */
  attemptedAt?: string;
  /** ISO timestamp the subscription was confirmed (auto or manual). */
  confirmedAt?: string;
  /** ISO timestamp of the most recently received newsletter from this source. */
  lastReceivedAt?: string;
  /** Total number of newsletters received from this source. */
  receivedCount: number;
  /** Email addresses we've seen this source send from (for auto-matching inbound mail). */
  seenFromAddresses: string[];
  /** Domain(s) we've seen — coarser match when the exact address varies. */
  seenFromDomains: string[];
  /** Error message from the last failed attempt, if any. */
  lastError?: string;
}

export interface NewsletterTrackerDoc {
  version: 1;
  updatedAt: string;
  targets: NewsletterTarget[];
  /** Target ids the user has explicitly deleted — don't re-add them on re-seed. */
  deletedIds?: string[];
}

// ── Public API ──────────────────────────────────────────────────────────────

function getBlobToken(): string | null {
  const fromProcess = typeof process !== "undefined" ? process.env?.BLOB_READ_WRITE_TOKEN : undefined;
  const fromImport = typeof import.meta !== "undefined" ? (import.meta as ImportMeta).env?.BLOB_READ_WRITE_TOKEN : undefined;
  return (fromProcess ?? fromImport) || null;
}

function hasBlobToken(): boolean {
  return !!getBlobToken();
}

/**
 * Strip any targets whose id is in deletedIds. Defense-in-depth: even if a
 * subscribe script or stale write resurrects a row that was supposed to be
 * gone, the read path will hide it. The tombstone in deletedIds is the source
 * of truth for "this should not exist."
 */
function applyDeletedIds(doc: NewsletterTrackerDoc): NewsletterTrackerDoc {
  const deleted = new Set(doc.deletedIds ?? []);
  if (deleted.size === 0) return doc;
  const filtered = doc.targets.filter((t) => !deleted.has(t.id));
  if (filtered.length === doc.targets.length) return doc;
  return { ...doc, targets: filtered };
}

export async function readTracker(): Promise<NewsletterTrackerDoc> {
  if (hasBlobToken()) {
    const raw = await readBlobJson(TRACKER_BLOB_KEY);
    if (raw === null) return emptyDoc();
    try {
      return applyDeletedIds(JSON.parse(raw) as NewsletterTrackerDoc);
    } catch {
      return emptyDoc();
    }
  }
  if (!existsSync(TRACKER_PATH)) return emptyDoc();
  try {
    return applyDeletedIds(JSON.parse(readFileSync(TRACKER_PATH, "utf-8")) as NewsletterTrackerDoc);
  } catch {
    return emptyDoc();
  }
}

export async function writeTracker(doc: NewsletterTrackerDoc): Promise<void> {
  // Race-safety for deletions: between our read and write, another request
  // (another delete click, the mark endpoint, or the intake webhook) may have
  // landed a newer deletedIds that we'd otherwise clobber. Merge the latest
  // tombstones from blob (union, never shrink) so deletions are never lost to
  // concurrent read-modify-write cycles. Also re-filter targets so tombstoned
  // ids can't sneak back in.
  if (hasBlobToken()) {
    try {
      const latest = await readBlobJson(TRACKER_BLOB_KEY);
      if (latest) {
        const parsed = JSON.parse(latest) as NewsletterTrackerDoc;
        const merged = new Set<string>([
          ...(doc.deletedIds ?? []),
          ...(parsed.deletedIds ?? []),
        ]);
        doc.deletedIds = Array.from(merged);
      }
    } catch {
      // If the merge-read fails, fall through with our local view. Worst case
      // is one lost tombstone — we don't want to fail the whole write.
    }
  }
  doc = applyDeletedIds(doc);
  doc.updatedAt = new Date().toISOString();
  const json = JSON.stringify(doc, null, 2);
  if (hasBlobToken()) {
    await writeBlobJson(TRACKER_BLOB_KEY, json);
    return;
  }
  ensureDir(TRACKER_PATH);
  writeFileSync(TRACKER_PATH, json);
}

function findTrackerMatch(doc: NewsletterTrackerDoc, fromEmail: string): NewsletterTarget | null {
  if (!fromEmail) return null;
  const addr = fromEmail.toLowerCase().trim();
  const domain = addr.split("@")[1] ?? "";
  return (
    doc.targets.find((t) => {
      if ((t.seenFromAddresses ?? []).some((a) => a.toLowerCase() === addr)) return true;
      if ((t.seenFromDomains ?? []).some((d) => d.toLowerCase() === domain)) return true;
      return false;
    }) ?? null
  );
}

/**
 * Called by the intake webhook when a REAL newsletter email arrives.
 * Bumps lastReceivedAt + receivedCount and auto-promotes the tracker from
 * "signed up" → "live" (receiving) on first real send. This is the
 * transition Stephen cares about — there is no manual approval step.
 *
 * Do NOT call this for confirmation or ack emails — the intake handler
 * short-circuits those before they reach this function so they don't
 * skew receivedCount.
 *
 * "confirmed" is a legacy status (see noteConfirmationClicked) — we still
 * promote it here so any pre-existing rows flow through correctly.
 */
export async function noteInboundFromSender(
  fromEmail: string,
  receivedAt: string
): Promise<string | null> {
  const doc = await readTracker();
  const match = findTrackerMatch(doc, fromEmail);
  if (!match) return null;

  match.lastReceivedAt = receivedAt;
  match.receivedCount = (match.receivedCount ?? 0) + 1;
  // Auto-promote signed-up rows to live on first real newsletter.
  // needs-manual is also promoted — once a real newsletter arrives, the
  // manual signup must have happened even if we never saw the click.
  if (
    match.status === "signup-posted" ||
    match.status === "confirmed" ||
    match.status === "needs-manual"
  ) {
    match.status = "receiving";
  }
  const addr = fromEmail.toLowerCase().trim();
  if (!match.seenFromAddresses.includes(addr)) {
    match.seenFromAddresses.push(addr);
  }

  await writeTracker(doc);
  return match.id;
}

/**
 * @deprecated "confirmed" is no longer used as a distinct state. Stephen clicks
 * confirmation links manually (auto-click is disabled to avoid bot-flagging
 * sandcathype@gmail.com), so there's no auto-confirmation signal to record.
 * The tracker flows directly from needs-manual → signup-posted → receiving
 * (the last hop happens automatically in noteInboundFromSender when a real
 * newsletter arrives).
 *
 * Kept as a no-op stub so any lingering callers don't crash. Do not wire new
 * code to this function.
 */
export async function noteConfirmationClicked(_fromEmail: string): Promise<string | null> {
  return null;
}

/**
 * Called by the subscribe script to upsert a target row.
 */
export async function upsertTarget(
  target: Omit<NewsletterTarget, "receivedCount" | "seenFromAddresses" | "seenFromDomains"> & {
    receivedCount?: number;
    seenFromAddresses?: string[];
    seenFromDomains?: string[];
  }
): Promise<void> {
  const doc = await readTracker();
  const deleted = new Set(doc.deletedIds ?? []);
  if (deleted.has(target.id)) {
    // Refuse to resurrect a tombstoned target. Subscribe scripts already
    // filter on this, but enforce here too in case a one-off path skips it.
    return;
  }
  const idx = doc.targets.findIndex((t) => t.id === target.id);
  const merged: NewsletterTarget = {
    receivedCount: 0,
    seenFromAddresses: [],
    seenFromDomains: [],
    ...(idx >= 0 ? doc.targets[idx] : {}),
    ...target,
  } as NewsletterTarget;
  if (idx >= 0) doc.targets[idx] = merged;
  else doc.targets.push(merged);
  await writeTracker(doc);
}

// ── Storage helpers ─────────────────────────────────────────────────────────

function emptyDoc(): NewsletterTrackerDoc {
  return { version: 1, updatedAt: new Date().toISOString(), targets: [], deletedIds: [] };
}

/**
 * Mark an id as explicitly deleted (permanent blocklist).
 * Subscribe scripts should refuse to re-add anything in this list.
 */
export async function markDeleted(id: string): Promise<void> {
  const doc = await readTracker();
  doc.deletedIds = doc.deletedIds ?? [];
  if (!doc.deletedIds.includes(id)) doc.deletedIds.push(id);
  doc.targets = doc.targets.filter((t) => t.id !== id);
  await writeTracker(doc);
}

async function readBlobJson(pathname: string): Promise<string | null> {
  const token = getBlobToken();
  if (!token) return null;
  try {
    // head() returns metadata including the downloadUrl for the blob.
    // For public blobs we can fetch the URL directly; for private we need token.
    const meta = await head(pathname, { token });
    if (!meta?.url) return null;
    // Cache-bust the fetch: the same URL is reused across writes and Vercel's
    // edge cache will happily serve stale content for minutes otherwise.
    const cacheBuster = `?_cb=${Date.now()}`;
    const res = await fetch(meta.url + cacheBuster, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return await res.text();
  } catch (err) {
    if ((err as Error).name === "BlobNotFoundError") return null;
    if (/404|not.found/i.test((err as Error).message)) return null;
    throw err;
  }
}

async function writeBlobJson(pathname: string, json: string): Promise<void> {
  const token = getBlobToken();
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN not available");
  await put(pathname, json, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    token,
    // Disable CDN caching so updates are immediately visible to the
    // poller. Without this, overwrites at the same URL are served stale
    // from Vercel's edge cache for minutes.
    cacheControlMaxAge: 0,
  });
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
