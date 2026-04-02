import { useState, useMemo } from "react";
import type { City } from "../../../lib/south-bay/types";
import {
  SOUTH_BAY_EVENTS,
  EVENT_CATEGORIES,
  type SBEvent,
  type EventCategory,
} from "../../../data/south-bay/events-data";
import upcomingJson from "../../../data/south-bay/upcoming-events.json";

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
  homeCity: City | null;
}

type ViewMode = "upcoming" | "recurring" | "venues";

// ── South Bay venues (auto-discovered from events + curated overrides) ──

interface SBVenue {
  id: string;
  name: string;
  venueMatch: string; // substring match against event.venue
  cityFilter?: string; // also require event.city === cityFilter (for shared venue names like SCCL)
  city: string;
  cityLabel: string;
  emoji: string;
  tags: string;
}

// Curated display overrides for known venues (emoji, friendly name, tags)
const VENUE_OVERRIDES: Record<string, Partial<SBVenue>> = {
  "SAP Center":                            { emoji: "🏟️", tags: "Arena · Sports · Concerts", name: "SAP Center" },
  "San Jose Center for the Performing":    { emoji: "🎭", tags: "Theater · Broadway · Opera", name: "SJ Center for the Performing Arts" },
  "California Theatre":                    { emoji: "🎼", tags: "Opera · Classical · Theater" },
  "San Jose Civic":                        { emoji: "🎵", tags: "Concerts · Shows" },
  "San Jose Improv":                       { emoji: "🎤", tags: "Comedy · Music" },
  "The Ritz":                              { emoji: "🎸", tags: "Music · Indie" },
  "Tech CU Arena":                         { emoji: "🏀", tags: "Sports · Events" },
  "PayPal Park":                           { emoji: "⚽", tags: "Soccer · Sports" },
  "Excite Ballpark":                       { emoji: "⚾", tags: "Baseball · MiLB" },
  "McEnery Convention Center":             { emoji: "🎪", tags: "Conventions · Special Events" },
  "Discovery Meadows":                     { emoji: "🌿", tags: "Outdoor · Family" },
  "Happy Hollow":                          { emoji: "🦁", tags: "Family · Zoo", name: "Happy Hollow Park & Zoo" },
  "San Jose Public Library":               { emoji: "📚", tags: "Library · Classes · Family" },
  "MACLA":                                 { emoji: "🎨", tags: "Art · Latinx · Theater" },
  "Shoreline Amphitheatre":                { emoji: "🎵", tags: "Outdoor Concerts" },
  "Mountain View Center for the Performing": { emoji: "🎭", tags: "Theater · Dance · Music", name: "Mountain View Center for the Performing Arts" },
  "Computer History Museum":               { emoji: "💾", tags: "Tech · Exhibits · Talks" },
  "Mountain View Public Library":          { emoji: "📚", tags: "Library · Classes · Family" },
  "Levi's Stadium":                        { emoji: "🏈", tags: "Football · Concerts · Events" },
  "Triton Museum":                         { emoji: "🖼️", tags: "Art · Exhibits · Free", name: "Triton Museum of Art" },
  "Frost Amphitheatre":                    { emoji: "🌙", tags: "Outdoor Concerts" },
  "Cantor Arts Center":                    { emoji: "🗿", tags: "Art · Exhibits · Free" },
  "Palo Alto City Library":                { emoji: "📚", tags: "Library · Classes · Family" },
  "Montalvo":                              { emoji: "🎶", tags: "Concerts · Arts · Outdoor", name: "Montalvo Arts Center" },
  "Sunnyvale Public Library":              { emoji: "📚", tags: "Library · Classes · Family" },
  "Heritage Theatre":                      { emoji: "🎭", tags: "Concerts · Theater · Events" },
  "SJZ Break Room":                        { emoji: "🎷", tags: "Jazz · Live Music · Free" },
  "Santa Clara University":                { emoji: "🎓", tags: "University · Talks · Arts" },
  "San Jose State University":             { emoji: "🎓", tags: "University · Events · Sports" },
  "Hacker Dojo":                           { emoji: "💻", tags: "Tech · Meetups · Coworking" },
  "De Anza College":                       { emoji: "🎓", tags: "College · Community · Arts" },
  "West Valley College":                   { emoji: "🎓", tags: "College · Community" },
  "San Jose City College":                 { emoji: "🎓", tags: "College · Community" },
  "Mission College":                       { emoji: "🎓", tags: "College · Community" },
};

