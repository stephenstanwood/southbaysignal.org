// Title/venue de-duplication helpers.
//
// Several feeds pack the venue into the event title ("Brass Ensemble at Music
// Building" + venue="Music Building"). The card and the newsletter meta line
// render the venue separately, so the trailing suffix is pure stutter. These
// helpers are shared by generate-events.mjs and the one-off backfills so the
// logic can't drift between them — it already had (the backfills carried
// copies with a different minimum-base length and no pipe handling).
//
// Pure string functions, no I/O — see venue-suffix.test.mjs.

// RSS parsing in generate-events.mjs deliberately does NOT decode entities
// (some feeds double-encode, and the per-field cleaners handle it later). That
// leaves a window where the title has already been through cleanTitle() —
// which decodes — while the venue is still raw, so "…at International Student
// &amp; Scholar Services" never matched venue="International Student & Scholar
// Services" and the stutter survived. Compare decoded forms on both sides so
// the match is independent of where in the pipeline each field was cleaned.
function decodeEntities(s) {
  return String(s)
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&rsquo;|&lsquo;|&#8217;|&#8216;|&#x2019;|&#x2018;/gi, "'")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;|&#x201c;|&#x201d;/gi, '"')
    .replace(/&ndash;|&mdash;|&#8211;|&#8212;|&#x2013;|&#x2014;/gi, "-")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;|&#38;/gi, "&");
}

// Relaxed comparison form: drop a leading "the" and the standalone
// "Branch"/"Library" tokens so SJPL's "Tech Mentor at Edenvale Branch" and
// venue="Edenvale Library" both collapse to "edenvale" and match.
function norm(s) {
  return decodeEntities(s)
    .toLowerCase()
    .replace(/[.,]+$/, "")
    .replace(/^\s*the\s+/i, "")
    .replace(/\b(branch|library)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Trailing segment of a venue that is itself shaped "<Program/Room> at
 *  <Actual Venue>" — "AI Center for Civic and Social Good at King Library" →
 *  "King Library". Returns null when the venue holds no " at ".
 *
 *  Only used to widen the *title* comparison. Rewriting a venue to its tail is
 *  a caller decision: the shape is a defect when the venue was derived from a
 *  title (see extractVenueFromTitle), but authored venue names carry it
 *  legitimately — "School of Arts and Culture at MHP" is an organization's
 *  actual name, and collapsing it to "MHP" would be wrong. */
export function venueTailSegment(venue) {
  if (!venue || typeof venue !== "string") return null;
  // Leading .* is greedy, so this splits on the LAST " at ".
  const m = venue.match(/^.*\s+at\s+(.+)$/i);
  if (!m) return null;
  const tail = m[1].trim();
  return tail || null;
}

/** Pull a venue out of a title like "Workshop at King Library" → "King
 *  Library". Used when the source feed doesn't populate <location> — SJSU's
 *  Localist RSS emits no location element at all, so every SJSU venue comes
 *  from here. Without it, unrelated SJSU events all fall back to the generic
 *  "San Jose State University" venue and collide in cross-source dedup.
 *
 *  Splits on the LAST " at ". Splitting on the FIRST one is what manufactured
 *  venues like "AI Center for Civic and Social Good at King Library" out of
 *  "Open Lab Hours at AI Center for Civic and Social Good at King Library" —
 *  the program name is part of the event, not the place. A tail that fails the
 *  sanity guards yields null rather than falling back to an earlier split:
 *  the caller's generic-campus default beats a venue guessed out of the middle
 *  of a title. */
export function extractVenueFromTitle(title) {
  if (!title) return null;
  // Strip the calendar-artifact date prefix first
  const stripped = title.replace(
    /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\s*:\s*/i,
    "",
  );
  // Locate the LAST " at " by hand. A greedy-prefix regex would backtrack to
  // an earlier separator when the final tail fails the guards below, which is
  // exactly the mid-title guessing we don't want.
  let lastSep = -1;
  const finder = /\s+at\s+/gi;
  let hit;
  while ((hit = finder.exec(stripped)) !== null) lastSep = hit.index + hit[0].length;
  if (lastSep === -1) return null;

  const venue = stripped.slice(lastSep).trim();
  if (!/^[A-Z]/.test(venue)) return null;
  // A comma tail is "<City>, <State>", not a venue — Pattern 1 of
  // stripRedundantVenueSuffix handles those titles instead.
  if (venue.includes(",")) return null;
  // Reject obviously-non-venue tails (events ending with dates, times, etc.)
  if (/^\d|^(noon|midnight)\b/i.test(venue)) return null;
  return venue;
}

/** Drop a trailing " at <Venue>" from a title when the suffix duplicates the
 *  venue field. Also drops SJSU sports' " at <City>, <State-abbr>." location
 *  tail, which the SJSU athletics RSS appends to every game title even though
 *  the venue field already carries the campus location. */
export function stripRedundantVenueSuffix(title, venue) {
  if (!title) return title;
  let t = title;

  // Pattern 1: " at <City>, Calif./CA[.]" — SJSU Athletics location tail
  t = t.replace(
    /\s+at\s+[A-Z][\w\s.'-]+,\s*(?:Calif\.?|CA)\.?$/i,
    "",
  );

  // When the title IS the venue name, there is no duplication to remove —
  // whatever follows " at " is part of the place's own name. Plenty of real
  // South Bay venues are shaped that way ("The Spa at Four Seasons Hotel
  // Silicon Valley", "Joe's Trail at Cox and de Anza", "Cooper-Garrod
  // Vineyards at Garrod Farms"), and day-plan place cards carry the name in
  // both fields, so without this they would collapse to "The Spa".
  if (venue && typeof venue === "string" && norm(t) === norm(venue)) return t;

  if (venue && typeof venue === "string") {
    // A title suffix may name either the whole venue field or just its real
    // trailing segment: SJSU emits "Dr. Sandy Hirsh's keynote at InSITE2026
    // (MLK Library) at King Library" with venue="InSITE2026 (MLK Library) at
    // King Library", where the suffix that needs dropping is only "King
    // Library". Both forms count as a match; anything else is left alone.
    const venueForms = [venue, venueTailSegment(venue)]
      .filter(Boolean)
      .map(norm)
      .filter(Boolean);
    // Empty-vs-empty is a coincidence, not a match — a venue of "Library"
    // norms away to nothing and would otherwise swallow any " at <the
    // Branch>" suffix.
    const matchesVenue = (s) => {
      const ns = norm(s);
      return !!ns && venueForms.includes(ns);
    };

    // Pattern 2: " at <Venue>" matching the venue field. Greedy base group +
    // /i flag so we match the LAST " at " (handles titles like "SJSU Alumni
    // Night at the SJ Giants at Excite Ballpark") and tolerate capitalized
    // "At" from sources like SJPL.
    const m = t.match(/^(.+)\s+at\s+(.+?)\s*$/i);
    if (m) {
      const [, base, suffix] = m;
      if (matchesVenue(suffix) && base.trim().length >= 6) {
        t = base.trim();
      } else {
        // Subtitle-aware: "<Title> at <Venue> - <Subtitle>" or with em/en-dash.
        // Try splitting suffix on the dash and checking whether the venue
        // half matches. If yes, drop the venue half and rejoin as
        // "<Title> — <Subtitle>" so the subtitle survives.
        const dashMatch = suffix.match(/^(.+?)\s+[-–—]\s+(.+?)$/);
        if (dashMatch) {
          const [, suffixVenue, subtitle] = dashMatch;
          if (
            matchesVenue(suffixVenue) &&
            base.trim().length >= 6 &&
            subtitle.trim().length >= 4
          ) {
            t = `${base.trim()} — ${subtitle.trim()}`;
          }
        }
      }
    }

    // Pattern 3: " | <Venue>" matching the venue field. Stanford Localist
    // emits some recurring events with the venue appended via pipe ("Spotlight
    // Tours Thursdays | Anderson Collection") even though the venue field
    // already carries it. Conservative: only strip when the pipe-suffix
    // matches the venue, so subtitles like "Archive Room: Ester Hernandez |
    // Selections from Special Collections at Stanford Libraries" (legitimate
    // pipe-separated subtitle, not a venue) survive.
    const pipeMatch = t.match(/^(.+?)\s*\|\s*(.+?)\s*$/);
    if (pipeMatch) {
      const [, base, suffix] = pipeMatch;
      if (matchesVenue(suffix) && base.trim().length >= 6) {
        t = base.trim();
      }
    }
  }

  return t;
}
