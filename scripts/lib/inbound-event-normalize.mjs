import { isTrackerUrl } from "../../src/lib/south-bay/unwrapTrackerUrl.mjs";

const PT = "America/Los_Angeles";

export const JEREMY_FREY_EXHIBITION_URL = "https://museum.stanford.edu/exhibitions/jeremy-frey-woven-0";
export const PAPAHUGS_OCCURRENCE_URL = "https://www.cdm.org/event/papahugs/";
// JAMsj publishes tinyurl.com/jamsj-sjgiants for this sales group; unwrap resolves here.
export const SJ_GIANTS_JAPANESE_HERITAGE_2026_07_26_URL =
  "https://mlb.tickets.com/schedule/?agency=MILB_MPV&orgid=56749#/sales_group_code;salesGroupId=13349";

// Some newsletter trackers can't be unwrapped — Books Inc.'s Adestra links
// (l.e.booksinc.com/rts/go2.aspx) serve a 200 instead of redirecting once the
// blast expires, so unwrapMany caches them as identity and the raw wrapper
// would otherwise be published. A wrapper URL is worse than none: it's a dead
// link that also carries the per-subscriber id from our own newsletter
// signup. Fall back to the venue's own events page where we know one — these
// are the same canonical URLs our first-party scrapers already use.
const TRACKER_FALLBACKS = [
  { match: /\bbooksinc\.com\b/i, url: "https://www.booksinc.com/pages/events" },
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
  return null;
}

export function normalizeInboundEventPresentation(event) {
  const override = officialOverride(event);
  const time = override?.time || inboundClock(event?.startsAt);
  const parsedEndTime = inboundClock(event?.endsAt);
  const endTime = override?.endTime || (parsedEndTime && parsedEndTime !== time ? parsedEndTime : null);
  return {
    time,
    endTime,
    url: override?.url || detrack(event?.canonicalUrl) || detrack(event?.sourceUrl) || "",
  };
}
