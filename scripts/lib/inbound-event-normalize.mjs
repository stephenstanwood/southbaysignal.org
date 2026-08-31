import { isTrackerUrl } from "../../src/lib/south-bay/unwrapTrackerUrl.mjs";
import { LOCAL_DEPARTURE_TRIP } from "../../src/lib/south-bay/eventFilters.mjs";
import { SLUG_TO_CITY_TOKENS } from "../social/lib/content-rules.mjs";

const PT = "America/Los_Angeles";

export const JEREMY_FREY_EXHIBITION_URL = "https://museum.stanford.edu/exhibitions/jeremy-frey-woven-0";
export const PAPAHUGS_OCCURRENCE_URL = "https://www.cdm.org/event/papahugs/";
// JAMsj publishes tinyurl.com/jamsj-sjgiants for this sales group; unwrap resolves here.
export const SJ_GIANTS_JAPANESE_HERITAGE_2026_07_26_URL =
  "https://mlb.tickets.com/schedule/?agency=MILB_MPV&orgid=56749#/sales_group_code;salesGroupId=13349";
// Levi's Stadium sends every link through ls.49ers.com, whose whole path is one
// opaque per-send token. The stadium's own event index is the durable stand-in.
export const LEVIS_STADIUM_EVENTS_URL = "https://levisstadium.com/events/";
// The R&B Tour — Levi's Stadium, Aug 28 / Aug 29 / Sep 1 2026. Three separate
// newsletters described these shows and all three start times were wrong:
// the 49ers' April "ON SALE NOW" blast carried no showtime at all (the
// extractor invented 12:00/2:00/4:00 PM across the three dates), and Santa
// Clara's traffic advisory says "gates opening at 6:00 PM" — a gates time,
// not a curtain. Ticketmaster and Live Nation list all three at 7:00 PM.
export const RANDB_TOUR_2026_URL = "https://levisstadium.com/event/chris-brown-usher-the-randb-tour/";
const RANDB_TOUR_2026_DATES = new Set(["2026-08-28", "2026-08-29", "2026-09-01"]);
export const SILICON_VALLEY_PRIDE_2026_URL = "https://www.svpride.com/parade";

// Some newsletter trackers can't be unwrapped — Books Inc.'s Adestra links
// (l.e.booksinc.com/rts/go2.aspx) serve a 200 instead of redirecting once the
// blast expires, so unwrapMany caches them as identity and the raw wrapper
// would otherwise be published. A wrapper URL is worse than none: it's a dead
// link that also carries the per-subscriber id from our own newsletter
// signup. Fall back to the venue's own events page where we know one — these
// are the same canonical URLs our first-party scrapers already use.
const TRACKER_FALLBACKS = [
  { match: /\bbooksinc\.com\b/i, url: "https://www.booksinc.com/pages/events" },
  { match: /\bls\.49ers\.com\b/i, url: LEVIS_STADIUM_EVENTS_URL },
];

function detrack(url) {
  if (!url || !isTrackerUrl(url)) return url;
  const fallback = TRACKER_FALLBACKS.find((f) => f.match.test(url));
  return fallback ? fallback.url : "";
}

export function inboundClock(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const detailed = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: PT,
  }).replace(/\s+/g, " ");
  if (detailed === "12:00:00 AM" || detailed === "11:59:59 PM") return null;
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: PT,
  }).replace(/\s+/g, " ");
}