// Venues that share a name but should be split by city (e.g. "Santa Clara County Library")
const SPLIT_BY_CITY: Record<string, Record<string, string>> = {
  "Santa Clara County Library": {
    "los-gatos": "Los Gatos Library",
    "campbell": "Campbell Library",
    "milpitas": "Milpitas Library",
    "cupertino": "Cupertino Library",
    "saratoga": "Saratoga Library",
    "los-altos": "Los Altos Library",
  },
};

const CITY_LABELS: Record<string, string> = {
  "san-jose": "San Jose", "campbell": "Campbell", "los-gatos": "Los Gatos",
  "saratoga": "Saratoga", "cupertino": "Cupertino", "santa-clara": "Santa Clara",
  "sunnyvale": "Sunnyvale", "mountain-view": "Mountain View", "palo-alto": "Palo Alto",
  "milpitas": "Milpitas", "los-altos": "Los Altos",
};

// Category → emoji fallback for auto-discovered venues
const CATEGORY_EMOJI: Record<string, string> = {
  music: "🎵", arts: "🎨", sports: "⚽", education: "📚", family: "👨‍👩‍👦",
  community: "🤝", outdoor: "🌳", food: "🍽️", market: "🥦",
};

const MIN_EVENTS_FOR_VENUE = 3;

// Build venues dynamically from event data
function buildVenuesFromEvents(events: UpcomingEvent[]): SBVenue[] {
  // Group events by venue+city, handling SCCL split
  const groups = new Map<string, { venue: string; city: string; events: UpcomingEvent[] }>();

  for (const e of events) {
    if (!e.venue || e.ongoing) continue;
    const splitMap = SPLIT_BY_CITY[e.venue];
    const displayName = splitMap?.[e.city] ?? e.venue;
    const key = `${displayName}|||${splitMap ? e.city : ""}`;

    if (!groups.has(key)) {
      groups.set(key, { venue: displayName, city: e.city, events: [] });
    }
    groups.get(key)!.events.push(e);
  }

  // Convert to SBVenue, filtering by minimum event count
  const venues: SBVenue[] = [];
  for (const [, g] of groups) {
    if (g.events.length < MIN_EVENTS_FOR_VENUE) continue;

    // Find override by checking if any override key is a substring of the venue name
    const overrideKey = Object.keys(VENUE_OVERRIDES).find(
      (k) => g.venue.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(g.venue.toLowerCase()),
    );
    const override = overrideKey ? VENUE_OVERRIDES[overrideKey] : undefined;

    // Infer most common category for auto-discovered venues
    const catCounts: Record<string, number> = {};
    for (const e of g.events) { catCounts[e.category] = (catCounts[e.category] || 0) + 1; }
    const topCat = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "community";

    const id = g.venue.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "").slice(0, 30);
    const cityLabel = CITY_LABELS[g.city] ?? g.city.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

    venues.push({
      id,
      name: override?.name ?? g.venue,
      venueMatch: g.venue,
      city: g.city,
      cityLabel: override?.cityLabel ?? cityLabel,
      emoji: override?.emoji ?? CATEGORY_EMOJI[topCat] ?? "📍",
      tags: override?.tags ?? topCat.charAt(0).toUpperCase() + topCat.slice(1),
    });
  }

  // Sort: most events first
  venues.sort((a, b) => {
    const aCount = groups.get(`${a.venueMatch}|||${SPLIT_BY_CITY[a.venueMatch] ? a.city : ""}`)?.events.length ?? 0;
    const bCount = groups.get(`${b.venueMatch}|||${SPLIT_BY_CITY[b.venueMatch] ? b.city : ""}`)?.events.length ?? 0;
    return bCount - aCount;
  });

  return venues;
}

// ── Upcoming event type (from scraped JSON) ──

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
}

const allUpcomingEvents = (upcomingJson as { events: UpcomingEvent[] }).events || [];
const upcomingEvents = allUpcomingEvents.filter((e) => !e.ongoing);
const ongoingEvents = allUpcomingEvents.filter((e) => e.ongoing);
const upcomingSources = (upcomingJson as { sources: string[] }).sources || [];

// ── Time helpers ──

function formatTimeRange(time: string | null, endTime: string | null, isSports = false): string | null {
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

function parseTimeToMinutes(t: string): number | null {
  const m = t.trim().match(/^(\d+)(?::(\d+))?\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2] ?? "0");
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && h !== 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return h * 60 + min;
}

// ── Recurring event helpers ──

