// Linden Tree Books calendar-heading parser.
//
// Every event on lindentreebooks.com/events-calendar/ is one <h3> whose parts
// are separated by <br>, not by block elements:
//
//   <b>To the Stars and Back: Love Across Eons and Galaxies<br>
//      YA Fantasy Author Panel with T.A. Chan, Samantha Chong, and S.G. Prince<br></b>
//   <b>Friday, August 14 at 6:00pm</b>
//
// `textContent` drops <br> entirely, so the scraper read that heading as
// "…and GalaxiesYA Fantasy Author Panel with…" and shipped it to the events
// feed with the words welded together. The scraper now reads `innerText`,
// which renders <br> as a newline, and hands the lines here.
//
// The line structure also carries two facts the old single-string read could
// not see, both of which shipped wrong on the Sept 13 Baby-Sitters Club launch:
// an "at <Venue>" line meaning the event is NOT at the store, and a "Buy
// Tickets" call-to-action meaning it is not free.
//
// Pure string functions, no I/O — see linden-tree-heading.test.mjs.

/** Off-site venues Linden Tree actually books, with hand-verified location
 *  data. The store hardcodes its own address on every event it scrapes, so an
 *  off-site event with no entry here would be published at "Linden Tree Books,
 *  Los Altos" — a resident would drive to the wrong city. Unknown off-site
 *  venues are dropped by the caller instead (missing beats wrong). */
export const LINDEN_TREE_OFFSITE_VENUES = [
  {
    match: /spangenberg/i,
    venue: "Spangenberg Theatre at Gunn High School",
    address: "780 Arastradero Rd, Palo Alto, CA 94306",
    city: "palo-alto",
  },
];

/** A heading line that names a different venue rather than continuing the
 *  title: "at Gunn High School's Spangenberg Theater". Anchored on a leading
 *  "at " so a subtitle that merely contains the word ("In conversation with
 *  Randy Ribay") is never mistaken for one. */
function isVenueLine(line) {
  return /^at\s+\S/i.test(line);
}

/**
 * Split the pre-date lines of a Linden Tree heading into a title and, when the
 * event is held elsewhere, the off-site venue it names.
 *
 * @param {string[]} lines  Heading lines above the date line, in source order.
 * @returns {{ title: string, offsiteVenueText: string|null }}
 *   `title` joins the remaining lines with an em dash, matching the
 *   "<Title> — <Subtitle>" shape stripRedundantVenueSuffix already produces.
 */
export function parseLindenTreeHeadingLines(lines) {
  const clean = (Array.isArray(lines) ? lines : [])
    .map((l) => String(l == null ? "" : l).replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const titleParts = [];
  let offsiteVenueText = null;
  for (const line of clean) {
    // Only the first "at <Venue>" line is treated as a venue; a second one
    // would be part of the title, not a second location.
    if (offsiteVenueText === null && isVenueLine(line)) {
      offsiteVenueText = line.replace(/^at\s+/i, "").trim() || null;
      if (offsiteVenueText) continue;
    }
    titleParts.push(line);
  }

  return { title: titleParts.join(" — "), offsiteVenueText };
}

/** Resolve an "at <Venue>" line to verified location data, or null when the
 *  venue isn't one we've confirmed. */
export function resolveLindenTreeOffsiteVenue(offsiteVenueText) {
  if (!offsiteVenueText) return null;
  for (const v of LINDEN_TREE_OFFSITE_VENUES) {
    if (v.match.test(offsiteVenueText)) {
      const { match, ...rest } = v;
      return rest;
    }
  }
  return null;
}

/** The store's calendar links free events as "RSVP Now »" and ticketed ones as
 *  "Buy Tickets Now »". Only the latter is evidence of a price — everything
 *  else keeps the free default rather than guessing. */
export function lindenTreeIsTicketed(headingText) {
  return /\b(buy\s+tickets|purchase\s+tickets|tickets\s+on\s+sale)\b/i.test(
    String(headingText || ""),
  );
}
