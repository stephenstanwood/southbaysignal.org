// ---------------------------------------------------------------------------
// libcal-location — read a LibCal event's own `Location:` value instead of
// stamping every event with the host library's building.
//
// scrapeLibCal used to copy `name` + `address` straight off LIBCAL_LIBRARIES
// onto every scraped event. LibCal publishes a per-event Location, and a
// library's calendar is not only its own building — it also carries online
// programs and events held at parks, schools and community sites. On
// 2026-08-06 both failure modes shipped from mountainview.libcal.com:
//
//   • event/16953202 "Preserving the Seasons" — Location: Online. It shipped
//     as an 11:00 AM in-person event at 585 Franklin St and was picked as the
//     newsletter's Morning Pick with a "Breakfast Nearby" restaurant pairing.
//   • event/16650443 "End of Summer Dance Party" — Location: Pioneer Park. It
//     shipped as a 6:30 PM event at the library.
//
// The classification is deliberately conservative in one direction: a location
// we don't recognise is treated as OFF-SITE, never as the library. Guessing
// "off-site" for a room we failed to list costs a slightly odd venue label;
// guessing "the library" for a real off-site event sends a reader to the wrong
// building, which is the bug above.
//
// No address is invented for off-site venues. The Events tab builds its
// Directions link as a Google Maps *search* over venue + city
// (EventsView.buildEventMapsUrl), so "Pioneer Park" + "mountain-view" already
// resolves correctly. A library MAY carry an `offsiteAddresses` map of
// verified street addresses; anything not in it ships with an empty address
// rather than a guess.
// ---------------------------------------------------------------------------

/** Online / remote markers. Anchored words so a room called "Zoom Room"
 *  doesn't need special-casing and "Teams" only counts in its meeting sense. */
const ONLINE_PATTERNS = [
  /\bonline\b/i,
  /\bvirtual(?:ly)?\b/i,
  /\bzoom\b/i,
  /\bwebex\b/i,
  /\bwebinar\b/i,
  /\blive[-\s]?stream(?:ed|ing)?\b/i,
  /\bgoogle\s+meet\b/i,
  /\b(?:ms|microsoft|teams)\s+meeting\b/i,
  /\bmicrosoft\s+teams\b/i,
  /\bremote\s+only\b/i,
];

/** Placeholders that say "not here" without saying where. Distinct from
 *  off-site: there is no venue name to show and no address to look up. */
const UNKNOWN_PATTERNS = [
  /^off[-\s]?site$/i,
  /^tb[adc]$/i,
  /^to\s+be\s+(determined|announced|confirmed)$/i,
  /^vari(?:ous|es)(\s+locations?)?$/i,
  /^see\s+(description|details|event\s+page)$/i,
  /^n\/?a$/i,
  /^none$/i,
  /^other$/i,
];

/** The bookmobile parks all over town; its stops are outreach, not public
 *  events, and their "titles" are just wherever it parked. Already dropped by
 *  the scraper — matching here makes the signal exact rather than a scan of
 *  the whole card's text. */
const BOOKMOBILE_PATTERN = /^mobile\s+library\s+stop$/i;

/** Generic in-building spaces. Suffix-anchored: these are what libraries call
 *  rooms, and no South Bay park, school or community site we've seen ends in
 *  one of them. */
const ONSITE_SUFFIX_PATTERN =
  /\b(room|lobby|auditorium|atrium|gallery|lab|makerspace|courtyard|patio|terrace|garage|annex|mezzanine|commons|stacks|foyer|hall)$/i;

function tidy(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
}

/**
 * Classify one LibCal `Location:` value against its host library.
 *
 * @param {string} rawLocation  the event page's Location text ("Online",
 *   "Pioneer Park", "1st Floor Program Room", "Zoom (Online)", "").
 * @param {object} library      a LIBCAL_LIBRARIES entry: { name, address,
 *   city, onsiteLocations? }. `onsiteLocations` names in-building spaces that
 *   the generic suffix rule can't know about — Mountain View's "History
 *   Center" is on the library's 2nd floor, for instance.
 * @returns {{kind: "onsite"|"online"|"offsite"|"unknown"|"bookmobile",
 *   location: string, venue: string, address: string, virtual: boolean}}
 */
export function classifyLibCalLocation(rawLocation, library = {}) {
  const location = tidy(rawLocation);
  const libraryName = library.name || "";
  const libraryAddress = library.address || "";

  const onsite = () => ({ kind: "onsite", location, venue: libraryName, address: libraryAddress, virtual: false });

  // No Location on the page — fall back to the library config, which is the
  // only thing we know. This is the sole path that keeps the old behaviour.
  if (!location) return onsite();

  if (BOOKMOBILE_PATTERN.test(location)) {
    return { kind: "bookmobile", location, venue: libraryName, address: "", virtual: false };
  }

  // Online first: "Zoom (Online)" carries a room-shaped word in some LibCal
  // installs, and a hybrid listing ("In-Person / Online" with Location
  // "Zoom (Online)") is safer treated as virtual. eventFilters.mjs makes the
  // same call — a false positive costs one skipped recommendation, a false
  // negative sends someone to a building for a Zoom call.
  if (ONLINE_PATTERNS.some((p) => p.test(location))) {
    return { kind: "online", location, venue: "Online", address: "", virtual: true };
  }

  if (UNKNOWN_PATTERNS.some((p) => p.test(location))) {
    // Host the library gets the name (it IS a library program) but never the
    // address — we don't know where this one is.
    return { kind: "unknown", location, venue: libraryName, address: "", virtual: false };
  }

  const onsiteNames = (library.onsiteLocations || []).map((s) => tidy(s).toLowerCase());
  if (onsiteNames.includes(location.toLowerCase())) return onsite();

  if (ONSITE_SUFFIX_PATTERN.test(location)) return onsite();

  // Off-site: a real place with a name. Venue is the place; the address comes
  // from the library's verified map or stays empty — nothing asserts a street
  // we haven't checked against a first-party source.
  const offsite = library.offsiteAddresses || {};
  const matched = Object.keys(offsite).find((k) => tidy(k).toLowerCase() === location.toLowerCase());
  return {
    kind: "offsite",
    location,
    venue: location.length <= 80 ? location : libraryName,
    address: matched ? offsite[matched] : "",
    virtual: false,
  };
}
