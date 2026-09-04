// ---------------------------------------------------------------------------
// event-city — pick the city slug an event actually happens in.
//
// Every event source names a city twice and the two can disagree. One is the
// publisher: the newsletter's sending organization, the library that runs the
// program, the box office that sells the ticket. The other is the address the
// listing carries. When a program is held off the publisher's own premises,
// only the second one is where the reader has to drive.
//
// This started as `resolveInboundCity` inside the newsletter normalizer,
// because that was the first pipeline where the split showed up (the Campbell
// Chamber's golf tournament is played in south San Jose). It moved here on
// 2026-09-04 because the scraped pipeline has exactly the same split and was
// getting it wrong on the same kind of event:
//
//   "SJSU Choirs: Fall Debut Choral Concert"  → Campbell United Methodist
//   "SJSU Choirs: Home for the Holidays"      → Mission Santa Clara de Asis
//   "Deer Hollow Spooky Storytime"            → Deer Hollow Farm, Cupertino
//
// The first two are sold through the Hammer Theatre's box office and shipped
// tagged san-jose; the third is a Mountain View library program held at Rancho
// San Antonio and shipped tagged mountain-view. All three were invisible on the
// city tab a reader would actually filter to.
//
// Nothing here guesses. The address only wins when it names exactly one covered
// city; every ambiguous case keeps the publisher's answer.
// ---------------------------------------------------------------------------

import { LOCAL_DEPARTURE_TRIP } from "../../src/lib/south-bay/eventFilters.mjs";
import { SLUG_TO_CITY_TOKENS } from "../social/lib/content-rules.mjs";

function deaccent(value) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// The 11 real city slugs an event can be re-homed to. Deliberately excludes the
// curated catch-alls in SLUG_TO_CITY_TOKENS ("santa-clara-county",
// "santa-cruz") — those are hand-picked landmark buckets, not somewhere an
// address should silently reassign an event to.
const REHOMEABLE_CITY_SLUGS = new Set([
  "campbell", "cupertino", "los-altos", "los-gatos", "milpitas",
  "mountain-view", "palo-alto", "san-jose", "santa-clara", "saratoga",
  "sunnyvale",
]);

const CITY_TOKEN_ALTERNATION = [
  ...new Set(
    [...REHOMEABLE_CITY_SLUGS].flatMap((slug) => SLUG_TO_CITY_TOKENS[slug] || []),
  ),
]
  .map((t) => deaccent(t))
  .join("|");

const STREET_SUFFIXES =
  "st|street|ave|avenue|rd|road|blvd|boulevard|way|ln|lane|dr|drive|ct|court|pl|place|pkwy|parkway|cir|circle|ter|terrace|hwy|highway|expy|expressway";

/** e.g. "Santa Clara St.", "Los Gatos Blvd", "Saratoga Avenue". */
const STREET_NAMED_FOR_CITY = new RegExp(
  `\\b(?:${CITY_TOKEN_ALTERNATION})\\s+(?:${STREET_SUFFIXES})\\b\\.?`,
  "gi",
);

/**
 * Same street-name problem, but with the suffix truncated off.
 *
 * Ticketmaster publishes SAP Center's address as "525 W Santa Clara" — no
 * "St", so STREET_NAMED_FOR_CITY can't see it, and the bare "Santa Clara"
 * that survives reads as a city. Seven Sharks games and concerts would have
 * moved to the santa-clara tab on that string alone.
 *
 * A house number followed by a directional prefix and a city name is a street,
 * not a city: nobody writes an address as "525 W Santa Clara, CA". Requiring
 * both the number and the direction keeps this from touching real city
 * mentions — "200 E. Santa Clara St., San José" still resolves to San José,
 * because the trailing city has neither in front of it.
 */
const TRUNCATED_CITY_STREET = new RegExp(
  `\\b\\d+\\s+(?:[nsew]|north|south|east|west)\\.?\\s+(?:${CITY_TOKEN_ALTERNATION})\\b`,
  "gi",
);

