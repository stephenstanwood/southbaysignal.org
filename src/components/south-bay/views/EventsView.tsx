import { useState, useMemo, useEffect } from "react";
import type { City } from "../../../lib/south-bay/types";
import {
  EVENT_CATEGORIES,
  type EventCategory,
} from "../../../data/south-bay/events-data";
import schoolCalendarJson from "../../../data/south-bay/school-calendar.json";
import {
  holidayOn,
  holidaySpanIsos,
  holidayClosureSummary,
  matchesHolidayTheme,
  nextHolidayWithin,
  NAMED_HOLIDAYS,
} from "../../../lib/south-bay/holidays";
import { currentHeritageMonths, matchesHeritage, type HeritageMonth } from "../../../lib/south-bay/heritageMonths";
import { buildGoogleCalendarUrl } from "../../../lib/south-bay/calendarLink";
import { isVirtualEvent, registrationLabel } from "../../../lib/south-bay/eventFilters.mjs";
import { cleanDisplayCopy, cleanDisplayName } from "../../../lib/south-bay/displayText.mjs";
import PageHero from "../PageHero";

const CITIES: { id: City; name: string }[] = [
  { id: "san-jose", name: "San José" },
  { id: "santa-clara", name: "Santa Clara" },
  { id: "sunnyvale", name: "Sunnyvale" },
  { id: "mountain-view", name: "Mountain View" },
  { id: "palo-alto", name: "Palo Alto" },
  { id: "los-altos", name: "Los Altos" },
  { id: "cupertino", name: "Cupertino" },
  { id: "saratoga", name: "Saratoga" },
  { id: "los-gatos", name: "Los Gatos" },
  { id: "campbell", name: "Campbell" },
  { id: "milpitas", name: "Milpitas" },
  { id: "santa-cruz", name: "Santa Cruz" },
];

const CITY_LABELS: Record<string, string> = {
  "san-jose": "San José", "campbell": "Campbell", "los-gatos": "Los Gatos",
  "saratoga": "Saratoga", "cupertino": "Cupertino", "santa-clara": "Santa Clara",
  "sunnyvale": "Sunnyvale", "mountain-view": "Mountain View", "palo-alto": "Palo Alto",
  "milpitas": "Milpitas", "los-altos": "Los Altos", "santa-cruz": "Santa Cruz",
};

/** Prepend city name to government meeting titles that don't already include it */
function meetingDisplayTitle(title: string, city: string): string {
  const MEETING_PATTERNS = [
    /planning commission/i, /city council/i, /town council/i,
    /board of supervisors/i, /design review/i, /parks commission/i,
    /transportation commission/i, /zoning/i, /committee meeting/i,
    /study session/i, /special meeting/i, /commission meeting/i,
    /board meeting/i, /public hearing/i,
  ];
  const cityName = city.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
  const isMeeting = MEETING_PATTERNS.some(p => p.test(title));
  if (!isMeeting) return title;
  if (title.toLowerCase().includes(cityName.toLowerCase())) return title;
  return `${cityName}: ${title}`;
}

interface Props {
  selectedCities: Set<City>;
  onToggleCity: (city: City) => void;
  onToggleAllCities: () => void;
}

interface UpcomingEvent {
  id: string;
  title: string;
  date: string;
  displayDate: string;
  time: string | null;
  endTime: string | null;
  venue: string;
  address: string;
  city: string;
  category: string;
  cost: string;
  description: string;
  url: string;
  source: string;
  kidFriendly: boolean;
  ongoing?: boolean;
  virtual?: boolean;
  blurb?: string;
  image?: string | null;
  photoRef?: string | null;
  firstSeenAt?: string;
}

// ── Time helpers ───────────────────────────────────────────────────────────

// Normalize varied scraper outputs to canonical "8:00 PM" form. Inputs we see
// in the data: "8PM" → "8:00 PM", "10:30AM" → "10:30 AM", "9:30 AM" → unchanged.
function normalizeClockTime(t: string | null | undefined): string | null {
  if (!t) return null;
  const m = String(t).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (!m) return t;
  const hour = parseInt(m[1], 10);
  const min = m[2] ?? "00";
  const period = m[3].toUpperCase();
  return `${hour}:${min} ${period}`;
}

function formatTimeRange(timeIn: string | null, endTimeIn: string | null, isSports = false): string | null {
  const time = normalizeClockTime(timeIn);
  const endTime = normalizeClockTime(endTimeIn);
  if (!time) return null;
  if (!endTime || isSports) return time;
  const startPeriod = time.match(/(am|pm)$/i)?.[1]?.toUpperCase();
  const endPeriod = endTime.match(/(am|pm)$/i)?.[1]?.toUpperCase();
  if (startPeriod && endPeriod && startPeriod === endPeriod) {
    return `${time.replace(/\s*(am|pm)$/i, "")}–${endTime}`;
  }
  return `${time}–${endTime}`;
}

