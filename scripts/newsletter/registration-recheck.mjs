// ---------------------------------------------------------------------------
// Build-time registration re-check for newsletter event listings
// ---------------------------------------------------------------------------
// The event feed the 3:50 AM newsletter reads was generated the previous
// evening (~7:15 PM), and BiblioCommons closes registration on schedules the
// feed only carries as rules. The Sept 1 2026 issue listed SJPL's "Intro to
// Ukulele for Adults" with a "Reserve ahead" tag while the event's own page
// said "Registration Closed" — it was session 3 of a 3-part series whose
// window ended Aug 17, and the per-instance isFull/registrationClosed flags
// in the feed API never flipped (both still false at send time).
//
// The authoritative live signal is the same one the library's page renders
// its badge from:
//
//   GET https://<libraryId>.bibliocommons.com/events/events/<eventId>/
//       registration_windows?client_scope=events
//   → { event: { status: "ACTIVE" | "UPCOMING" | "ENDED",
//                window_start, window_end } }
//
// status "ENDED" means no reader action is possible anymore — not even a
// waitlist — so the listing is dropped. The event record itself is also
// re-fetched (batched per library via the gateway's ?ids= parameter) so a
// listing that ingested as "required" but has since filled or been cancelled
// is re-labelled or dropped instead of printing a stale "Reserve ahead".
//
// Midpen volunteer occurrence pages redirect to their public registration
// portal; its actual remaining-spots section is checked as well.
// Cost per pass: one gateway request per library, one windows request per gated
// library event, and one request per Midpen project. The assembler checks
// today's pool before selection, then only featured listings after editing.
//
// FAIL OPEN. This runs minutes before the send; a network blip must never
// empty the events section or block the email (same philosophy as
// finalizeNewsletterImages and the editorial pass). Any fetch failure keeps
// the event exactly as the feed described it.
// ---------------------------------------------------------------------------

import {
  registrationFromBiblioCommons,
  requiresAdvanceRegistration,
  REGISTRATION_CLOSED,
  REGISTRATION_NONE,
} from "../../src/lib/south-bay/eventFilters.mjs";
import { midpenVolunteerUrl, parseMidpenVolunteerAvailability } from "../lib/midpen-events.mjs";
import { UA } from "../lib/http.mjs";

/** Library-id prefixes generate-events.mjs mints BiblioCommons ids under. */
export const BIBLIO_LIBRARY_IDS = new Set(["sjpl", "sccl", "paloalto", "sunnyvale"]);

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Split a feed event id like "sjpl-6a7a2993b44674e2601d024d" into its library
 * and BiblioCommons event id, or null for anything that isn't a BiblioCommons
 * record (Eventbrite, civic calendars, …) — those have no live endpoint to
 * consult and pass through the re-check untouched.
 */
export function biblioEventRef(event) {
  const m = /^([a-z]+)-([0-9a-f]{24})$/.exec(String(event?.id || ""));
  if (!m || !BIBLIO_LIBRARY_IDS.has(m[1])) return null;
  return { libraryId: m[1], eventId: m[2] };
}

