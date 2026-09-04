import { isTrackerUrl } from "../../src/lib/south-bay/unwrapTrackerUrl.mjs";

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