const NOW_MINUTES = (() => {
  const n = new Date();
  const nPT = new Date(n.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  return nPT.getHours() * 60 + nPT.getMinutes();
})();

function hasNotStarted(time: string | null): boolean {
  if (!time) return true;
  const mins = parseTimeToMinutes(time);
  if (mins === null) return true;
  return mins > NOW_MINUTES;
}

// Newly-scraped events get a "JUST ADDED" badge for this many hours after
// their first sighting (tracked in event-first-seen-cache.json at ingest).
// Long enough that someone checking once a day will still catch it; short
// enough that it doesn't become wallpaper.
const JUST_ADDED_WINDOW_HOURS = 72;
function isJustAdded(firstSeenAt: string | null | undefined): boolean {
  if (!firstSeenAt) return false;
  const ts = new Date(firstSeenAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) <= JUST_ADDED_WINDOW_HOURS * 3600_000;
}

// "Happening now": started, not yet ended. For events with no endTime, fall
// back to a 2-hour fuzzy window (a typical performance/talk window).
const FUZZY_DURATION_MIN = 120;
function isInProgressNow(time: string | null, endTime: string | null): boolean {
  if (!time) return false;
  const start = parseTimeToMinutes(time);
  if (start === null) return false;
  if (start > NOW_MINUTES) return false;
  const end = endTime ? parseTimeToMinutes(endTime) : null;
  if (end !== null) return NOW_MINUTES < end;
  return NOW_MINUTES - start <= FUZZY_DURATION_MIN;
}

// Live PT minutes — re-renders the page each minute so "starts in N min"
// pills stay accurate when a tab is left open.
function ptMinutesNow(): number {
  const n = new Date();
  const nPT = new Date(n.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  return nPT.getHours() * 60 + nPT.getMinutes();
}
function useNowMinutes(): number {
  const [mins, setMins] = useState<number>(() => ptMinutesNow());
  useEffect(() => {
    const id = setInterval(() => setMins(ptMinutesNow()), 60_000);
    return () => clearInterval(id);
  }, []);
  return mins;
}

// Urgency pill — only fires for events on today's date.
// • In progress → "HAPPENING NOW" (red)
// • Starts in 0–15 min → "STARTS IN N MIN" (orange, urgent)
// • Starts in 16–60 min → "STARTS IN N MIN" (amber, soon)
type UrgencyTag = { label: string; bg: string; fg: string; border: string; pulse: boolean };
function urgencyPill(
  date: string,
  time: string | null,
  endTime: string | null,
  todayIso: string,
  nowMins: number,
): UrgencyTag | null {
  if (date !== todayIso) return null;
  if (!time) return null;
  const start = parseTimeToMinutes(time);
  if (start === null) return null;
  const end = endTime ? parseTimeToMinutes(endTime) : null;
  // In-progress?
  if (start <= nowMins) {
    const stillRunning = end !== null ? nowMins < end : (nowMins - start) <= FUZZY_DURATION_MIN;
    if (!stillRunning) return null;
    return { label: "HAPPENING NOW", bg: "#FEF2F2", fg: "#B91C1C", border: "#FECACA", pulse: true };
  }
  const delta = start - nowMins;
  if (delta > 60) return null;
  const label = delta <= 1 ? "STARTING NOW" : `STARTS IN ${delta} MIN`;
  if (delta <= 15) {
    return { label, bg: "#FFF7ED", fg: "#C2410C", border: "#FED7AA", pulse: false };
  }
  return { label, bg: "#FFFBEB", fg: "#A16207", border: "#FDE68A", pulse: false };
}

function parseTimeToMinutes(t: string): number | null {
  const parts = t.split(/,/);
  const target = parts[parts.length - 1].trim();
  const m = target.match(/^(\d+)(?::(\d+))?\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2] ?? "0");
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && h !== 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return h * 60 + min;
}

// ── Cost badge ─────────────────────────────────────────────────────────────

function costBadge(cost: string): { label: string; bg: string; fg: string; border: string } {
  if (cost === "free") return { label: "FREE", bg: "#F0FDF4", fg: "#166534", border: "#BBF7D0" };
  if (cost === "low") return { label: "$", bg: "#FFF7ED", fg: "#92400E", border: "#FDE68A" };
  return { label: "$$", bg: "#F5F3FF", fg: "#5B21B6", border: "#DDD6FE" };
}

function cityLabel(city: string) {
  return CITY_LABELS[city] ?? city.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// ── Category accent colors ─────────────────────────────────────────────────

const CATEGORY_ACCENT: Record<string, { color: string; bg: string; label: string; emoji: string }> = {
  music:     { color: "#7C3AED", bg: "#F5F3FF", label: "Music",     emoji: "🎵" },
  arts:      { color: "#0E7490", bg: "#ECFEFF", label: "Arts",      emoji: "🎨" },
  family:    { color: "#C2410C", bg: "#FFF7ED", label: "Family",    emoji: "👨‍👩‍👦" },
  education: { color: "#1D4ED8", bg: "#EFF6FF", label: "Education", emoji: "📚" },
  community: { color: "#475569", bg: "#F8FAFC", label: "Community", emoji: "🤝" },
  market:    { color: "#15803D", bg: "#F0FDF4", label: "Market",    emoji: "🌽" },
  food:      { color: "#B45309", bg: "#FFFBEB", label: "Food",      emoji: "🍜" },
  outdoor:   { color: "#166534", bg: "#F0FDF4", label: "Outdoor",   emoji: "🌿" },
  sports:    { color: "#1E3A8A", bg: "#EFF6FF", label: "Sports",    emoji: "🏟️" },
};

function eventTextBlob(event: UpcomingEvent): string {
  return `${event.title || ""} ${event.blurb || ""} ${event.description || ""} ${event.venue || ""}`.toLowerCase();
}

function isOngoingExhibitEvent(event: UpcomingEvent): boolean {
  const text = eventTextBlob(event);
  if (/\b(yoga|pilates|meditation|mindfulness|workshop|training|class|course|rounds?|speaker series|guest speaker|worship|service|volunteer|volunteering|al-anon|qualtrics|upstander|storytime)\b/.test(text)) {
    return false;
  }
  return /\b(exhibit|exhibition|showcase|installation|on view|gallery|art\s+show|book display|map exhibit|sculpture walk|works by|mfa thesis|archive room|collection|artist|artwork|sculpture|painting|photography|printmaker|contemporary art|art and architecture)\b/.test(text);
}

function normalizedEventCategory(event: UpcomingEvent): string {
  const text = eventTextBlob(event);
  if (isOngoingExhibitEvent(event)) return "arts";
  if (/\b(yoga|pilates|meditation|mindfulness|wellness|al-anon|worship|volunteer|volunteering)\b/.test(text)) return "community";
  if (/\b(guest speaker|speaker series|lecture|symposium|workshop|training|class|course|rounds?|seminar|qualtrics|research|science|reading)\b/.test(text)) return "education";
  if (/\b(concert|carillon|recital|choir|orchestra|jazz|music)\b/.test(String(event.title || "").toLowerCase())) return "music";
  return event.category || "community";
}

function normalizeEventForDisplay(event: UpcomingEvent): UpcomingEvent {
  const category = normalizedEventCategory(event);
  return category === event.category ? event : { ...event, category };
}

// ── Date helpers ───────────────────────────────────────────────────────────

function todayPT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
}

function dayLabel(iso: string, todayIso: string, tomorrowIso: string): { primary: string; secondary: string } {
  const d = new Date(iso + "T12:00:00");
  const dateStr = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  if (iso === todayIso) return { primary: "TODAY", secondary: dateStr };
  if (iso === tomorrowIso) return { primary: "TOMORROW", secondary: dateStr };
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase();
  const monthDay = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return { primary: weekday, secondary: monthDay };
}

function shortDateLabel(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// Returns [saturdayIso, sundayIso] for "this weekend" relative to today.
// Sat: today + tomorrow. Sun: yesterday + today (today only, since past events
// hide via hasNotStarted). Mon–Fri: upcoming Sat + Sun.
function thisWeekendDates(todayIso: string): [string, string] {
  const dow = new Date(todayIso + "T12:00:00").getDay(); // 0=Sun … 6=Sat
  if (dow === 6) return [todayIso, addDays(todayIso, 1)];
  if (dow === 0) return [addDays(todayIso, -1), todayIso];
  const sat = addDays(todayIso, 6 - dow);
  return [sat, addDays(sat, 1)];
}

// ── Recurring detection ────────────────────────────────────────────────────
// "Live Music @ San Pedro Square" appears 48× across the dataset; "LEGO
// Tuesdays! @ Downtown Library" appears 25×, all on Tuesdays. Knowing an
// event is a weekly fixture changes the decision: "I missed it Saturday"
// becomes "I'll catch it next week." We detect this purely from the data
// (no scraper change required) and surface a small "Every Tue" / "Recurring"
// badge in the meta row.

interface RecurringInfo {
  /** Display label: "Every Tue", "Mon & Wed", "Most days", or "Recurring". */
  label: string;
  /** Distinct upcoming dates in this series. */
  count: number;
}

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function dowFromIso(iso: string): number | null {
  const d = new Date(iso + "T12:00:00");
  const n = d.getDay();
  return Number.isFinite(n) ? n : null;
}

function recurringKey(title: string, venue: string | null | undefined): string {
  return `${(title || "").trim().toLowerCase()}|${(venue || "").trim().toLowerCase()}`;
}

function computeRecurringMap(events: UpcomingEvent[]): Map<string, RecurringInfo> {
  const dateSets = new Map<string, Set<string>>();
  for (const e of events) {
    if (!e.title || !e.date) continue;
    if (e.ongoing && !e.time) continue; // exhibits aren't recurring weeklies
    const key = recurringKey(e.title, e.venue);
    if (!dateSets.has(key)) dateSets.set(key, new Set());
    dateSets.get(key)!.add(e.date);
  }
  const out = new Map<string, RecurringInfo>();
  for (const [key, dates] of dateSets) {
    if (dates.size < 3) continue;
    const dows = [0, 0, 0, 0, 0, 0, 0];
    for (const iso of dates) {
      const d = dowFromIso(iso);
      if (d !== null) dows[d]++;
    }
    const total = dows.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    const ranked = dows
      .map((c, i) => ({ c, i }))
      .filter((x) => x.c > 0)
      .sort((a, b) => b.c - a.c);
    const top = ranked[0];
    let label: string;
    if (top.c / total >= 0.7) {
      label = `Every ${DOW_SHORT[top.i]}`;
    } else if (ranked.length >= 2 && (ranked[0].c + ranked[1].c) / total >= 0.85) {
      label = `${DOW_SHORT[ranked[0].i]} & ${DOW_SHORT[ranked[1].i]}`;
    } else if (ranked.length >= 4) {
      label = "Most days";
    } else {
      label = "Recurring";
    }
    out.set(key, { label, count: dates.size });
  }
  return out;
}

// ── Event Card ─────────────────────────────────────────────────────────────

function eventPhotoUrl(event: UpcomingEvent, w = 160, h = 160): string | null {
  if (event.image) return event.image;
  if (event.photoRef) return `/api/place-photo?ref=${encodeURIComponent(event.photoRef)}&w=${w}&h=${h}`;
  return null;
}

function UpcomingEventCard({
  event,
  showDate,
  recurring,
  todayIso,
  nowMins,
}: {
  event: UpcomingEvent;
  showDate?: boolean;
  recurring?: RecurringInfo | null;
  todayIso: string;
  nowMins: number;
}) {
  const badge = costBadge(event.cost);
  const showBadge = !(event.cost === "free" && event.category === "community");
  const accent = CATEGORY_ACCENT[event.category] ?? CATEGORY_ACCENT.community;
  const photo = eventPhotoUrl(event, 200, 200);
  const [photoFailed, setPhotoFailed] = useState(false);
  const body = cleanDisplayCopy((event.blurb && event.blurb.trim()) ? event.blurb : event.description);
  const urgency = urgencyPill(event.date, event.time, event.endTime, todayIso, nowMins);
  const title = cleanDisplayName(meetingDisplayTitle(event.title, event.city));
  const venue = cleanDisplayName(event.venue);

  return (
    <div
      className="sb-event-card"
      style={{
        "--event-accent": accent.color,
        "--event-accent-bg": accent.bg,
      } as React.CSSProperties}
    >
      {photo && !photoFailed ? (
        <img
          className="sb-event-card-photo"
          src={photo}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setPhotoFailed(true)}
        />
      ) : (
        <div className="sb-event-card-photo sb-event-card-photo--fallback" aria-hidden>
          {accent.emoji}
        </div>
      )}

      <div className="sb-event-card-body">
        <div className="sb-event-card-kicker">
          <span style={{ color: accent.color }}>
            {accent.label}
          </span>
          {showBadge && (
            <span className="sb-event-micro-badge" style={{ background: badge.bg, color: badge.fg, borderColor: badge.border }}>
              {badge.label}
            </span>
          )}
          {event.kidFriendly && (
            <span className="sb-event-micro-badge" style={{ background: "#FFF7ED", color: "#C2410C", borderColor: "#FED7AA" }}>
              Kids
            </span>
          )}
          {isVirtualEvent(event) && (
            <span
              className="sb-event-micro-badge"
              title="Online only — there is no in-person location"
              style={{ background: "#EFF6FF", color: "#1D4ED8", borderColor: "#BFDBFE" }}
            >
              Virtual
            </span>
          )}
          {registrationLabel(event) && (
            <span
              className="sb-event-micro-badge"
              title="You cannot just turn up — this event needs a booking or registration in advance"
              style={{ background: "#FEF3C7", color: "#92400E", borderColor: "#FDE68A" }}
            >
              {registrationLabel(event)}
            </span>
          )}
          {urgency && (
            <span
              className={`sb-event-micro-badge${urgency.pulse ? " sb-urgency-pulse" : ""}`}
              style={{ background: urgency.bg, color: urgency.fg, borderColor: urgency.border }}
            >
              {urgency.label}
            </span>
          )}
          {!urgency && isJustAdded(event.firstSeenAt) && (
            <span
              className="sb-event-micro-badge"
              title="Added to South Bay Today in the last 72 hours"
              style={{ background: "#ECFEFF", color: "#0E7490", borderColor: "#A5F3FC" }}
            >
              New
            </span>
          )}
        </div>

        <h3 className="sb-event-card-title">
          {event.url ? (
            <a
              href={event.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {title}
            </a>
          ) : title}
        </h3>

        <div className="sb-event-card-meta">
          {showDate && event.displayDate && (
            <>
              <span className="sb-event-date-chip">{event.displayDate}</span>
              {(event.time || event.venue || event.city) && <span aria-hidden>·</span>}
            </>
          )}
          {event.time && (
            <span className="sb-event-card-time">
              {formatTimeRange(event.time, event.endTime, event.category === "sports")}
            </span>
          )}
          {event.time && (event.venue || event.city) && <span aria-hidden>·</span>}
          {/* An online-only event has no city to go to — printing one next to a
              campus venue is what made the 2026-08-05 CRC meeting read as a
              place. Show "Online" and the host instead. */}
          {isVirtualEvent(event) ? (
            <>
              <span>Online</span>
              {venue && <span aria-hidden>·</span>}
              {venue && <span>{venue}</span>}
            </>
          ) : (
            <>
              {venue
                ? <span>{venue}</span>
                : <span>{cityLabel(event.city)}</span>
              }
              {venue && <span aria-hidden>·</span>}
              {venue && <span>{cityLabel(event.city)}</span>}
            </>
          )}
          {recurring && (
            <>
              <span aria-hidden>·</span>
              <span
                className="sb-event-recurring"
                title={`${recurring.count} upcoming dates in this series`}
              >
                {recurring.label}
              </span>
            </>
          )}
        </div>

        {body && (
          <p className="sb-event-card-copy">
            {body}
          </p>
        )}

        <div className="sb-event-card-actions">
          {event.date && event.city && (
            <MakeItADayButton eventId={event.id} city={event.city} date={event.date} />
          )}
          <DirectionsButton event={event} />
          <AddToCalendarButton event={event} />
        </div>
      </div>
    </div>
  );
}

// ── "Add to calendar" button ───────────────────────────────────────────────

function AddToCalendarButton({ event }: { event: UpcomingEvent }) {
  const url = buildGoogleCalendarUrl({
    title: event.title,
    date: event.date,
    time: event.time,
    endTime: event.endTime,
    ongoing: event.ongoing,
    venue: event.venue,
    address: event.address,
    city: event.city,
    description: event.description,
    blurb: event.blurb,
    url: event.url,
  });
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="sb-event-action"
      title="Add to Google Calendar"
    >
      Calendar
    </a>
  );
}

// ── "Directions" button ────────────────────────────────────────────────────
// Most events have venue + city (1286/1304 as of cycle 120). Build a Google
// Maps search URL from whatever location bits we have. Skipping virtual events
// and the rare event with no venue/address keeps map results from landing on
// nonsense. Same compact pill style as Add to calendar so the actions read
// as a related set.

function buildEventMapsUrl(event: UpcomingEvent): string | null {
  // Flag first, text second — the flag catches source-declared virtual events
  // whose title and blurb never say so.
  if (isVirtualEvent(event)) return null;
  const cityName = event.city ? cityLabel(event.city) : "";
  // Prefer venue + address + city when available — most specific.
  // Some scrapers stuff the address into the venue field; if address starts
  // with venue (or vice versa) drop the venue to avoid "1234 Main St 1234
  // Main St" duplicates that confuse Maps' search ranking.
  let parts: string[];
  if (event.venue && event.address) {
    const v = event.venue.toLowerCase().trim();
    const a = event.address.toLowerCase().trim();
    if (a.startsWith(v) || v.startsWith(a)) {
      parts = [event.address, cityName, "CA"];
    } else {
      parts = [event.venue, event.address, cityName, "CA"];
    }
  } else {
    parts = [event.venue || "", event.address || "", cityName, "CA"];
  }
  const filtered = parts.filter((s) => s && s.trim().length > 0);
  if (filtered.length === 0) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(filtered.join(", "))}`;
}

function DirectionsButton({ event }: { event: UpcomingEvent }) {
  const url = buildEventMapsUrl(event);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="sb-event-action"
      title="Open in Google Maps"
    >
      Directions
    </a>
  );
}

// ── "Make it a day" button ─────────────────────────────────────────────────

function MakeItADayButton({ eventId, city, date }: { eventId: string; city: string; date: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (state !== "idle") return;
    setState("loading");

    try {
      const planRes = await fetch("/api/plan-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city,
          scope: "regional",
          kids: false,
          lockedIds: [`event:${eventId}`],
          currentHour: 9,
          planDate: date,
        }),
      });
      if (!planRes.ok) throw new Error("plan failed");
      const planData = await planRes.json();

      const shareRes = await fetch("/api/share-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cards: planData.cards,
          city: planData.city || city,
          kids: false,
          weather: planData.weather,
          planDate: date,
        }),
      });
      if (!shareRes.ok) throw new Error("share failed");
      const { url } = await shareRes.json();

      setState("done");
      window.open(url, "_blank");
    } catch {
      setState("idle");
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={state === "loading"}
      className={`sb-event-action${state === "done" ? " sb-event-action--done" : ""}`}
    >
      {state === "loading" ? "Building..." : state === "done" ? "Plan ready" : "Plan day"}
    </button>
  );
}

// ── School-year heads-up banner ─────────────────────────────────────────────
// Surfaces the soonest school-year milestone (AP exams, finals, graduation,
// last day, holidays, breaks) within the next 14 days for districts that
// overlap with the user's selected cities. One compact line, hidden when
// nothing's near. Data lives in src/data/south-bay/school-calendar.json.

interface SchoolDistrict {
  id: string;
  name: string;
  fullName: string;
  color: string;
  bg: string;
  cities: string[];
}

interface SchoolEvent {
  id: string;
  districtId: string;
  label: string;
  type: string;
  startDate: string;
  endDate: string;
}

const SCHOOL_TYPE_EMOJI: Record<string, string> = {
  testing: "📝",
  finals: "📝",
  graduation: "🎓",
  lastday: "🎉",
  break: "🏖️",
  holiday: "🏖️",
};

function schoolEventEmoji(type: string): string {
  return SCHOOL_TYPE_EMOJI[type] ?? "📚";
}

function schoolDateLabel(iso: string, todayIso: string, tomorrowIso: string): string {
  if (iso === todayIso) return "today";
  if (iso === tomorrowIso) return "tomorrow";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** "Sat, May 23 – Mon, May 25" — used on the holiday heads-up banner for
 *  3-day-weekend holidays so residents see the whole observance window, not
 *  just the calendar Monday. Falls back to today/tomorrow labels when the
 *  span starts inside the immediate horizon. */
function formatWeekendRange(
  startIso: string,
  endIso: string,
  todayIso: string,
  tomorrowIso: string,
): string {
  if (startIso === endIso) return schoolDateLabel(startIso, todayIso, tomorrowIso);
  const startLabel = startIso === todayIso
    ? "today"
    : startIso === tomorrowIso
      ? "tomorrow"
      : new Date(startIso + "T12:00:00").toLocaleDateString("en-US", {
          weekday: "short", month: "short", day: "numeric",
        });
  const endDate = new Date(endIso + "T12:00:00");
  // Drop the repeated "May" on the end side when both ends share a month.
  const sameMonth = startIso.slice(0, 7) === endIso.slice(0, 7);
  const endLabel = sameMonth
    ? endDate.toLocaleDateString("en-US", { weekday: "short", day: "numeric" })
    : endDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `${startLabel} – ${endLabel}`;
}

function SchoolHeadsUpBanner({ selectedCities }: { selectedCities: Set<City> }) {
  const todayIso = todayPT();
  const tomorrowIso = addDays(todayIso, 1);
  const horizonIso = addDays(todayIso, 14);

  const districts = (schoolCalendarJson as { districts: SchoolDistrict[] }).districts;
  const events = (schoolCalendarJson as { events: SchoolEvent[] }).events;

  const matchedDistrictIds = useMemo(() => {
    const set = new Set<string>();
    for (const d of districts) {
      if (d.cities.some((c) => selectedCities.has(c as City))) set.add(d.id);
    }
    return set;
  }, [districts, selectedCities]);

  const districtById = useMemo(() => {
    const m: Record<string, SchoolDistrict> = {};
    for (const d of districts) m[d.id] = d;
    return m;
  }, [districts]);

  // Find the soonest event date with at least one matched district. Group all
  // events that share that date AND label so e.g. Memorial Day collapses to a
  // single line with multiple district badges.
  const headline = useMemo(() => {
    const upcoming = events
      .filter((e) => e.startDate >= todayIso && e.startDate <= horizonIso)
      .filter((e) => matchedDistrictIds.has(e.districtId))
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    if (upcoming.length === 0) return null;
    const soonestDate = upcoming[0].startDate;
    const sameDate = upcoming.filter((e) => e.startDate === soonestDate);
    const sameLabel = sameDate.filter((e) => e.label === sameDate[0].label);
    return {
      label: sameLabel[0].label,
      type: sameLabel[0].type,
      startDate: sameLabel[0].startDate,
      endDate: sameLabel[0].endDate,
      districts: sameLabel
        .map((e) => districtById[e.districtId])
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [events, matchedDistrictIds, districtById, todayIso, horizonIso]);

  if (!headline) return null;

  const dateLabel = schoolDateLabel(headline.startDate, todayIso, tomorrowIso);
  const isMultiDay = headline.endDate && headline.endDate !== headline.startDate;
  const verb = headline.type === "graduation" || headline.type === "lastday"
    ? "" // label already reads as a noun
    : isMultiDay ? "begin " : "";

  // When the same event hits every matched district (e.g. Memorial Day across
  // all 9 districts) the badge row becomes noisy. Collapse to a single
  // "all districts" pill in that case.
  const allMatched = headline.districts.length === matchedDistrictIds.size && headline.districts.length >= 4;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        padding: "8px 12px",
        marginBottom: 10,
        background: "#F5F3FF",
        border: "1px solid #DDD6FE",
        borderRadius: 8,
        fontSize: 12.5,
        color: "#4C1D95",
        lineHeight: 1.45,
      }}
    >
      <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
        {schoolEventEmoji(headline.type)}
      </span>
      <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6D28D9" }}>
        School year
      </span>
      <span style={{ fontWeight: 600 }}>
        {headline.label}
      </span>
      <span style={{ color: "#6D28D9" }}>
        {verb}
        {dateLabel}
      </span>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {allMatched ? (
          <span
            title={headline.districts.map((d) => d.fullName).join(", ")}
            style={{
              fontFamily: "'Space Mono', monospace",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.04em",
              padding: "1px 6px",
              borderRadius: 4,
              background: "#EDE9FE",
              color: "#5B21B6",
              border: "1px solid #C4B5FD",
            }}
          >
            All districts
          </span>
        ) : (
          headline.districts.map((d) => (
            <span
              key={d.id}
              title={d.fullName}
              style={{
                fontFamily: "'Space Mono', monospace",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.04em",
                padding: "1px 6px",
                borderRadius: 4,
                background: d.bg,
                color: d.color,
                border: `1px solid ${d.color}33`,
              }}
            >
              {d.name}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

// ── School-year endgame panel ──────────────────────────────────────────────
// Late spring, the question parents have isn't "what's the next holiday" —
// it's "when does my district's school year end?" Last-day dates differ by
// up to two weeks across South Bay districts. We render a compact list of
// finals → graduation → last-day dates in chronological order whenever any
// matched district has its last day within the next 60 days. Outside that
// window the panel hides — keeps the events tab uncluttered the rest of
// the year.

interface SchoolMilestone {
  date: string;
  type: "finals" | "lastday" | "graduation";
  districts: SchoolDistrict[];
}

function SchoolYearEndgamePanel({ selectedCities }: { selectedCities: Set<City> }) {
  const todayIso = todayPT();
  const horizonIso = addDays(todayIso, 60);

  const districts = (schoolCalendarJson as { districts: SchoolDistrict[] }).districts;
  const events = (schoolCalendarJson as { events: SchoolEvent[] }).events;

  const matchedDistrictIds = useMemo(() => {
    const set = new Set<string>();
    for (const d of districts) {
      if (d.cities.some((c) => selectedCities.has(c as City))) set.add(d.id);
    }
    return set;
  }, [districts, selectedCities]);

  const districtById = useMemo(() => {
    const m: Record<string, SchoolDistrict> = {};
    for (const d of districts) m[d.id] = d;
    return m;
  }, [districts]);

  // Group finals + last-day + graduation events by (date, type), then by
  // chrono date. Finals come weeks before grad/lastday, so they anchor the
  // top of the endgame list and give high-school parents a real heads-up.
  // Same district often has both lastday and graduation on the same date
  // (lastday IS the graduation for high schoolers). Keep them on separate
  // rows so parents can spot graduations distinctly.
  const milestones = useMemo<SchoolMilestone[]>(() => {
    const matching = events.filter(
      (e) =>
        (e.type === "finals" || e.type === "lastday" || e.type === "graduation") &&
        e.startDate >= todayIso &&
        e.startDate <= horizonIso &&
        matchedDistrictIds.has(e.districtId),
    );
    const byKey = new Map<string, SchoolMilestone>();
    for (const e of matching) {
      const key = `${e.startDate}|${e.type}`;
      const existing = byKey.get(key);
      const district = districtById[e.districtId];
      if (!district) continue;
      if (existing) {
        if (!existing.districts.some((d) => d.id === district.id)) {
          existing.districts.push(district);
        }
      } else {
        byKey.set(key, {
          date: e.startDate,
          type: e.type as "finals" | "lastday" | "graduation",
          districts: [district],
        });
      }
    }
    const list = Array.from(byKey.values());
    const typeOrder: Record<SchoolMilestone["type"], number> = {
      finals: 0,
      graduation: 1,
      lastday: 2,
    };
    list.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      // On the same date: finals → graduation → lastday. Diplomas before the
      // generic "last day" entry since grad is the bigger moment.
      return typeOrder[a.type] - typeOrder[b.type];
    });
    for (const m of list) {
      m.districts.sort((a, b) => a.name.localeCompare(b.name));
    }
    // Hide a panel that contains only a finals row in a single district —
    // not enough to justify the panel until lastday/grad joins it.
    const hasEndOfYear = list.some((m) => m.type === "lastday" || m.type === "graduation");
    if (!hasEndOfYear) return [];
    return list;
  }, [events, matchedDistrictIds, districtById, todayIso, horizonIso]);

  if (milestones.length === 0) return null;

  // Header summarises the spread: "May 29 – Jun 11" lets a parent see at a
  // glance how staggered the local end-of-year is.
  const firstDate = milestones[0].date;
  const lastDate = milestones[milestones.length - 1].date;
  const spread = firstDate === lastDate
    ? new Date(firstDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : `${new Date(firstDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${new Date(lastDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  return (
    <div
      style={{
        padding: "10px 12px 12px",
        marginBottom: 10,
        background: "#FEFCE8",
        border: "1px solid #FDE68A",
        borderRadius: 8,
        fontSize: 12.5,
        color: "#713F12",
        lineHeight: 1.45,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>🎒</span>
        <span style={{
          fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700,
          letterSpacing: "0.08em", textTransform: "uppercase", color: "#A16207",
        }}>
          End of school year
        </span>
        <span style={{ fontWeight: 700, color: "#713F12" }}>{spread}</span>
        <span style={{ color: "#A16207", fontSize: 11.5 }}>
          across {matchedDistrictIds.size} district{matchedDistrictIds.size === 1 ? "" : "s"}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {milestones.map((m) => {
          const d = new Date(m.date + "T12:00:00");
          const dateLabel = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
          const typeLabel = m.type === "graduation"
            ? "Graduation"
            : m.type === "finals"
              ? "Finals start"
              : "Last day";
          return (
            <div
              key={`${m.date}-${m.type}`}
              style={{
                display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                padding: "4px 0",
              }}
            >
              <span style={{
                fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
                color: "#713F12", minWidth: 88,
              }}>
                {dateLabel}
              </span>
              <span style={{
                fontSize: 11, fontWeight: 600, color: "#A16207",
                minWidth: 78,
              }}>
                {typeLabel}
              </span>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {m.districts.map((d) => (
                  <span
                    key={d.id}
                    title={d.fullName}
                    style={{
                      fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700,
                      letterSpacing: "0.04em", padding: "1px 6px", borderRadius: 4,
                      background: d.bg, color: d.color, border: `1px solid ${d.color}33`,
                    }}
                  >
                    {d.name}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Holiday heads-up banner ────────────────────────────────────────────────
// Surfaces the soonest civic/cultural holiday within the next 14 days
// (Mother's Day, Memorial Day, Cinco de Mayo, etc.). Hidden when nothing
// matches. Mirrors SchoolHeadsUpBanner's visual rhythm. When events exist
// on the holiday's date, renders as a button that jumps the date selector
// so residents can tap "Mother's Day → 12 events" and immediately see them.

interface HolidayHeadsUpBannerProps {
  eventCountByDate: Record<string, number>;
  themedCountByHolidayId: Record<string, number>;
  onJumpToDate: (iso: string, themedHolidayId?: string) => void;
}

function HolidayHeadsUpBanner({
  eventCountByDate,
  themedCountByHolidayId,
  onJumpToDate,
}: HolidayHeadsUpBannerProps) {
  const todayIso = todayPT();
  const tomorrowIso = addDays(todayIso, 1);
  const horizonIso = addDays(todayIso, 14);

  const next = useMemo(
    () => nextHolidayWithin(todayIso, horizonIso),
    [todayIso, horizonIso],
  );
  if (!next) return null;

  const { holiday } = next;
  // For 3-day-weekend holidays (Memorial, Labor, MLK, Presidents', Indigenous
  // Peoples'), residents treat the surrounding Sat–Sun as part of the holiday
  // even though only Monday is the official date. Surface that span on the
  // banner so a Tue–Sat read "Memorial Day Weekend · Sat May 23 – Mon May 25"
  // rather than burying the Saturday–Sunday cohort behind a Mon-only label.
  const spanDays = holiday.weekendSpan && holiday.weekendSpan.length > 1
    ? holidaySpanIsos(next.iso, holiday.weekendSpan)
    : [next.iso];
  const isSpan = spanDays.length > 1;
  // Earliest span day that hasn't already passed — the natural landing date
  // for someone clicking the banner mid-weekend.
  const landingIso = spanDays.find((d) => d >= todayIso) ?? spanDays[spanDays.length - 1];
  const firstDay = spanDays[0];
  const lastDay = spanDays[spanDays.length - 1];

  const dateLabel = isSpan
    ? formatWeekendRange(firstDay, lastDay, todayIso, tomorrowIso)
    : schoolDateLabel(next.iso, todayIso, tomorrowIso);
  const displayLabel = isSpan ? `${holiday.label} Weekend` : holiday.label;

  // Sum event/themed counts across every day in the span so the pill reflects
  // the full weekend, not just the official Monday.
  const totalCount = spanDays.reduce(
    (sum, d) => sum + (eventCountByDate[d] ?? 0),
    0,
  );
  const themedCount = themedCountByHolidayId[holiday.id] ?? 0;
  // Prefer the themed count when the holiday has theme keywords AND there
  // are themed picks available — that's what residents actually want when
  // they tap a "Mother's Day" banner. Fall back to total event count
  // otherwise so the banner still works for holidays without keywords or
  // with no themed events in feed yet.
  const showThemed = themedCount > 0 && !!holiday.themeKeywords?.length;
  const count = showThemed ? themedCount : totalCount;
  const isClickable = count > 0;
  const pillLabel = showThemed
    ? `${themedCount} pick${themedCount === 1 ? "" : "s"}`
    : `${totalCount} event${totalCount === 1 ? "" : "s"}`;

  // Federal-holiday closure note ("Closed Mon: libraries, post offices,
  // city offices, banks · Trash pickup runs 1 day late this week"). Renders
  // inline under the banner header so a resident who sees "Memorial Day
  // Weekend → 5 picks" also sees what's closed without leaving the page.
  const closures = holidayClosureSummary(holiday, next.iso);
  const closureWeekdayLabel = closures
    ? new Date(`${next.iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" })
    : null;

  const innerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    padding: "8px 12px",
    background: holiday.bg,
    border: `1px solid ${holiday.color}33`,
    borderRadius: closures ? "8px 8px 0 0" : 8,
    borderBottom: closures ? "none" : `1px solid ${holiday.color}33`,
    fontSize: 12.5,
    color: holiday.color,
    lineHeight: 1.45,
    width: "100%",
    boxSizing: "border-box",
    fontFamily: "inherit",
    textAlign: "left",
    cursor: isClickable ? "pointer" : "default",
    transition: "background 0.12s, border-color 0.12s",
  };

  const inner = (
    <>
      <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>{holiday.emoji}</span>
      <span style={{
        fontFamily: "'Space Mono', monospace",
        fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
        textTransform: "uppercase", opacity: 0.85,
      }}>
        Holiday
      </span>
      <span style={{ fontWeight: 600 }}>{displayLabel}</span>
      <span style={{ opacity: 0.85 }}>{dateLabel}</span>
      {isClickable && (
        <span
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "'Space Mono', monospace",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            padding: "2px 8px",
            borderRadius: 100,
            background: "#ffffff",
            color: holiday.color,
            border: `1px solid ${holiday.color}55`,
          }}
        >
          {pillLabel} <span aria-hidden>→</span>
        </span>
      )}
    </>
  );

  const closureStrip = closures && (
    <div
      style={{
        padding: "6px 12px 8px",
        marginBottom: 10,
        background: holiday.bg,
        border: `1px solid ${holiday.color}33`,
        borderTop: `1px dashed ${holiday.color}55`,
        borderRadius: "0 0 8px 8px",
        fontSize: 11.5,
        color: holiday.color,
        lineHeight: 1.45,
        boxSizing: "border-box",
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        alignItems: "baseline",
      }}
    >
      <span
        style={{
          fontFamily: "'Space Mono', monospace",
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          opacity: 0.7,
        }}
      >
        Closures
      </span>
      <span style={{ opacity: 0.95 }}>
        <strong style={{ fontWeight: 700 }}>Closed{closureWeekdayLabel ? ` ${closureWeekdayLabel}` : ""}:</strong>{" "}
        {closures.closed}
      </span>
      {closures.trashDelayed && (
        <span style={{ opacity: 0.95 }}>
          · <strong style={{ fontWeight: 700 }}>Trash:</strong> 1 day late through Friday
        </span>
      )}
      {closures.transit && (
        <span style={{ opacity: 0.95 }}>
          · <strong style={{ fontWeight: 700 }}>Transit:</strong> {closures.transit}
        </span>
      )}
    </div>
  );

  const button = isClickable ? (
    <button
      type="button"
      onClick={() => onJumpToDate(landingIso, showThemed ? holiday.id : undefined)}
      aria-label={`Jump to ${displayLabel} (${dateLabel}) — ${pillLabel}`}
      style={innerStyle}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = `${holiday.color}80`; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = `${holiday.color}33`; }}
    >
      {inner}
    </button>
  ) : (
    <div style={innerStyle}>{inner}</div>
  );

  if (!closureStrip) {
    return <div style={{ marginBottom: 10 }}>{button}</div>;
  }
  return (
    <div>
      {button}
      {closureStrip}
    </div>
  );
}

// ── Holiday picks preview ──────────────────────────────────────────────────
// When a themed holiday is within 3 days, surface 2–3 actual themed events
// directly under the heads-up banner instead of making residents tap "→" to
// see them. Mother's Day weekend / Cinco de Mayo / Halloween are exactly the
// moments where the banner alone undersells what's bookable RIGHT NOW. Tap a
// row → same jump as the banner pill. Hidden when fewer than 2 themed events
// match (the banner already conveys "1 pick" fine on its own).
//
// Time-window: only fires when the holiday is today, tomorrow, or the day
// after — past that, residents have time to discover events organically and
// the prominence isn't earned.
interface HolidayPicksPreviewProps {
  events: UpcomingEvent[];
  selectedCities: Set<City>;
  allCities: boolean;
  onJumpToDate: (iso: string, themedHolidayId?: string) => void;
}

function HolidayPicksPreview({
  events,
  selectedCities,
  allCities,
  onJumpToDate,
}: HolidayPicksPreviewProps) {
  const todayIso = todayPT();
  // For 3-day-weekend holidays, give the preview a wider window so the picks
  // surface before the Saturday — residents plan a long weekend a few days
  // out, not the night before.
  const horizonIso = addDays(todayIso, 7);
  const next = useMemo(
    () => nextHolidayWithin(todayIso, horizonIso),
    [todayIso, horizonIso],
  );
  if (!next) return null;
  const { holiday, iso } = next;
  if (!holiday.themeKeywords?.length) return null;

  const spanIsos = holiday.weekendSpan && holiday.weekendSpan.length > 1
    ? holidaySpanIsos(iso, holiday.weekendSpan).filter((d) => d >= todayIso)
    : [iso];
  // Non-span holidays keep the original 3-day horizon — surfacing
  // single-day picks a week out is too early and clutters the events tab.
  if (spanIsos.length === 1 && iso > addDays(todayIso, 3)) return null;
  const spanSet = new Set(spanIsos);

  const themed = useMemo(() => {
    const out: UpcomingEvent[] = [];
    for (const e of events) {
      if (!spanSet.has(e.date)) continue;
      if (!allCities && !selectedCities.has(e.city as City)) continue;
      const lower = `${e.title} ${e.blurb ?? ""} ${e.description ?? ""} ${e.venue ?? ""}`.toLowerCase();
      if (!matchesHolidayTheme(holiday, lower)) continue;
      out.push(e);
    }
    // Span days first (residents plan chronologically), then images, then
    // time, then title for stability.
    out.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      const aHas = (a.image || a.photoRef) ? 1 : 0;
      const bHas = (b.image || b.photoRef) ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      const aTime = a.time ? 1 : 0;
      const bTime = b.time ? 1 : 0;
      if (aTime !== bTime) return bTime - aTime;
      return a.title.localeCompare(b.title);
    });
    return out.slice(0, 3);
  }, [events, spanSet, holiday, allCities, selectedCities]);

  if (themed.length < 2) return null;

  const isSpan = spanIsos.length > 1;
  const dayWord = isSpan
    ? `${holiday.label} Weekend`
    : iso === todayIso
      ? "Today"
      : iso === addDays(todayIso, 1)
        ? "Tomorrow"
        : new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
  const previewHeading = isSpan ? dayWord : `${holiday.label} · ${dayWord} picks`;

  return (
    <div
      style={{
        marginTop: -4,
        marginBottom: 12,
        padding: "10px 12px",
        background: holiday.bg,
        border: `1px solid ${holiday.color}33`,
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 8,
          fontFamily: "'Space Mono', monospace",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: holiday.color,
        }}
      >
        <span aria-hidden style={{ fontSize: 12 }}>{holiday.emoji}</span>
        <span>{previewHeading}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {themed.map((e) => {
          const cityName = CITY_LABELS[e.city] ?? e.city;
          const time = formatTimeRange(e.time, e.endTime);
          const dayBadge = isSpan
            ? new Date(e.date + "T12:00:00").toLocaleDateString("en-US", {
                weekday: "short", month: "short", day: "numeric",
              })
            : null;
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => onJumpToDate(e.date, holiday.id)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "8px 10px",
                background: "#ffffff",
                border: `1px solid ${holiday.color}22`,
                borderRadius: 6,
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "inherit",
                color: "var(--sb-ink)",
                transition: "border-color 0.12s, transform 0.12s",
              }}
              onMouseEnter={(ev) => {
                ev.currentTarget.style.borderColor = `${holiday.color}66`;
              }}
              onMouseLeave={(ev) => {
                ev.currentTarget.style.borderColor = `${holiday.color}22`;
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: "var(--sb-serif)",
                    fontWeight: 700,
                    fontSize: 13.5,
                    lineHeight: 1.3,
                    color: "var(--sb-ink)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {e.title}
                </div>
                <div
                  style={{
                    marginTop: 2,
                    fontSize: 11,
                    color: "var(--sb-muted)",
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    fontFamily: "'Space Mono', monospace",
                  }}
                >
                  {dayBadge && <span style={{ color: holiday.color, fontWeight: 700 }}>{dayBadge}</span>}
                  {dayBadge && <span aria-hidden>·</span>}
                  {time && <span style={{ color: holiday.color, fontWeight: 700 }}>{time}</span>}
                  {time && <span aria-hidden>·</span>}
                  <span style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 220,
                  }}>{e.venue}</span>
                  <span aria-hidden>·</span>
                  <span>{cityName}</span>
                  {e.cost === "free" && (
                    <>
                      <span aria-hidden>·</span>
                      <span style={{ fontWeight: 700, color: "#15803D" }}>FREE</span>
                    </>
                  )}
                </div>
              </div>
              <span
                aria-hidden
                style={{
                  flexShrink: 0,
                  fontSize: 14,
                  color: holiday.color,
                  marginTop: 1,
                }}
              >
                →
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Heritage / observance month banner ─────────────────────────────────────
// Subtle one-liner acknowledging federally recognized heritage months that
// matter to large South Bay communities (AANHPI, Hispanic, Jewish, LGBTQ+,
// Filipino American, Black, Native American, etc.). Renders nothing outside
// active windows. Multiple observances can co-occur (May = AANHPI + Jewish
// American Heritage; October has 4 overlapping months) — they stack inline.

interface HeritageBannerProps {
  activeId: string | null;
  onToggle: (id: string | null) => void;
  countsById: Record<string, number>;
}
function HeritageMonthBanner({ activeId, onToggle, countsById }: HeritageBannerProps) {
  const todayIso = todayPT();
  const months = useMemo(() => currentHeritageMonths(todayIso), [todayIso]);
  if (months.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 6,
        rowGap: 6,
        padding: "4px 12px",
        marginBottom: 10,
        fontSize: 11.5,
        color: "var(--sb-muted)",
        lineHeight: 1.45,
      }}
    >
      <span
        style={{
          fontFamily: "'Space Mono', monospace",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          marginRight: 4,
        }}
      >
        Observing
      </span>
      {months.map((m) => {
        const isActive = activeId === m.id;
        const count = countsById[m.id] ?? 0;
        const hasEvents = count > 0;
        return (
            <button
              key={m.id}
              type="button"
              title={hasEvents ? `${m.blurb} — tap to filter ${count} matching event${count === 1 ? "" : "s"}` : m.blurb}
              onClick={() => onToggle(isActive ? null : m.id)}
              disabled={!hasEvents && !isActive}
              style={{
                display: "inline-flex",
                gap: 5,
                alignItems: "center",
                padding: "3px 9px",
                borderRadius: 100,
                fontSize: 11.5,
                lineHeight: 1.3,
                fontFamily: "inherit",
                color: isActive ? "#fff" : (hasEvents ? m.color : "var(--sb-muted)"),
                background: isActive ? m.color : (hasEvents ? m.bg : "transparent"),
                border: `1.5px solid ${isActive ? m.color : (hasEvents ? m.bg : "var(--sb-border)")}`,
                cursor: hasEvents || isActive ? "pointer" : "default",
                opacity: hasEvents || isActive ? 1 : 0.55,
                transition: "all 0.12s",
              }}
            >
              <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>{m.emoji}</span>
              <span style={{ fontWeight: 600 }}>{m.label}</span>
              {hasEvents && (
                <span style={{
                  fontSize: 10, fontWeight: 700,
                  background: isActive ? "rgba(255,255,255,0.22)" : "#fff",
                  color: isActive ? "#fff" : m.color,
                  borderRadius: 100, padding: "0 6px", lineHeight: "16px",
                  minWidth: 18, textAlign: "center",
                }}>
                  {count}
                </span>
              )}
            </button>
        );
      })}
    </div>
  );
}

const ACTIVE_HERITAGE_MONTHS_NOW = (iso: string): HeritageMonth[] => currentHeritageMonths(iso);

// ── Main view ──────────────────────────────────────────────────────────────

export default function EventsView({ selectedCities, onToggleCity, onToggleAllCities }: Props) {
  const [category, setCategory] = useState<EventCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [showKidsOnly, setShowKidsOnly] = useState(false);
  const [showFreeOnly, setShowFreeOnly] = useState(false);
  // Tonight = today's events starting 5 PM or later that haven't begun yet.
  // High-value toggle for "what's happening tonight?" — the most common
  // question on a weekend afternoon.
  const [showTonightOnly, setShowTonightOnly] = useState(false);
  // Weekend = events on this Sat AND Sun, rendered grouped by day. The
  // companion to Tonight: lets weekday users see the full weekend in one
  // glance without flipping through date pills.
  const [showWeekendOnly, setShowWeekendOnly] = useState(false);
  // Live now = today's events that have started but haven't ended yet.
  // Inverts the default "hide started events" rule so users can see the
  // exhibit/festival/concert that's already going on right now.
  const [showLiveNowOnly, setShowLiveNowOnly] = useState(false);
  // Just added = events whose firstSeenAt is within the last 72 hours.
  // Gives repeat visitors a way to scan only what's new since their last
  // visit instead of re-reading the same list.
  const [showJustAddedOnly, setShowJustAddedOnly] = useState(false);
  // Active heritage-month filter (e.g. AANHPI, Pride). Populated by clicking
  // a chip in the HeritageMonthBanner; null = no filter. Composes with the
  // other filters via matchesFilters.
  const [activeHeritageId, setActiveHeritageId] = useState<string | null>(null);
  // Active themed-holiday filter — populated when the user taps the holiday
  // heads-up banner on a holiday that has theme keywords (e.g. Mother's
  // Day → narrows that day's view to mom-themed picks instead of every
  // event on Sunday). Auto-cleared when the user navigates to a different
  // date so it doesn't sneakily filter unrelated days.
  // Initialised from `?holiday=` deep-link param (e.g. when a city page's
  // holiday banner sends a resident to /events?city=X&date=Y&holiday=Z).
  const [activeThemedHolidayId, setActiveThemedHolidayId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const h = new URLSearchParams(window.location.search).get("holiday");
    return h && NAMED_HOLIDAYS.some((x) => x.id === h) ? h : null;
  });
  const [upcomingData, setUpcomingData] = useState<{ events: UpcomingEvent[] } | null>(null);

  const todayIso = todayPT();
  const tomorrowIso = addDays(todayIso, 1);
  const [weekendSat, weekendSun] = useMemo(() => thisWeekendDates(todayIso), [todayIso]);

  // Initial day selection — defaults to today, but accepts a `?date=YYYY-MM-DD`
  // deep-link param (used by city-page holiday banners that want to drop the
  // resident on a specific holiday's day view).
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    if (typeof window === "undefined") return todayIso;
    const d = new URLSearchParams(window.location.search).get("date");
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= todayIso) return d;
    return todayIso;
  });

  // Two-stage load: the 14-day near feed paints the visible rail (today + 6
  // days) fast and cheap. The full feed (~2MB decompressed) is only worth
  // paying for once something actually needs it — search, a deep-linked date
  // outside the near window, or an idle prefetch a few seconds after mount so
  // it's ready by the time someone reaches for it. Eagerly true when the
  // initial date came from a `?date=` deep link, since we can't yet know
  // whether that date falls inside the near feed's window.
  const [wantFullFeed, setWantFullFeed] = useState(() => selectedDate !== todayIso);

  useEffect(() => {
    // Near feed always loads — it's what paints the initial rail. Only apply
    // it if nothing has landed yet (a full-feed response, once requested,
    // always wins over the near feed).
    let cancelled = false;
    fetch("/api/south-bay/upcoming-events-near")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setUpcomingData((prev) => prev ?? d);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!wantFullFeed) return;
    let cancelled = false;
    fetch("/api/south-bay/upcoming-events")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setUpcomingData(d ?? { events: [] });
      })
      .catch(() => {
        if (!cancelled) setUpcomingData((prev) => prev ?? { events: [] });
      });
    return () => { cancelled = true; };
  }, [wantFullFeed]);

  useEffect(() => {
    // Idle prefetch — nobody explicitly asked for the full feed yet, but load
    // it anyway after a few seconds so search/far-date navigation feel
    // instant once someone reaches for them.
    if (wantFullFeed) return;
    const id = window.setTimeout(() => setWantFullFeed(true), 3000);
    return () => window.clearTimeout(id);
  }, [wantFullFeed]);

  const allEvents = useMemo(
    () => (upcomingData?.events ?? []).map(normalizeEventForDisplay),
    [upcomingData],
  );
  // Reclassify: an event with `ongoing: true` AND a clock time is a recurring
  // event (weekly storytime, ESL class, multi-night theater run) that the
  // multi-day-detection rules in generate-events.mjs over-flagged. Treat it
  // as a normal event on its date so it shows up in the day view, not exiled
  // to the Exhibits section. True exhibits have no clock time.
  const upcomingEvents = useMemo(
    () => allEvents.filter((e) => !e.ongoing || !!e.time),
    [allEvents],
  );
  const ongoingEvents = useMemo(
    () => allEvents.filter((e) => e.ongoing && !e.time && isOngoingExhibitEvent(e)),
    [allEvents],
  );

  // Build the recurring-series map once across the full upcoming set so cards
  // can show "Every Tue" / "Recurring" badges without each one re-walking.
  const recurringMap = useMemo(() => computeRecurringMap(upcomingEvents), [upcomingEvents]);
  const recurringFor = (e: UpcomingEvent): RecurringInfo | null =>
    recurringMap.get(recurringKey(e.title, e.venue)) ?? null;

  // Live ticker so "Starts in N min" / "Happening now" pills stay accurate
  // when a tab is left open. Updates every 60s.
  const nowMins = useNowMinutes();

  const allCities = selectedCities.size === CITIES.length;

  // Search overrides single-day view
  const isSearching = search.trim().length > 0;
  const searchQ = search.trim().toLowerCase();

  const TONIGHT_FROM_MIN = 17 * 60; // 5 PM

  // Active heritage month object (for keyword matching). Null when no filter
  // is selected or when the active id no longer corresponds to a current
  // observance window (defensive — chips only render in-window).
  const activeHeritage = useMemo(() => {
    if (!activeHeritageId) return null;
    return ACTIVE_HERITAGE_MONTHS_NOW(todayIso).find((m) => m.id === activeHeritageId) ?? null;
  }, [activeHeritageId, todayIso]);

  const heritageHaystack = (e: UpcomingEvent): string =>
    `${e.title} ${e.blurb ?? ""} ${e.description ?? ""} ${e.venue ?? ""}`;

  const matchesActiveHeritage = (e: UpcomingEvent): boolean => {
    if (!activeHeritage) return true;
    return matchesHeritage(activeHeritage, heritageHaystack(e));
  };

  // The holiday object backing the active themed filter, plus its ISO date
  // for the current year. Recomputed when the active id changes; null when
  // no filter is set or the id no longer resolves.
  const themedHoliday = useMemo(() => {
    if (!activeThemedHolidayId) return null;
    const h = NAMED_HOLIDAYS.find((x) => x.id === activeThemedHolidayId);
    if (!h) return null;
    const iso = h.computeIso(Number(todayIso.slice(0, 4)));
    return { holiday: h, iso };
  }, [activeThemedHolidayId, todayIso]);

  const matchesActiveThemedHoliday = (e: UpcomingEvent): boolean => {
    if (!themedHoliday) return true;
    // Only narrow the view on the holiday date itself — events on other
    // dates pass through unaffected.
    if (e.date !== themedHoliday.iso) return true;
    const lower = `${e.title} ${e.blurb ?? ""} ${e.description ?? ""} ${e.venue ?? ""}`.toLowerCase();
    return matchesHolidayTheme(themedHoliday.holiday, lower);
  };

  // Apply common filters (city, category, kids, search) to a list of events
  const matchesFilters = (e: UpcomingEvent): boolean => {
    if (!allCities && !selectedCities.has(e.city as City)) return false;
    if (category !== "all" && e.category !== category) return false;
    if (showKidsOnly && !e.kidFriendly) return false;
    if (showFreeOnly && e.cost !== "free") return false;
    if (showTonightOnly) {
      if (e.date !== todayIso) return false;
      if (!e.time) return false;
      const m = parseTimeToMinutes(e.time);
      if (m === null || m < TONIGHT_FROM_MIN) return false;
    }
    if (showWeekendOnly) {
      if (e.date !== weekendSat && e.date !== weekendSun) return false;
    }
    if (showLiveNowOnly) {
      if (e.date !== todayIso) return false;
      if (!isInProgressNow(e.time, e.endTime)) return false;
    }
    if (showJustAddedOnly && !isJustAdded(e.firstSeenAt)) return false;
    if (!matchesActiveHeritage(e)) return false;
    if (!matchesActiveThemedHoliday(e)) return false;
    if (isSearching) {
      if (!e.title.toLowerCase().includes(searchQ) &&
          !(e.blurb || "").toLowerCase().includes(searchQ) &&
          !(e.description || "").toLowerCase().includes(searchQ) &&
          !e.city.toLowerCase().includes(searchQ) &&
          !e.venue.toLowerCase().includes(searchQ)) return false;
    }
    return true;
  };

  // Sort: pure start time ascending; events with no time come last
  const byStartTimeWithinDate = (a: UpcomingEvent, b: UpcomingEvent): number => {
    const aHasTime = a.time !== null && a.time !== undefined && a.time !== "";
    const bHasTime = b.time !== null && b.time !== undefined && b.time !== "";
    if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
    if (aHasTime && bHasTime) {
      const aMin = parseTimeToMinutes(a.time!) ?? 9999;
      const bMin = parseTimeToMinutes(b.time!) ?? 9999;
      if (aMin !== bMin) return aMin - bMin;
    }
    return a.title.localeCompare(b.title);
  };

  // Events visible for the currently selected day
  const dayEvents = useMemo(() => {
    if (isSearching) return [];
    return upcomingEvents
      .filter((e) => e.date === selectedDate)
      .filter(matchesFilters)
      // Hide today's events that have started — UNLESS the user has explicitly
      // asked to see what's happening right now via the Live Now pill.
      .filter((e) => showLiveNowOnly || !(e.date === todayIso && !hasNotStarted(e.time)))
      .sort(byStartTimeWithinDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingEvents, selectedDate, selectedCities, category, showKidsOnly, showFreeOnly, showTonightOnly, showWeekendOnly, showLiveNowOnly, showJustAddedOnly, activeHeritage, weekendSat, weekendSun, todayIso, isSearching]);

  // Search-mode results (across all dates)
  const searchResults = useMemo(() => {
    if (!isSearching) return [];
    return upcomingEvents
      .filter(matchesFilters)
      .filter((e) => e.date >= todayIso) // future only
      .sort((a, b) => {
        const dateCmp = a.date.localeCompare(b.date);
        if (dateCmp !== 0) return dateCmp;
        return byStartTimeWithinDate(a, b);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingEvents, search, selectedCities, category, showKidsOnly, showFreeOnly, showTonightOnly, showWeekendOnly, showJustAddedOnly, activeHeritage, weekendSat, weekendSun, todayIso, isSearching]);

  // Group search results by date for compact rendering
  const searchGroups = useMemo(() => {
    const groups: Record<string, UpcomingEvent[]> = {};
    for (const e of searchResults) {
      (groups[e.date] ||= []).push(e);
    }
    return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
  }, [searchResults]);

  // Weekend-mode events — both weekend days, grouped by date for rendering.
  // Past events for today (if today is Sat/Sun) hide via hasNotStarted.
  const weekendGroups = useMemo<[string, UpcomingEvent[]][]>(() => {
    if (!showWeekendOnly || isSearching) return [];
    const matches = upcomingEvents
      .filter((e) => e.date === weekendSat || e.date === weekendSun)
      .filter(matchesFilters)
      .filter((e) => !(e.date === todayIso && !hasNotStarted(e.time)))
      .sort(byStartTimeWithinDate);
    const groups: Record<string, UpcomingEvent[]> = {};
    for (const e of matches) (groups[e.date] ||= []).push(e);
    return [weekendSat, weekendSun]
      .filter((d) => (groups[d]?.length ?? 0) > 0)
      .map((d) => [d, groups[d]] as [string, UpcomingEvent[]]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingEvents, showWeekendOnly, weekendSat, weekendSun, isSearching, selectedCities, category, showKidsOnly, showFreeOnly, showTonightOnly, activeHeritage, todayIso]);

  // Determine which dates have any events visible (after city/category/kids/search filters)
  const datesWithEvents = useMemo(() => {
    const set = new Set<string>();
    for (const e of upcomingEvents) {
      if (e.date < todayIso) continue;
      if (!showLiveNowOnly && e.date === todayIso && !hasNotStarted(e.time)) continue;
      if (!matchesFilters(e)) continue;
      set.add(e.date);
    }
    return [...set].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingEvents, selectedCities, category, showKidsOnly, showFreeOnly, showTonightOnly, showWeekendOnly, showLiveNowOnly, showJustAddedOnly, activeHeritage, weekendSat, weekendSun, todayIso, search]);

  // Auto-clamp selected date if it's no longer in datesWithEvents (e.g. user changed filters)
  useEffect(() => {
    if (isSearching) return;
    if (datesWithEvents.length === 0) {
      if (selectedDate !== todayIso) setSelectedDate(todayIso);
      return;
    }
    if (!datesWithEvents.includes(selectedDate)) {
      // Snap to the nearest future date that has events
      const nextDate = datesWithEvents.find((d) => d >= selectedDate) ?? datesWithEvents[0];
      setSelectedDate(nextDate);
    }
  }, [datesWithEvents, selectedDate, todayIso, isSearching]);

  // Auto-clear the themed-holiday filter when the user moves off the holiday
  // date or starts a search. The filter is intentionally tied to that one
  // date — silently filtering unrelated days would be surprising.
  useEffect(() => {
    if (!themedHoliday) return;
    if (isSearching || selectedDate !== themedHoliday.iso) {
      setActiveThemedHolidayId(null);
    }
  }, [themedHoliday, selectedDate, isSearching]);

  // Per-category counts (for badges on category pills) — count across ALL
  // upcoming events so users can see which categories have anything at all,
  // regardless of which day is currently selected. Honors city/kids/search
  // filters since those reflect the user's intent across the whole feed.
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of upcomingEvents) {
      if (e.date < todayIso) continue;
      if (!showLiveNowOnly && e.date === todayIso && !hasNotStarted(e.time)) continue;
      if (!allCities && !selectedCities.has(e.city as City)) continue;
      if (showKidsOnly && !e.kidFriendly) continue;
      if (showFreeOnly && e.cost !== "free") continue;
      if (showTonightOnly) {
        if (e.date !== todayIso) continue;
        if (!e.time) continue;
        const m = parseTimeToMinutes(e.time);
        if (m === null || m < TONIGHT_FROM_MIN) continue;
      }
      if (showWeekendOnly) {
        if (e.date !== weekendSat && e.date !== weekendSun) continue;
      }
      if (showLiveNowOnly) {
        if (e.date !== todayIso) continue;
        if (!isInProgressNow(e.time, e.endTime)) continue;
      }
      if (!matchesActiveHeritage(e)) continue;
      if (isSearching) {
        if (!e.title.toLowerCase().includes(searchQ) &&
            !(e.blurb || "").toLowerCase().includes(searchQ) &&
            !(e.description || "").toLowerCase().includes(searchQ) &&
            !e.city.toLowerCase().includes(searchQ) &&
            !e.venue.toLowerCase().includes(searchQ)) continue;
      }
      counts[e.category] = (counts[e.category] || 0) + 1;
    }
    counts["all"] = Object.values(counts).reduce((a, b) => a + b, 0);
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingEvents, selectedCities, showKidsOnly, showFreeOnly, showTonightOnly, showWeekendOnly, showLiveNowOnly, showJustAddedOnly, activeHeritage, weekendSat, weekendSun, todayIso, isSearching, searchQ]);

  // Per-city counts (for badges on city pills) — same approach as
  // categoryCounts but excludes the city filter so users can see what's
  // available in each city given the current category/kids/search filters.
  const cityCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    let total = 0;
    for (const e of upcomingEvents) {
      if (e.date < todayIso) continue;
      if (!showLiveNowOnly && e.date === todayIso && !hasNotStarted(e.time)) continue;
      if (category !== "all" && e.category !== category) continue;
      if (showKidsOnly && !e.kidFriendly) continue;
      if (showFreeOnly && e.cost !== "free") continue;
      if (showTonightOnly) {
        if (e.date !== todayIso) continue;
        if (!e.time) continue;
        const m = parseTimeToMinutes(e.time);
        if (m === null || m < TONIGHT_FROM_MIN) continue;
      }
      if (showWeekendOnly) {
        if (e.date !== weekendSat && e.date !== weekendSun) continue;
      }
      if (showLiveNowOnly) {
        if (e.date !== todayIso) continue;
        if (!isInProgressNow(e.time, e.endTime)) continue;
      }
      if (!matchesActiveHeritage(e)) continue;
      if (isSearching) {
        if (!e.title.toLowerCase().includes(searchQ) &&
            !(e.blurb || "").toLowerCase().includes(searchQ) &&
            !(e.description || "").toLowerCase().includes(searchQ) &&
            !e.city.toLowerCase().includes(searchQ) &&
            !e.venue.toLowerCase().includes(searchQ)) continue;
      }
      counts[e.city] = (counts[e.city] || 0) + 1;
      total++;
    }
    return { perCity: counts, total };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingEvents, category, showKidsOnly, showFreeOnly, showTonightOnly, showWeekendOnly, showLiveNowOnly, showJustAddedOnly, activeHeritage, weekendSat, weekendSun, todayIso, isSearching, searchQ]);

  // Ongoing/exhibits filter (separate from day view)
  const filteredOngoing = useMemo(() => {
    return ongoingEvents.filter(matchesFilters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ongoingEvents, selectedCities, category, showKidsOnly, search]);

  // Per-pill counts for Kids/Free/Tonight/Weekend badges. Each count answers
  // "how many events would I see if I checked this box?" given the current
  // city/category/search filters — independent of the other pill states so
  // toggling one pill doesn't make the others' badges go to zero.
  const pillCounts = useMemo(() => {
    let kids = 0, free = 0, tonight = 0, weekend = 0, live = 0, justAdded = 0;
    for (const e of upcomingEvents) {
      if (e.date < todayIso) continue;
      // Live count needs started-but-ongoing events, so don't apply the
      // standard "hide started events" gate here. We bucket live separately.
      const startedToday = e.date === todayIso && !hasNotStarted(e.time);
      if (!allCities && !selectedCities.has(e.city as City)) continue;
      if (category !== "all" && e.category !== category) continue;
      if (isSearching) {
        if (!e.title.toLowerCase().includes(searchQ) &&
            !(e.blurb || "").toLowerCase().includes(searchQ) &&
            !(e.description || "").toLowerCase().includes(searchQ) &&
            !e.city.toLowerCase().includes(searchQ) &&
            !e.venue.toLowerCase().includes(searchQ)) continue;
      }
      if (e.date === todayIso && isInProgressNow(e.time, e.endTime)) live++;
      // Other pills only count not-yet-started events
      if (startedToday) continue;
      if (e.kidFriendly) kids++;
      if (e.cost === "free") free++;
      if (e.date === todayIso && e.time) {
        const m = parseTimeToMinutes(e.time);
        if (m !== null && m >= TONIGHT_FROM_MIN) tonight++;
      }
      if (e.date === weekendSat || e.date === weekendSun) weekend++;
      if (isJustAdded(e.firstSeenAt)) justAdded++;
    }
    return { kids, free, tonight, weekend, live, justAdded };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingEvents, allCities, selectedCities, category, weekendSat, weekendSun, todayIso, isSearching, searchQ]);

  // Per-heritage event counts — answers "if I tapped this chip, how many
  // events would I see?" given the current city/category/kids/search/etc.
  // filters. Independent of the active heritage so the chip the user already
  // toggled stays clickable to un-toggle.
  const heritageCounts = useMemo(() => {
    const todayPTIso = todayIso;
    const months = ACTIVE_HERITAGE_MONTHS_NOW(todayPTIso);
    const counts: Record<string, number> = {};
    if (months.length === 0) return counts;
    for (const e of upcomingEvents) {
      if (e.date < todayPTIso) continue;
      if (e.date === todayPTIso && !hasNotStarted(e.time)) continue;
      if (!allCities && !selectedCities.has(e.city as City)) continue;
      if (category !== "all" && e.category !== category) continue;
      if (showKidsOnly && !e.kidFriendly) continue;
      if (showFreeOnly && e.cost !== "free") continue;
      if (showTonightOnly) {
        if (e.date !== todayPTIso) continue;
        if (!e.time) continue;
        const m = parseTimeToMinutes(e.time);
        if (m === null || m < TONIGHT_FROM_MIN) continue;
      }
      if (showWeekendOnly) {
        if (e.date !== weekendSat && e.date !== weekendSun) continue;
      }
      if (isSearching) {
        if (!e.title.toLowerCase().includes(searchQ) &&
            !(e.blurb || "").toLowerCase().includes(searchQ) &&
            !(e.description || "").toLowerCase().includes(searchQ) &&
            !e.city.toLowerCase().includes(searchQ) &&
            !e.venue.toLowerCase().includes(searchQ)) continue;
      }
      const text = `${e.title} ${e.blurb ?? ""} ${e.description ?? ""} ${e.venue ?? ""}`;
      for (const m of months) {
        if (matchesHeritage(m, text)) counts[m.id] = (counts[m.id] || 0) + 1;
      }
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingEvents, allCities, selectedCities, category, showKidsOnly, showFreeOnly, showTonightOnly, showWeekendOnly, weekendSat, weekendSun, todayIso, isSearching, searchQ]);

  // Per-date counts for the 7-day strip — same filter logic as datesWithEvents
  // but tallied per day so each pill in the strip can show how busy that day is.
  // Tonight/Weekend toggles are intentionally NOT applied here: the strip is
  // hidden in those modes anyway, and we want pure city/category/kids/free/
  // search filtering so the numbers stay consistent with what the user sees
  // when they tap a date pill.
  //
  // Unlike dayEvents (which hides today's already-started events so the list
  // reads as "what's still ahead"), this count intentionally does NOT apply
  // hasNotStarted — it's the full day's total, matching what the static
  // /events/[date] page and the "Today" hero stat report. That keeps the
  // pill's number legible as "how many things are on the calendar today"
  // even when some have already started; hasNotStarted still governs which
  // events actually render in the list below (see dayEvents).
  const eventCountByDate = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of upcomingEvents) {
      if (e.date < todayIso) continue;
      if (!allCities && !selectedCities.has(e.city as City)) continue;
      if (category !== "all" && e.category !== category) continue;
      if (showKidsOnly && !e.kidFriendly) continue;
      if (showFreeOnly && e.cost !== "free") continue;
      if (!matchesActiveHeritage(e)) continue;
      if (isSearching) {
        if (!e.title.toLowerCase().includes(searchQ) &&
            !(e.blurb || "").toLowerCase().includes(searchQ) &&
            !(e.description || "").toLowerCase().includes(searchQ) &&
            !e.city.toLowerCase().includes(searchQ) &&
            !e.venue.toLowerCase().includes(searchQ)) continue;
      }
      counts[e.date] = (counts[e.date] || 0) + 1;
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingEvents, allCities, selectedCities, category, showKidsOnly, showFreeOnly, activeHeritage, todayIso, isSearching, searchQ]);

  // Themed-event counts per upcoming holiday in the next 14 days. Drives the
  // pill on the holiday heads-up banner ("5 picks →" instead of "28 events
  // →") so residents know that tapping will jump them to genuinely themed
  // events, not every random Sunday booking. Honors city/category/kids/free
  // filters so the count matches what the user will actually see post-jump.
  const themedCountByHolidayId = useMemo(() => {
    const horizonIso = addDays(todayIso, 14);
    const counts: Record<string, number> = {};
    for (let y = Number(todayIso.slice(0, 4)); y <= Number(horizonIso.slice(0, 4)); y++) {
      for (const h of NAMED_HOLIDAYS) {
        if (!h.themeKeywords?.length) continue;
        const iso = h.computeIso(y);
        if (iso < todayIso || iso > horizonIso) continue;
        // For 3-day-weekend holidays, count themed events across the whole
        // span so the heads-up pill reads "12 picks" for the Sat–Sun–Mon
        // bracket — not just the four Memorial Day Monday observances.
        const dayWindow = new Set(
          (h.weekendSpan && h.weekendSpan.length > 1
            ? holidaySpanIsos(iso, h.weekendSpan)
            : [iso]
          ).filter((d) => d >= todayIso),
        );
        let n = 0;
        for (const e of upcomingEvents) {
          if (!dayWindow.has(e.date)) continue;
          if (!allCities && !selectedCities.has(e.city as City)) continue;
          if (category !== "all" && e.category !== category) continue;
          if (showKidsOnly && !e.kidFriendly) continue;
          if (showFreeOnly && e.cost !== "free") continue;
          const lower = `${e.title} ${e.blurb ?? ""} ${e.description ?? ""} ${e.venue ?? ""}`.toLowerCase();
          if (!matchesHolidayTheme(h, lower)) continue;
          n++;
        }
        counts[h.id] = n;
      }
    }
    return counts;
  }, [upcomingEvents, allCities, selectedCities, category, showKidsOnly, showFreeOnly, todayIso]);

  // Prev/next date buttons
  const prevDate = !isSearching && datesWithEvents.length > 0
    ? [...datesWithEvents].reverse().find((d) => d < selectedDate) ?? null
    : null;
  const nextDate = !isSearching && datesWithEvents.length > 0
    ? datesWithEvents.find((d) => d > selectedDate) ?? null
    : null;

  const dayLbl = dayLabel(selectedDate, todayIso, tomorrowIso);
  const isLoadingEvents = upcomingData === null;
  const selectedCityNames = Array.from(selectedCities).map(cityLabel).sort();
  const citySummary = allCities
    ? "All cities"
    : selectedCities.size === 0
      ? "No cities"
      : selectedCities.size === 1
        ? selectedCityNames[0]
        : `${selectedCities.size} cities`;
  const activeFilterCount = [
    category !== "all",
    showKidsOnly,
    showFreeOnly,
    showTonightOnly,
    showWeekendOnly,
    showLiveNowOnly,
    showJustAddedOnly,
    !!activeHeritage,
    !!activeThemedHolidayId,
    !allCities,
  ].filter(Boolean).length;
  const visibleEventCount = isSearching
    ? searchResults.length
    : showWeekendOnly
      ? weekendGroups.reduce((sum, [, events]) => sum + events.length, 0)
      : dayEvents.length;
  const modeTitle = isSearching
    ? "Search results"
    : showWeekendOnly
      ? "This weekend"
      : showTonightOnly
        ? "Tonight"
        : showLiveNowOnly
          ? "Live now"
          : dayLbl.primary;
  const modeSubtitle = isSearching
    ? `${searchResults.length} result${searchResults.length === 1 ? "" : "s"} for "${search}"`
    : showWeekendOnly
      ? `${shortDateLabel(weekendSat)} to ${shortDateLabel(weekendSun)}`
      : `${dayLbl.secondary} · ${visibleEventCount} event${visibleEventCount === 1 ? "" : "s"}`;

  const chooseDate = (iso: string) => {
    setSelectedDate(iso);
    setActiveThemedHolidayId(null);
    if (iso !== todayIso) setShowLiveNowOnly(false);
  };

  const clearFilters = () => {
    setSearch("");
    setCategory("all");
    setShowKidsOnly(false);
    setShowFreeOnly(false);
    setShowTonightOnly(false);
    setShowWeekendOnly(false);
    setShowLiveNowOnly(false);
    setShowJustAddedOnly(false);
    setActiveHeritageId(null);
    setActiveThemedHolidayId(null);
    if (!allCities) onToggleAllCities();
  };

  return (
    <div className="sb-events-page">
      <PageHero
        headingId="events-heading"
        eyebrow="South Bay / Calendar"
        title="Events"
        description="Concerts, library programs, markets, games, talks, festivals, and neighborhood things worth putting on the calendar."
        stats={[
          { value: upcomingEvents.length, label: "Upcoming" },
          { value: eventCountByDate[todayIso] ?? 0, label: "Today" },
          { value: ongoingEvents.length, label: "Exhibits" },
        ]}
      />

      <section className="sb-events-controls" aria-label="Find events">
        <div className="sb-events-nowline">
          <button
            type="button"
            onClick={() => prevDate && chooseDate(prevDate)}
            disabled={!prevDate || isSearching || showWeekendOnly}
            aria-label="Previous day"
            className="sb-events-day-arrow"
          >
            &larr;
          </button>
          <div className="sb-events-nowline-text">
            <div className="sb-events-mode-title">{modeTitle}</div>
            <div className="sb-events-mode-subtitle">{modeSubtitle}</div>
          </div>
          <button
            type="button"
            onClick={() => nextDate && chooseDate(nextDate)}
            disabled={!nextDate || isSearching || showWeekendOnly}
            aria-label="Next day"
            className="sb-events-day-arrow"
          >
            &rarr;
          </button>
        </div>

        {!isSearching && !showWeekendOnly && !showTonightOnly && (
          <div className="sb-events-date-rail" role="tablist" aria-label="Pick a day">
            {Array.from({ length: 7 }, (_, i) => addDays(todayIso, i)).map((iso) => {
              const active = iso === selectedDate;
              const count = eventCountByDate[iso] ?? 0;
              const empty = count === 0;
              const d = new Date(iso + "T12:00:00");
              const wkd = d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
              const dayNum = d.getDate();
              const isToday = iso === todayIso;
              const holiday = holidayOn(iso);
              const ariaLabel = `${wkd} ${dayNum}, ${count} event${count === 1 ? "" : "s"}${holiday ? `, ${holiday.label}` : ""}`;
              return (
                <button
                  key={iso}
                  role="tab"
                  aria-selected={active}
                  aria-label={ariaLabel}
                  title={holiday ? holiday.label : undefined}
                  disabled={empty && !active}
                  onClick={() => chooseDate(iso)}
                  className={`sb-events-date-pill${active ? " is-active" : ""}${empty ? " is-empty" : ""}`}
                >
                  {holiday && <span className="sb-events-date-holiday" aria-hidden>{holiday.emoji}</span>}
                  <span className="sb-events-date-weekday">{isToday ? "TODAY" : wkd}</span>
                  <span className="sb-events-date-number">{dayNum}</span>
                  <span className="sb-events-date-count">{count}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="sb-events-toolrow">
          <label className="sb-events-search">
            <span className="sb-events-search-icon" aria-hidden>Search</span>
            <input
              type="search"
              placeholder="Event, venue, or city"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => setWantFullFeed(true)}
            />
          </label>

          <label className="sb-events-select-wrap">
            <span>Category</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as EventCategory | "all")}
              className="sb-events-select"
            >
              {EVENT_CATEGORIES.map((cat) => {
                const count = categoryCounts[cat.id] ?? 0;
                const label = cat.id === "all" ? "All categories" : cat.label;
                return (
                  <option key={cat.id} value={cat.id}>
                    {label}{count > 0 ? ` (${count})` : ""}
                  </option>
                );
              })}
            </select>
          </label>

          <details className="sb-events-refine">
            <summary>Area: {citySummary}</summary>
            <div className="sb-events-city-panel">
              <button
                type="button"
                onClick={onToggleAllCities}
                aria-pressed={allCities}
                className={`sb-events-city-chip${allCities ? " is-active" : ""}`}
              >
                All cities
                {cityCounts.total > 0 && <span>{cityCounts.total}</span>}
              </button>
              {CITIES.map((c) => {
                const inSelection = selectedCities.has(c.id);
                const count = cityCounts.perCity[c.id] ?? 0;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onToggleCity(c.id)}
                    aria-pressed={inSelection}
                    className={`sb-events-city-chip${inSelection ? " is-active" : ""}`}
                  >
                    {c.name}
                    {count > 0 && <span>{count}</span>}
                  </button>
                );
              })}
            </div>
          </details>
        </div>

        <div className="sb-events-toggle-row" aria-label="Quick filters">
          <button
            type="button"
            aria-pressed={showKidsOnly}
            onClick={() => setShowKidsOnly((v) => !v)}
            className={`sb-events-toggle${showKidsOnly ? " is-active" : ""}`}
          >
            Kids {pillCounts.kids > 0 && <span>{pillCounts.kids}</span>}
          </button>
          <button
            type="button"
            aria-pressed={showFreeOnly}
            onClick={() => setShowFreeOnly((v) => !v)}
            className={`sb-events-toggle${showFreeOnly ? " is-active" : ""}`}
            style={{ "--toggle-accent": "#15803D" } as React.CSSProperties}
          >
            Free {pillCounts.free > 0 && <span>{pillCounts.free}</span>}
          </button>
          {pillCounts.live > 0 && (
            <button
              type="button"
              aria-pressed={showLiveNowOnly}
              onClick={() => {
                const next = !showLiveNowOnly;
                setShowLiveNowOnly(next);
                if (next) {
                  chooseDate(todayIso);
                  setShowTonightOnly(false);
                  setShowWeekendOnly(false);
                }
              }}
              className={`sb-events-toggle sb-events-toggle--live${showLiveNowOnly ? " is-active" : ""}`}
              style={{ "--toggle-accent": "#DC2626" } as React.CSSProperties}
            >
              Live now <span>{pillCounts.live}</span>
            </button>
          )}
          <button
            type="button"
            aria-pressed={showTonightOnly}
            onClick={() => {
              const next = !showTonightOnly;
              setShowTonightOnly(next);
              if (next) {
                chooseDate(todayIso);
                setShowWeekendOnly(false);
                setShowLiveNowOnly(false);
              }
            }}
            className={`sb-events-toggle${showTonightOnly ? " is-active" : ""}`}
            style={{ "--toggle-accent": "#7C3AED" } as React.CSSProperties}
          >
            Tonight {pillCounts.tonight > 0 && <span>{pillCounts.tonight}</span>}
          </button>
          <button
            type="button"
            aria-pressed={showWeekendOnly}
            onClick={() => {
              const next = !showWeekendOnly;
              setShowWeekendOnly(next);
              if (next) {
                setShowTonightOnly(false);
                setShowLiveNowOnly(false);
              }
            }}
            className={`sb-events-toggle${showWeekendOnly ? " is-active" : ""}`}
            style={{ "--toggle-accent": "#EA580C" } as React.CSSProperties}
          >
            Weekend {pillCounts.weekend > 0 && <span>{pillCounts.weekend}</span>}
          </button>
          {pillCounts.justAdded > 0 && (
            <button
              type="button"
              aria-pressed={showJustAddedOnly}
              onClick={() => setShowJustAddedOnly((v) => !v)}
              className={`sb-events-toggle${showJustAddedOnly ? " is-active" : ""}`}
              style={{ "--toggle-accent": "#0E7490" } as React.CSSProperties}
            >
              New {pillCounts.justAdded > 0 && <span>{pillCounts.justAdded}</span>}
            </button>
          )}
          {activeFilterCount > 0 && (
            <button type="button" onClick={clearFilters} className="sb-events-clear">
              Clear {activeFilterCount}
            </button>
          )}
        </div>
      </section>

      {isSearching ? (
        <section className="sb-events-results">
          {searchResults.length === 0 && (
            <div className="sb-empty">
              <div className="sb-empty-title">No matches for &ldquo;{search.trim()}&rdquo;</div>
              <div className="sb-empty-sub">Try a broader search or clear a filter.</div>
            </div>
          )}
          {searchGroups.map(([date, events]) => (
            <div key={date} className="sb-events-group">
              <div className="sb-events-group-header">
                <span>{shortDateLabel(date)}</span>
                <small>{events.length} event{events.length === 1 ? "" : "s"}</small>
              </div>
              <div className="sb-events-list">
                {events.map((event) => <UpcomingEventCard key={event.id} event={event} recurring={recurringFor(event)} todayIso={todayIso} nowMins={nowMins} />)}
              </div>
            </div>
          ))}
        </section>
      ) : showWeekendOnly ? (
        <section className="sb-events-results">
          {weekendGroups.length === 0 && (
            <div className="sb-empty">
              <div className="sb-empty-title">Nothing matches</div>
              <div className="sb-empty-sub">Try clearing a filter or searching the full calendar.</div>
            </div>
          )}
          {weekendGroups.map(([date, events]) => (
            <div key={date} className="sb-events-group">
              <div className="sb-events-group-header">
                <span>{shortDateLabel(date)}</span>
                <small>{events.length} event{events.length === 1 ? "" : "s"}</small>
              </div>
              <div className="sb-events-list">
                {events.map((event) => <UpcomingEventCard key={event.id} event={event} recurring={recurringFor(event)} todayIso={todayIso} nowMins={nowMins} />)}
              </div>
            </div>
          ))}
        </section>
      ) : (
        <section className="sb-events-results">
          {themedHoliday && selectedDate === themedHoliday.iso && (
            <div
              className="sb-events-active-note"
              style={{
                "--note-bg": themedHoliday.holiday.bg,
                "--note-color": themedHoliday.holiday.color,
              } as React.CSSProperties}
            >
              <span aria-hidden>{themedHoliday.holiday.emoji}</span>
              <span style={{ fontWeight: 600 }}>
                Showing {themedHoliday.holiday.label} picks only
              </span>
              <button type="button" onClick={() => setActiveThemedHolidayId(null)}>Show all</button>
            </div>
          )}

          {isLoadingEvents ? (
            <div className="sb-loading"><div className="sb-spinner" /><div className="sb-loading-text">Loading events...</div></div>
          ) : dayEvents.length === 0 ? (
            <div className="sb-empty">
              <div className="sb-empty-title">Nothing on the calendar</div>
              <div className="sb-empty-sub">
                Try a different day, fewer filters, or search for something specific.
              </div>
            </div>
          ) : (
            <div className="sb-events-list">
              {dayEvents.map((event) => <UpcomingEventCard key={event.id} event={event} recurring={recurringFor(event)} todayIso={todayIso} nowMins={nowMins} />)}
            </div>
          )}
        </section>
      )}

      {filteredOngoing.length > 0 && (
        <section className="sb-events-exhibits">
          <div className="sb-events-group-header">
            <span>Exhibits</span>
            <small>{filteredOngoing.length} on view</small>
          </div>
          <div className="sb-events-list">
            {filteredOngoing.map((event) => <UpcomingEventCard key={event.id} event={event} recurring={recurringFor(event)} todayIso={todayIso} nowMins={nowMins} />)}
          </div>
        </section>
      )}
    </div>
  );
}