async function fetchJsonWithTimeout(url, { fetchImpl, timeoutMs }) {
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Fresh per-instance records for the given refs, batched one request per
 * library. Returns Map<"lib/eventId", record>; libraries whose fetch fails
 * are simply absent (fail open — the caller keeps the feed's version).
 */
async function fetchFreshBiblioRecords(refs, opts) {
  const byLibrary = new Map();
  for (const ref of refs) {
    if (!byLibrary.has(ref.libraryId)) byLibrary.set(ref.libraryId, []);
    byLibrary.get(ref.libraryId).push(ref.eventId);
  }
  const records = new Map();
  await Promise.all(
    [...byLibrary.entries()].map(async ([libraryId, ids]) => {
      try {
        const data = await fetchJsonWithTimeout(
          `https://gateway.bibliocommons.com/v2/libraries/${libraryId}/events?ids=${ids.join(",")}`,
          opts,
        );
        const entities = data?.entities?.events || {};
        for (const id of ids) {
          if (entities[id]) records.set(`${libraryId}/${id}`, entities[id]);
        }
      } catch (err) {
        opts.log(`registration re-check: ${libraryId} gateway fetch failed (${err?.message || err}) — keeping feed state`);
      }
    }),
  );
  return records;
}

/**
 * Live registration-window status for one event: "ACTIVE", "UPCOMING",
 * "ENDED", or null when the endpoint is unreachable or says something new.
 */
export async function fetchRegistrationWindowStatus(ref, opts = {}) {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, log = console.warn } = opts;
  try {
    const data = await fetchJsonWithTimeout(
      `https://${ref.libraryId}.bibliocommons.com/events/events/${ref.eventId}/registration_windows?client_scope=events`,
      { fetchImpl, timeoutMs },
    );
    const status = String(data?.event?.status || "").toUpperCase();
    return ["ACTIVE", "UPCOMING", "ENDED"].includes(status) ? status : null;
  } catch (err) {
    log(`registration re-check: ${ref.libraryId}/${ref.eventId} windows fetch failed (${err?.message || err}) — keeping feed state`);
    return null;
  }
}

/**
 * Re-verify every registration-gated listing against the live source.
 *
 * Returns { events, dropped }: `events` preserves the input order with gated
 * library and Midpen listings re-labelled to their live state (a shallow copy —
 * the shared feed objects are never mutated), and `dropped` lists what was
 * removed and why:
 *   - the record is now cancelled
 *   - the live state is `closed` (registrationClosed flag)
 *   - the registration window has ENDED
 *
 * A listing whose live state downgrades to walk-up loses its registration
 * fields (the tag simply disappears); one that filled overnight keeps its
 * slot but prints "Registration full" instead of "Reserve ahead".
 */
export async function recheckRegistrationGatedEvents(events, opts = {}) {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, log = console.warn } = opts;
  const list = Array.isArray(events) ? events : [];
  const gated = list.filter((e) => requiresAdvanceRegistration(e) && biblioEventRef(e));
  const midpen = list.filter((e) => requiresAdvanceRegistration(e) && midpenVolunteerUrl(e));
  if (!gated.length && !midpen.length) return { events: list, dropped: [] };

  const records = await fetchFreshBiblioRecords(gated.map(biblioEventRef), { fetchImpl, timeoutMs, log });

  const dropped = [];
  const replacements = new Map();
  // These public project URLs redirect to Midpen's Galaxy Digital portal.
  // Check sequentially to keep load bounded. Unknown markup or HTTP failures
  // retain the feed state, including a previously verified full project.
  for (const event of midpen) {
    try {
      const res = await fetchImpl(midpenVolunteerUrl(event), {
        headers: { accept: "text/html", "user-agent": UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const registration = parseMidpenVolunteerAvailability(await res.text());
      if (registration && registration !== event.registration) {
        replacements.set(event, { ...event, registration });
      }
    } catch (err) {
      log(`registration re-check: Midpen/${event.id} fetch failed (${err?.message || err}) — keeping feed state`);
    }
  }
  await Promise.all(
    gated.map(async (event) => {
      const ref = biblioEventRef(event);
      const record = records.get(`${ref.libraryId}/${ref.eventId}`);
      if (!record) return; // gateway miss or fetch failure — fail open

      if (record.definition?.isCancelled === true) {
        dropped.push({ event, reason: "cancelled at the source since ingest" });
        replacements.set(event, null);
        return;
      }

      const fresh = registrationFromBiblioCommons(record);
      if (fresh === REGISTRATION_CLOSED) {
        dropped.push({ event, reason: "registration closed at the source (live check)" });
        replacements.set(event, null);
        return;
      }
      if (fresh === REGISTRATION_NONE) {
        // No longer gated at all — drop the tag, keep the listing.
        const { registration, registrationClosesBy, ...rest } = event;
        replacements.set(event, rest);
        return;
      }

      // Still gated (required / appointment-only / full): the flags can lag
      // the schedule, so the resolved window is the authority. ENDED means
      // even the waitlist is gone.
      const windowStatus = await fetchRegistrationWindowStatus(ref, { fetchImpl, timeoutMs, log });
      if (windowStatus === "ENDED") {
        dropped.push({ event, reason: "registration window ended at the source (live check)" });
        replacements.set(event, null);
        return;
      }
      if (fresh !== event.registration) {
        replacements.set(event, { ...event, registration: fresh });
      }
    }),
  );

  return {
    events: list
      .map((e) => (replacements.has(e) ? replacements.get(e) : e))
      .filter(Boolean),
    dropped,
  };
}
