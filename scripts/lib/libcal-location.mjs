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
// A second shape of the same bug shipped on 2026-09-03. LibCal's own Location
// field can be the literal string "Offsite" — event/17295774 "Cuesta Park
// Storytime", an outreach storytime at a city park, published exactly that.
// "Offsite" was matched by UNKNOWN_PATTERNS below, whose branch hands the
// record the LIBRARY's name, so the record shipped as "Mountain View Public
// Library" on the site, in the newsletter, and in the schema.org JSON-LD.
//
// That conflated two different statements a source can make:
//   • "TBD" / "Various" / "See description" — we do not know where.
//   • "Offsite"                             — we know it is NOT the library.
// Only the first may fall back to the library's name. "Offsite" is now its own
// kind and can never resolve to the host building. It is instead resolved from
// first-party text on the event itself: the library's verified offsiteAddresses
// map, then an address the event's own description publishes ("Find us at 615
// Cuesta Drive, Mountain View, CA 94040"). If neither answers, the event is
// suppressed rather than shipped under a building it is not held in.
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
  /^tb[adc]$/i,
  /^to\s+be\s+(determined|announced|confirmed)$/i,
  /^vari(?:ous|es)(\s+locations?)?$/i,
  /^see\s+(description|details|event\s+page)$/i,
  /^n\/?a$/i,
  /^none$/i,
  /^other$/i,
];

/** "Offsite" and its spellings. Unlike the placeholders above, this asserts a
 *  fact — the event is NOT in the library — so it must never fall back to the
 *  library's name. See the header for the 2026-09-03 Cuesta Park defect. */
const OFFSITE_UNNAMED_PATTERN = /^off[-\s]?site$/i;

/** A full US street address published in the event's own description.
 *  Deliberately strict: house number, a street with a real suffix, a city, and
 *  a state (optionally a ZIP). Libraries write these as "Find us at 615 Cuesta
 *  Drive, Mountain View, CA 94040" or "Meet us there: Deer Hollow Farm, 22500
 *  Cristo Rey Dr., Cupertino". Anything looser would start matching prose. */
const STREET_ADDRESS_PATTERN = new RegExp(
  String.raw`\b(\d{2,6}\s+[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,4}\s+` +
    String.raw`(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir|Terrace|Ter|Parkway|Pkwy|Highway|Hwy)\.?` +
    String.raw`(?:\s*,\s*[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3})` +
    String.raw`\s*,\s*(?:CA|California)\b(?:\s*,?\s*\d{5})?)`,
  "i",
);

/** Pull the library's own published address out of an event description.
 *  Returns "" when the description publishes nothing address-shaped — this is
 *  a reader of first-party text, never an inference. */
export function extractPublishedAddress(text) {
  const flat = String(text ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
  const m = flat.match(STREET_ADDRESS_PATTERN);
  if (!m) return "";
  return tidy(m[1]).replace(/\s*,\s*/g, ", ");
}

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
 * @param {object} [context]     the event's own first-party text
 *   ({ title, description }). Only consulted for a bare "Offsite" location,
 *   where the structured field says "not here" without saying where.
 * @returns {{kind: "onsite"|"online"|"offsite"|"offsite-unnamed"|"unknown"|
 *   "bookmobile", location: string, venue: string, address: string,
 *   virtual: boolean, suppress?: boolean}}
 */
export function classifyLibCalLocation(rawLocation, library = {}, context = {}) {
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

  // "Offsite" states a fact about where the event is NOT. Resolve it from the
  // event's own text, or suppress it — never label it with the host building.
  if (OFFSITE_UNNAMED_PATTERN.test(location)) {
    return resolveUnnamedOffsite(location, library, context);
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

/**
 * Resolve a bare "Offsite" location from the event's own first-party text.
 *
 * Two tiers, both first-party, neither a guess:
 *   1. The library's verified `offsiteAddresses` map. A hit means a human has
 *      already confirmed the place and its street address. The longest key
 *      wins so "Magical Bridge Playground" beats the "Rengstorff Park" it
 *      sits inside, and the match is deterministic.
 *   2. A street address the description itself publishes. The venue label is
 *      then that street line — truthful and mappable, and above all not the
 *      library.
 *
 * Neither → `suppress`. The caller drops the event. A reader missing one
 * storytime is a smaller harm than a reader driving to the wrong building,
 * and the refresh logs the suppression so the map can be extended.
 */
function resolveUnnamedOffsite(location, library, context) {
  const haystack = `${context.title || ""} \n ${context.description || ""}`
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");

  const verified = library.offsiteAddresses || {};
  const key = Object.keys(verified)
    .filter((k) => {
      const name = tidy(k);
      if (!name) return false;
      return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(haystack);
    })
    .sort((a, b) => b.length - a.length)[0];

  if (key) {
    return {
      kind: "offsite-unnamed",
      location,
      venue: tidy(key),
      address: verified[key] || "",
      virtual: false,
    };
  }

  const published = extractPublishedAddress(haystack);
  if (published) {
    // "615 Cuesta Drive, Mountain View, CA 94040" → venue "615 Cuesta Drive".
    const street = published.split(",")[0].trim();
    return {
      kind: "offsite-unnamed",
      location,
      venue: street || published,
      address: published,
      virtual: false,
    };
  }

  return {
    kind: "offsite-unnamed",
    location,
    venue: "",
    address: "",
    virtual: false,
    suppress: true,
  };
}