function officialOverride(event) {
  const date = String(event?.startsAt || "").slice(0, 10);
  const identity = `${event?.title || ""} ${event?.location || ""}`;
  if (date === "2026-07-20" && /jeremy\s+frey\s*:\s*woven/i.test(identity) && /cantor arts center/i.test(identity)) {
    return {
      url: JEREMY_FREY_EXHIBITION_URL,
      time: "11:00 AM",
      endTime: "6:00 PM",
    };
  }
  if (
    date === "2026-07-22"
    && /(?:david\s+)?papahugs(?:\s+sharpe)?/i.test(identity)
    && /(?:children'?s discovery museum|180\s+woz way)/i.test(identity)
  ) {
    return {
      url: PAPAHUGS_OCCURRENCE_URL,
      time: "11:00 AM",
      endTime: "11:45 AM",
    };
  }
  if (
    RANDB_TOUR_2026_DATES.has(date)
    && /levi'?s\s+stadium/i.test(identity)
    && /usher/i.test(identity)
    && /chris\s+brown/i.test(identity)
  ) {
    return {
      url: RANDB_TOUR_2026_URL,
      time: "7:00 PM",
      endTime: null,
    };
  }
  if (
    date === "2026-07-26"
    && /san\s+jose\s+giants.*japanese\s+heritage|japanese\s+heritage.*san\s+jose\s+giants/i.test(identity)
    && /excite\s+ballpark/i.test(identity)
  ) {
    return {
      url: SJ_GIANTS_JAPANESE_HERITAGE_2026_07_26_URL,
      time: "5:00 PM",
      endTime: null,
    };
  }
  if (date === "2026-08-30" && /silicon\s+valley\s+pride\s+parade/i.test(identity)) {
    return {
      url: SILICON_VALLEY_PRIDE_2026_URL,
      time: "11:00 AM",
      endTime: "12:30 PM",
      venue: "Downtown San Jose — Julian Street & Market Street to Plaza Park",
    };
  }
  return null;
}

function deaccent(value) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// The 11 real city slugs the inbound feed can be re-homed to. Deliberately
// excludes the curated catch-alls in SLUG_TO_CITY_TOKENS ("santa-clara-county",
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
 * Landmark venues whose city is a matter of public record, checked against the
 * raw location string before the city-token count in resolveInboundCity.
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
 * Pick the city slug an inbound newsletter event actually happens in.
 *
 * The email extractor sets cityKey from the sending organization, not the
 * venue, so the Campbell Chamber's annual golf tournament — played at Cinnabar
 * Hills Golf Club on McKean Road in south San Jose — arrives tagged "campbell".
 * Worse, it isn't stable: that one tournament came in 14 times across three
 * months of chamber blasts, 4 of them "campbell" and 10 "san-jose", so which
 * city tab it landed on came down to which copy happened to survive dedup.
 *
 * The address is the better signal, because it's where a reader has to drive.
 * If it names exactly one covered city, that city wins. Anything ambiguous
 * keeps the extractor's answer:
 *   - no covered city named (bare venue, bare street) → keep cityKey
 *   - two or more named ("Los Gatos Blvd, San Jose") → keep cityKey
 *   - cityKey isn't one of the 11 mapped slugs (e.g. "monte-sereno", which
 *     shares tokens with los-gatos) → keep cityKey
 *   - the title is a day trip → keep cityKey, since those belong under the
 *     departure city, not the destination (see LOCAL_DEPARTURE_TRIP)
 */
export function resolveInboundCity(cityKey, location, title = "") {
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

  const matches = [];
  for (const slug of REHOMEABLE_CITY_SLUGS) {
    const tokens = SLUG_TO_CITY_TOKENS[slug] || [];
    if (tokens.some((t) => new RegExp(`\\b${deaccent(t)}\\b`, "i").test(hay))) matches.push(slug);
  }
  if (matches.length !== 1) return cityKey;
  return matches[0];
}

// Longest run we'll read as a single sitting. Past this, an `endsAt` is
// describing something other than when the doors close.
const MAX_INBOUND_SPAN_MS = 12 * 60 * 60 * 1000;

/**
 * True when `endsAt` can be read as a closing time for `startsAt`.
 *
 * Newsletters use `endsAt` for two different things. Sometimes it's a real end
 * time; sometimes it's the last date of a multi-week program, and rendering
 * that as a clock time produces nonsense. Monte Sereno's Community Police
 * Academy runs eight weeks — startsAt Sep 17, endsAt Nov 12, the graduation —
 * and the card read "9:00 AM – 11:00 PM".
 *
 * That 11 PM is also a DST artifact worth knowing about: the extractor stamped
 * the November date with the July offset (`2026-11-12T00:00:00-07:00`), and
 * -07:00 in November is 11 PM the previous evening in Pacific time, so
 * inboundClock's midnight sentinel never saw a midnight to reject. Comparing
 * the two instants catches it without having to trust the offset.
 */
function endsAtLooksLikeAClosingTime(startsAt, endsAt) {
  const start = new Date(startsAt ?? "");
  const end = new Date(endsAt ?? "");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  const span = end.getTime() - start.getTime();
  return span > 0 && span <= MAX_INBOUND_SPAN_MS;
}

export function normalizeInboundEventPresentation(event) {
  const override = officialOverride(event);
  const time = override?.time || inboundClock(event?.startsAt);
  const parsedEndTime = endsAtLooksLikeAClosingTime(event?.startsAt, event?.endsAt)
    ? inboundClock(event?.endsAt)
    : null;
  const endTime = override?.endTime || (parsedEndTime && parsedEndTime !== time ? parsedEndTime : null);
  return {
    time,
    endTime,
    url: override?.url || detrack(event?.canonicalUrl) || detrack(event?.sourceUrl) || "",
    ...(override?.venue ? { venue: override.venue } : {}),
  };
}