/**
 * Landmark venues whose city is a matter of public record, checked against the
 * raw location string before the city-token count in resolveEventCity.
 *
 * Deliberately short: only venues that sit in one fixed spot AND get written
 * with the wrong city by senders, usually because the team or tenant is branded
 * for a neighbouring city (the San Jose Earthquakes and the San Francisco 49ers
 * both play in Santa Clara). Do not add ordinary venues here — the address is
 * the better signal everywhere else, which is the whole point of the function.
 */
const FIXED_VENUE_CITY = [
  [/\blevi'?s\s+stadium\b/i, "santa-clara"],
  [/\bsap\s+center\b/i, "san-jose"],
  [/\bpaypal\s+park\b/i, "san-jose"],
  [/\bexcite\s+ballpark\b/i, "san-jose"],
  [/\bshoreline\s+amphitheatre\b/i, "mountain-view"],
  [/\bmountain\s+winery\b/i, "saratoga"],
];

/**
 * Pick the city slug an event actually happens in.
 *
 * The publisher's city is the starting point and the address is the check on
 * it, because the address is where a reader has to drive. If the location names
 * exactly one covered city, that city wins. Anything ambiguous keeps the
 * publisher's answer:
 *   - no covered city named (bare venue, bare street) → keep cityKey
 *   - two or more named ("Los Gatos Blvd, San Jose") → keep cityKey
 *   - cityKey isn't one of the 11 mapped slugs (e.g. "monte-sereno", which
 *     shares tokens with los-gatos) → keep cityKey
 *   - the title is a day trip → keep cityKey, since those belong under the
 *     departure city, not the destination (see LOCAL_DEPARTURE_TRIP)
 *
 * `location` should carry the venue name as well as the street address —
 * FIXED_VENUE_CITY is matched against it, and a venue name is often the only
 * unambiguous part of a truncated listing.
 */
export function resolveEventCity(cityKey, location, title = "") {
  if (!cityKey || !REHOMEABLE_CITY_SLUGS.has(cityKey)) return cityKey;
  if (!location) return cityKey;
  if (LOCAL_DEPARTURE_TRIP.test(title || "")) return cityKey;

  // A named venue that only exists in one place outranks the city token in the
  // address, because the address is the part senders get wrong. The Earthquakes'
  // own mailing list sent "Levi's Stadium, San Jose, CA" for the Sep 19 LAFC
  // match — the stadium is in Santa Clara, and every other feed had it right, so
  // the one bad string split a single game across two city tabs.
  for (const [re, slug] of FIXED_VENUE_CITY) {
    if (re.test(location)) return slug;
  }

  // Strip diacritics on both sides: the token list carries "san josé", and
  // /\bsan josé\b/ never matches "San José," because é isn't a word character,
  // so the trailing \b lands between two non-word characters.
  let hay = deaccent(location.toLowerCase());
  // "Santa Clara County" would otherwise read as a Santa Clara address.
  hay = hay.replace(/santa clara county/g, " ");
  // South Bay streets are named after South Bay cities. San José City Hall sits
  // on E. Santa Clara St; a Campbell storefront can have a Los Gatos Blvd
  // address. A city name carrying a street suffix is part of the street, not
  // the city, so drop those before counting.
  hay = hay.replace(STREET_NAMED_FOR_CITY, " ");
  hay = hay.replace(TRUNCATED_CITY_STREET, " ");

  const matches = [];
  for (const slug of REHOMEABLE_CITY_SLUGS) {
    const tokens = SLUG_TO_CITY_TOKENS[slug] || [];
    if (tokens.some((t) => new RegExp(`\\b${deaccent(t)}\\b`, "i").test(hay))) matches.push(slug);
  }
  if (matches.length !== 1) return cityKey;
  return matches[0];
}

/**
 * Re-home a scraped event when its own listing puts it in a different covered
 * city than the source's home city.
 *
 * Scrapers hardcode `city` to the publisher — that is right for the ordinary
 * case and wrong for every off-site booking. The event's `venue` and `address`
 * come from the listing itself, so when they agree on one covered city that
 * isn't the hardcoded one, the listing wins. Returns the event unchanged
 * (same object) when nothing moves.
 */
export function rehomeScrapedEvent(event) {
  if (!event || !event.city) return event;
  const location = [event.venue, event.address].filter(Boolean).join(", ");
  const city = resolveEventCity(event.city, location, event.title || "");
  return city === event.city ? event : { ...event, city };
}