function isEventActiveToday(event: SBEvent, now: Date): boolean {
  const month = now.getMonth() + 1;
  if (event.months && !event.months.includes(month)) return false;
  if (!event.days) return true;
  return event.days.includes(
    ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][now.getDay()] as SBEvent["days"] extends (infer T)[] ? T : never
  );
}

function recurrenceLabel(event: SBEvent): string {
  if (event.recurrence === "ongoing") return "Always open";
  if (event.recurrence === "seasonal") {
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    if (event.months) {
      return `${monthNames[(event.months[0] ?? 1) - 1]}–${monthNames[(event.months[event.months.length - 1] ?? 12) - 1]}`;
    }
    return "Seasonal";
  }
  if (event.recurrence === "monthly") return "Monthly";
  if (event.recurrence === "biweekly") return "Every 2 weeks";
  if (event.days) {
    if (event.days.length === 1) {
      return `Every ${event.days[0].charAt(0).toUpperCase() + event.days[0].slice(1)}`;
    }
    return `${event.days.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(", ")}`;
  }
  return "Weekly";
}

// ── Cost badge ──

function costBadge(cost: string): { label: string; bg: string; fg: string; border: string } {
  if (cost === "free") return { label: "FREE", bg: "#F0FDF4", fg: "#166534", border: "#BBF7D0" };
  if (cost === "low") return { label: "$", bg: "#FFF7ED", fg: "#92400E", border: "#FDE68A" };
  return { label: "$$", bg: "#F5F3FF", fg: "#5B21B6", border: "#DDD6FE" };
}

