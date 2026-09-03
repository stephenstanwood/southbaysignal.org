// ---------------------------------------------------------------------------
// venue-location-audit — catch "shipped under the wrong building" in the
// generated feed, whichever adapter produced it.
//
// Two defects of the same shape reached readers on 2026-09-03:
//
//   • Cuesta Park Storytime (LibCal)  — an outreach storytime at a city park,
//     shipped as "Mountain View Public Library" with no address.
//   • Line Dancing with Sandy and Kent (BiblioCommons) — a class that had
//     moved to the Mitchell Park Community Center, shipped as "Palo Alto City
//     Library". The newsletter flagged the move while naming the building the
//     class moved OUT of.
//
// Both were fixed at their ingest paths (lib/libcal-location.mjs,
// lib/biblio-location.mjs) and are unit-tested there. This module is the
// backstop over the OUTPUT, so a third adapter reintroducing the shape is
// caught by data rather than by a reader.
//
// The blocking rule is deliberately narrow — it fires only where the record
// contradicts ITSELF, which needs no network call and cannot be a matter of
// taste. Broader smells are reported as warnings instead of failing a refresh.
// ---------------------------------------------------------------------------

/** A title the source itself prefixed to announce a move. Sources write these
 *  in caps as a banner ("LOCATION CHANGE: Line Dancing with Sandy and Kent",
 *  "MOVED: Meditation with Sara"). */
const LOCATION_CHANGE_TITLE = /^\s*[*\s]*(location\s+change|new\s+location|location\s+moved|moved|relocated|venue\s+change)\b\s*[:\-—–]/i;

/** The same announcement made in the body copy. Requires a destination clause
 *  so "the class moved quickly" can't match. */
const LOCATION_CHANGE_BODY = /\b(has\s+moved|have\s+moved|is\s+moving|has\s+been\s+moved|relocated|location\s+change|new\s+location)\b[^.!?]{0,80}?\b(to|indoors\s+to|into)\b/i;

/** Venue strings that name an institution generically rather than a place —
 *  i.e. exactly what a bad fallback produces. */
function isGenericSourceVenue(event) {
  const venue = String(event?.venue ?? "").trim();
  const source = String(event?.source ?? "").trim();
  return Boolean(venue) && venue.toLowerCase() === source.toLowerCase();
}

function plainText(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Audit one generated event.
 * @returns {{level: "block"|"warn", rule: string, message: string}|null}
 */
export function auditEventLocation(event) {
  if (!event || typeof event !== "object") return null;
  const title = plainText(event.title);
  const description = plainText(event.description);
  const venue = String(event.venue ?? "").trim();
  const source = String(event.source ?? "").trim();

  // BLOCK — the record announces it is somewhere other than its listing
  // institution, and then names that institution as the venue. Self-contradictory.
  if (isGenericSourceVenue(event)) {
    if (LOCATION_CHANGE_TITLE.test(title)) {
      return {
        level: "block",
        rule: "location-change-names-source",
        message:
          `"${title}" announces a location change but ships venue "${venue}" — `
          + `the listing institution, not the place it moved to`,
      };
    }
    if (LOCATION_CHANGE_BODY.test(description)) {
      return {
        level: "block",
        rule: "location-change-names-source",
        message:
          `"${title}" describes a move but ships venue "${venue}" — `
          + `the listing institution, not the place it moved to`,
      };
    }
  }

  // WARN — venue is just the source name and no address was captured. Often
  // legitimate (a library program really at the library), so this reports
  // rather than blocks; it is the population the 2026-09-03 defects sat in.
  if (isGenericSourceVenue(event) && !String(event.address ?? "").trim()) {
    return {
      level: "warn",
      rule: "source-venue-no-address",
      message: `"${title}" ships venue "${source}" with no address`,
    };
  }

  return null;
}

/**
 * Audit a whole generated feed.
 * @returns {{problems: string[], warnings: string[], blocked: number, warned: number}}
 */
export function auditEventLocations(events = []) {
  const problems = [];
  const warnings = [];
  for (const event of Array.isArray(events) ? events : []) {
    const finding = auditEventLocation(event);
    if (!finding) continue;
    const line = `${finding.rule}: ${finding.message}`;
    if (finding.level === "block") problems.push(line);
    else warnings.push(line);
  }
  return { problems, warnings, blocked: problems.length, warned: warnings.length };
}