function cityLabel(city: string) {
  return city.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// ── Category accent colors ──

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

// ── Upcoming Event Card ──

function UpcomingEventCard({ event }: { event: UpcomingEvent }) {
  const badge = costBadge(event.cost);
  const showBadge = !(event.cost === "free" && event.category === "community");
  const accent = CATEGORY_ACCENT[event.category] ?? CATEGORY_ACCENT.community;

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: "var(--sb-radius-lg, 6px)",
        border: "1.5px solid var(--sb-border-light)",
        borderLeft: `4px solid ${accent.color}`,
        padding: "11px 14px",
        display: "flex",
        gap: 12,
        transition: "box-shadow 0.15s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "var(--sb-shadow-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "none")}
    >
      {/* Category emoji column */}
      <div style={{
        width: 32, height: 32, borderRadius: 6, flexShrink: 0,
        background: accent.bg, display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 16, marginTop: 1,
      }}>
        {accent.emoji}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Category label + cost badge row */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <span style={{
            fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
            letterSpacing: "0.1em", textTransform: "uppercase", color: accent.color,
          }}>
            {accent.label}
          </span>
          {showBadge && (
            <span style={{
              fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
              letterSpacing: "0.04em", padding: "1px 5px", borderRadius: 3,
              background: badge.bg, color: badge.fg, border: `1px solid ${badge.border}`,
            }}>
              {badge.label}
            </span>
          )}
          {event.kidFriendly && (
            <span style={{ fontSize: 9, color: "var(--sb-muted)" }}>👶</span>
          )}
        </div>

        {/* Title */}
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--sb-ink)", lineHeight: 1.3, marginBottom: 4 }}>
          {event.url ? (
            <a
              href={event.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "inherit", textDecoration: "none" }}
              onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
              onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
            >
              {meetingDisplayTitle(event.title, event.city)}
            </a>
          ) : meetingDisplayTitle(event.title, event.city)}
        </div>

        {/* Meta row */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 8px", fontSize: 11, color: "var(--sb-muted)" }}>
          {event.time && (
            <span style={{ fontWeight: 600, color: "var(--sb-ink)", fontSize: 11 }}>
              {formatTimeRange(event.time, event.endTime, event.category === "sports")}
            </span>
          )}
          {event.time && (event.venue || event.city) && <span style={{ color: "var(--sb-border)" }}>·</span>}
          {event.venue
            ? <span>{event.venue}</span>
            : <span>{cityLabel(event.city)}</span>
          }
          {event.venue && <span style={{ color: "var(--sb-border)" }}>·</span>}
          {event.venue && <span>{cityLabel(event.city)}</span>}
        </div>

        {/* Description */}
        {event.description && (
          <p style={{ margin: "5px 0 0", fontSize: 11, lineHeight: 1.5, color: "var(--sb-muted)" }}>
            {event.description}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Recurring Event Card ──

function RecurringEventCard({ event }: { event: SBEvent }) {
  const badge = costBadge(event.cost);
  const now = new Date();
  const activeToday = isEventActiveToday(event, now);
  const accent = CATEGORY_ACCENT[event.category] ?? CATEGORY_ACCENT.community;

  return (
    <div
      style={{
        background: "#fff",
        border: "1.5px solid var(--sb-border-light)",
        borderLeft: `4px solid ${accent.color}`,
        borderRadius: "var(--sb-radius-lg, 6px)",
        padding: "11px 14px",
        display: "flex",
        gap: 12,
        transition: "box-shadow 0.15s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "var(--sb-shadow-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "none")}
    >
      <div style={{
        width: 32, height: 32, borderRadius: 6, flexShrink: 0,
        background: accent.bg, display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 16, marginTop: 1,
      }}>
        {event.emoji}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <span style={{
            fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
            letterSpacing: "0.1em", textTransform: "uppercase", color: accent.color,
          }}>
            {accent.label}
          </span>
          <span style={{
            flexShrink: 0, fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
            letterSpacing: "0.04em", padding: "1px 5px", borderRadius: 3,
            background: badge.bg, color: badge.fg, border: `1px solid ${badge.border}`,
          }}>
            {badge.label}
          </span>
          {activeToday && (
            <span style={{ fontSize: 9, fontWeight: 700, color: "#16803C", fontFamily: "'Space Mono', monospace" }}>
              ✓ TODAY
            </span>
          )}
        </div>

        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--sb-ink)", lineHeight: 1.3, marginBottom: 4 }}>
          {event.url ? (
            <a href={event.url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}
              onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
              onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
            >{event.title}</a>
          ) : event.title}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 8px", fontSize: 11, color: "var(--sb-muted)", marginBottom: 4 }}>
          <span style={{ fontWeight: 600 }}>{recurrenceLabel(event)}</span>
          {event.time && <><span style={{ color: "var(--sb-border)" }}>·</span><span>{event.time}</span></>}
          <span style={{ color: "var(--sb-border)" }}>·</span>
          <span>{cityLabel(event.city)}</span>
          {event.kidFriendly && <><span style={{ color: "var(--sb-border)" }}>·</span><span>👶 Kid-friendly</span></>}
        </div>

        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: "var(--sb-muted)" }}>
          {event.description}
        </p>
      </div>
    </div>
  );
}

// ── Date grouping helpers ──

function getDateGroupLabel(dateIso: string, todayIso: string, tomorrowIso: string, weekEndIso: string): string {
  if (dateIso === todayIso) return "Today";
  if (dateIso === tomorrowIso) return "Tomorrow";
  if (dateIso <= weekEndIso) return "This Week";
  return "Later";
}

const DATE_GROUP_ORDER = ["Today", "Tomorrow", "This Week", "Later"];

// ── Main View ──

// ── Spring Break constants ──────────────────────────────────────────────────
const SB_BANNER_START = "2026-03-29"; // show banner from now through end of break
const SB_BREAK_START  = "2026-04-03"; // Easter weekend / first district break starts
const SB_BREAK_WK1    = "2026-04-10"; // end of first break window
const SB_BREAK_END    = "2026-04-17"; // end of second break window

export default function EventsView({ selectedCities, homeCity }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("upcoming");
  const [category, setCategory] = useState<EventCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [showKidsOnly, setShowKidsOnly] = useState(false);
  const [showAllLater, setShowAllLater] = useState(false);
  const [selectedVenue, setSelectedVenue] = useState<string | null>(null);
  const [springBreakMode, setSpringBreakMode] = useState(false);

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const primary = homeCity ?? "san-jose";

  const todayIso = now.toISOString().split("T")[0];
  const tomorrowIso = new Date(now.getTime() + 86400000).toISOString().split("T")[0];
  const weekEndIso = new Date(now.getTime() + 7 * 86400000).toISOString().split("T")[0];

  const showSpringBreakBanner = todayIso >= SB_BANNER_START && todayIso <= SB_BREAK_END;
  const daysUntilBreak = Math.ceil((new Date(SB_BREAK_START).getTime() - now.getTime()) / 86400000);
  const breakInProgress = todayIso >= SB_BREAK_START && todayIso <= SB_BREAK_END;

  // ── Dynamic venue list (auto-discovered from event data) ──
  const SOUTH_BAY_VENUES = useMemo(() => buildVenuesFromEvents(allUpcomingEvents), []);

  // ── Upcoming events (scraped, specific dates) ──
  const filteredUpcoming = useMemo(() => {
    const allCities = selectedCities.size === 11;
    const filtered = upcomingEvents.filter((e) => {
      if (!allCities && !selectedCities.has(e.city as City)) return false;
      if (category !== "all" && e.category !== category) return false;
      if (showKidsOnly && !e.kidFriendly) return false;
      // Hide today's events once they've started
      if (e.date === todayIso && !hasNotStarted(e.time)) return false;
      // Spring break mode: show only Apr 3-17 events
      if (springBreakMode && (e.date < SB_BREAK_START || e.date > SB_BREAK_END)) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!e.title.toLowerCase().includes(q) && !e.description.toLowerCase().includes(q) &&
            !e.city.toLowerCase().includes(q) && !e.venue.toLowerCase().includes(q)) return false;
      }
      return true;
    });

    // Source diversity: count how many events each source contributes after filtering.
    // Within the same date, events from less-represented sources sort first — so a
    // Campbell library story time beats the 200th SCU lecture.
    const srcCounts: Record<string, number> = {};
    for (const e of filtered) srcCounts[e.source] = (srcCounts[e.source] || 0) + 1;

    return filtered.sort((a, b) => {
      // 1. Home city always first
      const aHome = a.city === primary ? 1 : 0;
      const bHome = b.city === primary ? 1 : 0;
      if (aHome !== bHome) return bHome - aHome;
      // 2. Date ascending
      const dateCmp = (a.date || "").localeCompare(b.date || "");
      if (dateCmp !== 0) return dateCmp;
      // 3. Same date: sort by start time (no time = end of day)
      const aMin = a.time ? (parseTimeToMinutes(a.time) ?? 9999) : 9999;
      const bMin = b.time ? (parseTimeToMinutes(b.time) ?? 9999) : 9999;
      if (aMin !== bMin) return aMin - bMin;
      // 4. Same date+time: boost under-represented sources
      return (srcCounts[a.source] || 0) - (srcCounts[b.source] || 0);
    });
  }, [selectedCities, category, showKidsOnly, search, primary, springBreakMode, todayIso]);

  // ── Recurring events (static, weekly/monthly/seasonal) ──
  const filteredRecurring = useMemo(() => {
    const allCities = selectedCities.size === 11;
    return SOUTH_BAY_EVENTS
      .filter((e) => {
        if ((e as any).startDate && todayIso < (e as any).startDate) return false;
        if (!allCities && !selectedCities.has(e.city)) return false;
        if (e.months && !e.months.includes(currentMonth)) return false;
        if (category !== "all" && e.category !== category) return false;
        if (showKidsOnly && !e.kidFriendly) return false;
        if (search) {
          const q = search.toLowerCase();
          if (!e.title.toLowerCase().includes(q) && !e.description.toLowerCase().includes(q) &&
              !e.city.toLowerCase().includes(q) && !e.venue.toLowerCase().includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aHome = a.city === primary ? 1 : 0;
        const bHome = b.city === primary ? 1 : 0;
        if (aHome !== bHome) return bHome - aHome;
        if (a.featured && !b.featured) return -1;
        if (!a.featured && b.featured) return 1;
        return 0;
      });
  }, [selectedCities, category, showKidsOnly, search, currentMonth, primary]);

  const activeList = viewMode === "upcoming" ? filteredUpcoming : viewMode === "recurring" ? filteredRecurring : [];

  // Ongoing/exhibits — separate filtered list, city/category/search aware
  const filteredOngoing = useMemo(() => {
    const allCities = selectedCities.size === 11;
    return ongoingEvents.filter((e) => {
      if (!allCities && !selectedCities.has(e.city as City)) return false;
      if (category !== "all" && e.category !== category) return false;
      if (showKidsOnly && !e.kidFriendly) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!e.title.toLowerCase().includes(q) && !(e.description || "").toLowerCase().includes(q) &&
            !e.city.toLowerCase().includes(q) && !e.venue.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [selectedCities, category, showKidsOnly, search]);

  // ── Venue events (events grouped by venue) ──
  const venueEvents = useMemo(() => {
    const result: Record<string, UpcomingEvent[]> = {};
    for (const v of SOUTH_BAY_VENUES) {
      result[v.id] = allUpcomingEvents
        .filter((e) => {
          if (!e.venue) return false;
          // For split-by-city venues (SCCL branches), match the original venue name + city
          const splitMap = SPLIT_BY_CITY[e.venue];
          if (splitMap) {
            return splitMap[e.city] === v.name;
          }
          return e.venue.toLowerCase().includes(v.venueMatch.toLowerCase());
        })
        .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    }
    return result;
  }, [SOUTH_BAY_VENUES]);

  // Events at selected venue, with search/category/kids filter applied
  const venueFilteredEvents = useMemo(() => {
    if (!selectedVenue) return [];
    const v = SOUTH_BAY_VENUES.find((x) => x.id === selectedVenue);
    if (!v) return [];
    return allUpcomingEvents
      .filter((e) => {
        if (!e.venue) return false;
        const splitMap = SPLIT_BY_CITY[e.venue];
        if (splitMap) {
          if (splitMap[e.city] !== v.name) return false;
        } else if (!e.venue.toLowerCase().includes(v.venueMatch.toLowerCase())) return false;
        if (category !== "all" && e.category !== category) return false;
        if (showKidsOnly && !e.kidFriendly) return false;
        if (search) {
          const q = search.toLowerCase();
          if (!e.title.toLowerCase().includes(q) && !e.venue.toLowerCase().includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  }, [selectedVenue, category, showKidsOnly, search]);

  // Group upcoming events by date bucket
  const groupedUpcoming = useMemo(() => {
    if (springBreakMode) {
      // Spring break: group by week, with Easter weekend as its own group if present
      const groups: Record<string, UpcomingEvent[]> = {};
      for (const e of filteredUpcoming) {
        let label: string;
        if (e.date < SB_BREAK_START) {
          label = "Easter Weekend";
        } else if (e.date <= SB_BREAK_WK1) {
          label = "Spring Break · Wk 1 (Apr 3–10)";
        } else {
          label = "Spring Break · Wk 2 (Apr 13–17)";
        }
        if (!groups[label]) groups[label] = [];
        groups[label].push(e);
      }
      const order = ["Easter Weekend", "Spring Break · Wk 1 (Apr 3–10)", "Spring Break · Wk 2 (Apr 13–17)"];
      return order.filter((g) => groups[g]?.length > 0).map((label) => ({ label, events: groups[label] }));
    }

    const groups: Record<string, UpcomingEvent[]> = {};
    for (const e of filteredUpcoming) {
      const label = getDateGroupLabel(e.date || "", todayIso, tomorrowIso, weekEndIso);
      if (!groups[label]) groups[label] = [];
      groups[label].push(e);
    }
    return DATE_GROUP_ORDER.filter((g) => groups[g]?.length > 0).map((label) => ({
      label,
      events: groups[label],
    }));
  }, [filteredUpcoming, todayIso, tomorrowIso, weekEndIso, springBreakMode]);

  return (
    <>
      <div className="sb-section-header">
        <span className="sb-section-title">
          Events
          <span style={{ fontSize: 13, fontWeight: 400, color: "var(--sb-muted)", marginLeft: 8 }}>
            {upcomingEvents.length} upcoming · {SOUTH_BAY_EVENTS.length} recurring
            {ongoingEvents.length > 0 && ` · ${ongoingEvents.length} ongoing`}
          </span>
        </span>
        <div className="sb-section-line" />
      </div>

      {/* View mode toggle */}
      <div style={{ display: "flex", gap: 0, marginBottom: 12 }}>
        {([
          { mode: "upcoming" as ViewMode,  label: `Upcoming (${filteredUpcoming.length})`, borderRadius: "6px 0 0 6px", ml: 0 },
          { mode: "recurring" as ViewMode, label: `Recurring (${filteredRecurring.length})`, borderRadius: "0", ml: -1.5 },
          { mode: "venues" as ViewMode,    label: "Venues", borderRadius: "0 6px 6px 0", ml: -1.5 },
        ]).map(({ mode, label, borderRadius, ml }) => {
          const active = viewMode === mode;
          return (
            <button
              key={mode}
              onClick={() => { setViewMode(mode); setSelectedVenue(null); }}
              style={{
                padding: "6px 16px",
                border: `1.5px solid ${active ? "var(--sb-primary)" : "var(--sb-border)"}`,
                borderRadius,
                background: active ? "var(--sb-primary)" : "#fff",
                color: active ? "#fff" : "var(--sb-muted)",
                fontSize: 12,
                fontWeight: active ? 700 : 400,
                cursor: "pointer",
                fontFamily: "inherit",
                marginLeft: ml,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div style={{ marginBottom: 12 }}>
        <input
          type="search"
          placeholder="Search events, venues, cities…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: "100%", padding: "8px 12px",
            border: "1.5px solid var(--sb-border)", borderRadius: "var(--sb-radius-lg, 6px)",
            fontFamily: "inherit", fontSize: 13, background: "#fff", color: "var(--sb-ink)",
            boxSizing: "border-box", outline: "none",
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = "var(--sb-primary)")}
          onBlur={(e) => (e.currentTarget.style.borderColor = "var(--sb-border)")}
        />
      </div>

      {/* Category pills */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {EVENT_CATEGORIES.map((cat) => {
          const active = category === cat.id;
          return (
            <button
              key={cat.id}
              onClick={() => setCategory(cat.id as EventCategory | "all")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "4px 10px",
                border: `1.5px solid ${active ? "var(--sb-primary)" : "var(--sb-border)"}`,
                borderRadius: 100, background: active ? "var(--sb-primary)" : "#fff",
                color: active ? "#fff" : "var(--sb-muted)",
                fontSize: 12, fontWeight: active ? 600 : 400,
                cursor: "pointer", fontFamily: "inherit", transition: "all 0.12s",
              }}
            >
              <span>{cat.emoji}</span>
              <span>{cat.label}</span>
            </button>
          );
        })}

        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--sb-muted)", cursor: "pointer", userSelect: "none", marginLeft: 8 }}>
          <input type="checkbox" checked={showKidsOnly} onChange={(e) => setShowKidsOnly(e.target.checked)} style={{ cursor: "pointer" }} />
          👶 Kids only
        </label>

        {viewMode !== "venues" && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--sb-light)", fontFamily: "'Space Mono', monospace" }}>
            {activeList.length} events
          </span>
        )}
      </div>

      {/* Spring Break banner */}
      {showSpringBreakBanner && viewMode === "upcoming" && (
        <div
          style={{
            marginBottom: 14,
            padding: "10px 14px",
            background: springBreakMode ? "#fdf4ff" : "#fff8f0",
            border: `1.5px solid ${springBreakMode ? "#d8b4fe" : "#fdba74"}`,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 18, lineHeight: 1 }}>🌸</span>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: "var(--sb-ink)", fontFamily: "var(--sb-sans)" }}>
              {breakInProgress ? "Spring Break is here!" : `Spring Break in ${daysUntilBreak} day${daysUntilBreak === 1 ? "" : "s"}`}
            </div>
            <div style={{ fontSize: 11, color: "var(--sb-muted)", marginTop: 1 }}>
              SJUSD, PAUSD, MVWSD Apr 3–10 · FUHSD, Cupertino USD, Campbell USD Apr 13–17
            </div>
          </div>
          <button
            onClick={() => {
              setSpringBreakMode(!springBreakMode);
              if (!springBreakMode) setViewMode("upcoming");
            }}
            style={{
              padding: "5px 12px",
              background: springBreakMode ? "#a855f7" : "#f97316",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "var(--sb-sans)",
              whiteSpace: "nowrap",
            }}
          >
            {springBreakMode ? "← Show all dates" : "Show spring break events"}
          </button>
        </div>
      )}

      {/* Event cards */}
      {viewMode === "venues" ? (
        selectedVenue ? (
          /* Venue detail: filtered show list */
          <>
            <button
              onClick={() => setSelectedVenue(null)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                marginBottom: 16, background: "none", border: "none",
                color: "var(--sb-primary)", fontSize: 13, fontWeight: 600,
                cursor: "pointer", padding: 0, fontFamily: "inherit",
              }}
            >
              ← All Venues
            </button>
            {venueFilteredEvents.length === 0 ? (
              <div className="sb-empty">
                <div className="sb-empty-title">No shows match your filters</div>
                <div className="sb-empty-sub">Try clearing category or search filters</div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {venueFilteredEvents.map((event) => <UpcomingEventCard key={event.id} event={event} />)}
              </div>
            )}
          </>
        ) : (
          /* Venue grid — only show venues with upcoming events */
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
            {SOUTH_BAY_VENUES.filter((v) => (venueEvents[v.id] ?? []).length > 0).map((v) => {
              const shows = venueEvents[v.id] ?? [];
              const hasShows = shows.length > 0;
              const nextShow = shows[0];
              return (
                <div
                  key={v.id}
                  onClick={() => hasShows && setSelectedVenue(v.id)}
                  style={{
                    background: "#fff",
                    border: "1.5px solid var(--sb-border-light)",
                    borderRadius: 8,
                    padding: "16px",
                    cursor: "pointer",
                    opacity: 1,
                    transition: "box-shadow 0.15s, border-color 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    if (!hasShows) return;
                    e.currentTarget.style.boxShadow = "var(--sb-shadow-hover)";
                    e.currentTarget.style.borderColor = "var(--sb-primary)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.boxShadow = "none";
                    e.currentTarget.style.borderColor = "var(--sb-border-light)";
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <span style={{ fontSize: 26, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>{v.emoji}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "var(--sb-serif)", fontWeight: 700, fontSize: 14, color: "var(--sb-ink)", lineHeight: 1.3, marginBottom: 2 }}>
                        {v.name}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--sb-muted)", marginBottom: 8 }}>
                        {v.cityLabel} · {v.tags}
                      </div>
                      {hasShows ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{
                            fontSize: 10, fontWeight: 700,
                            background: "var(--sb-primary)", color: "#fff",
                            padding: "2px 8px", borderRadius: 100,
                            letterSpacing: "0.03em",
                          }}>
                            {shows.length} upcoming
                          </span>
                          <span style={{ fontSize: 11, color: "var(--sb-muted)" }}>
                            Next: {nextShow?.displayDate}
                          </span>
                        </div>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--sb-light)" }}>No shows in 90 days</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : activeList.length === 0 ? (
        <div className="sb-empty">
          <div className="sb-empty-title">No events match</div>
          <div className="sb-empty-sub">
            Try broadening your filters or selecting more cities
          </div>
        </div>
      ) : viewMode === "upcoming" ? (
        /* Upcoming: grouped by date */
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {groupedUpcoming.map(({ label, events }) => {
            const isLater = label === "Later";
            const visible = isLater && !showAllLater ? events.slice(0, 50) : events;
            return (
              <div key={label} style={{ marginBottom: 24 }}>
                {/* Date group header */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <span style={{
                    fontSize: label === "Today" || label === "Tomorrow" ? 13 : 11,
                    fontWeight: 800,
                    fontFamily: "'Space Mono', monospace",
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: label === "Today" ? "var(--sb-accent)" : "var(--sb-ink)",
                    ...(label === "Today" ? {
                      background: "var(--sb-accent)",
                      color: "#fff",
                      padding: "2px 8px",
                      borderRadius: 4,
                    } : {}),
                  }}>
                    {label}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--sb-light)", fontFamily: "'Space Mono', monospace" }}>
                    {events.length} event{events.length !== 1 ? "s" : ""}
                  </span>
                  <div style={{ flex: 1, height: 1, background: "var(--sb-border-light)" }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {visible.map((event) => (
                    <UpcomingEventCard key={event.id} event={event} />
                  ))}
                </div>
                {isLater && !showAllLater && events.length > 50 && (
                  <button
                    onClick={() => setShowAllLater(true)}
                    style={{
                      display: "block",
                      marginTop: 12,
                      padding: "8px 0",
                      background: "none",
                      border: "none",
                      color: "var(--sb-primary)",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      textDecoration: "underline",
                      textUnderlineOffset: 3,
                    }}
                  >
                    Show {events.length - 50} more events →
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* Recurring: flat list */
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(activeList as SBEvent[]).map((event) => (
            <RecurringEventCard key={event.id} event={event} />
          ))}
        </div>
      )}

      {/* Ongoing / Exhibits section */}
      {(viewMode === "upcoming" || (viewMode === "venues" && selectedVenue)) && filteredOngoing.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, paddingBottom: 6, borderBottom: "2px solid var(--sb-border)" }}>
            <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--sb-muted)" }}>
              Ongoing &amp; Exhibits
            </span>
            <span style={{ fontSize: 10, color: "var(--sb-light)", fontFamily: "'Space Mono', monospace" }}>
              {filteredOngoing.length} showing now
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filteredOngoing.map((event) => (
              <UpcomingEventCard key={event.id} event={event} />
            ))}
          </div>
        </div>
      )}

      {/* Source attribution */}
      <div
        style={{
          marginTop: 20, padding: "12px 14px",
          background: "var(--sb-card)", border: "1px dashed var(--sb-border)",
          borderRadius: "var(--sb-radius-lg, 6px)",
          fontSize: 12, color: "var(--sb-light)", lineHeight: 1.5,
        }}
      >
        <strong style={{ color: "var(--sb-muted)" }}>
          {upcomingEvents.length} upcoming + {ongoingEvents.length} ongoing events from {upcomingSources.length} sources.
        </strong>{" "}
        Via {upcomingSources.join(", ")}.
        {" "}Plus {SOUTH_BAY_EVENTS.length} recurring events across the South Bay.
      </div>
    </>
  );
}
