import { useState, useMemo } from "react";
import type { City } from "../../../lib/south-bay/types";
import {
  SOUTH_BAY_EVENTS,
  EVENT_CATEGORIES,
  type SBEvent,
  type EventCategory,
} from "../../../data/south-bay/events-data";
import upcomingJson from "../../../data/south-bay/upcoming-events.json";

interface Props {
  selectedCities: Set<City>;
  homeCity: City | null;
}

type ViewMode = "upcoming" | "recurring" | "venues";

// ── South Bay entertainment venues ──

interface SBVenue {
  id: string;
  name: string;
  venueMatch: string; // substring match against event.venue
  city: string;
  cityLabel: string;
  emoji: string;
  tags: string;
}

const SOUTH_BAY_VENUES: SBVenue[] = [
  // ── San Jose ──
  { id: "sap-center",      name: "SAP Center",                             venueMatch: "SAP Center",                           city: "san-jose",      cityLabel: "San Jose",      emoji: "🏟️", tags: "Arena · Sports · Concerts" },
  { id: "sj-cpa",          name: "SJ Center for the Performing Arts",      venueMatch: "San Jose Center for the Performing",   city: "san-jose",      cityLabel: "San Jose",      emoji: "🎭", tags: "Theater · Broadway · Opera" },
  { id: "california-theatre", name: "California Theatre",                  venueMatch: "California Theatre",                   city: "san-jose",      cityLabel: "San Jose",      emoji: "🎼", tags: "Opera · Classical · Theater" },
  { id: "sj-civic",        name: "San Jose Civic",                         venueMatch: "San Jose Civic",                       city: "san-jose",      cityLabel: "San Jose",      emoji: "🎵", tags: "Concerts · Shows" },
  { id: "sj-improv",       name: "San Jose Improv",                        venueMatch: "San Jose Improv",                      city: "san-jose",      cityLabel: "San Jose",      emoji: "🎤", tags: "Comedy · Music" },
  { id: "the-ritz",        name: "The Ritz",                               venueMatch: "The Ritz",                             city: "san-jose",      cityLabel: "San Jose",      emoji: "🎸", tags: "Music · Indie" },
  { id: "tech-cu",         name: "Tech CU Arena",                          venueMatch: "Tech CU Arena",                        city: "san-jose",      cityLabel: "San Jose",      emoji: "🏀", tags: "Sports · Events" },
  { id: "paypal-park",     name: "PayPal Park",                            venueMatch: "PayPal Park",                          city: "san-jose",      cityLabel: "San Jose",      emoji: "⚽", tags: "Soccer · Sports" },
  { id: "excite-ballpark", name: "Excite Ballpark",                        venueMatch: "Excite Ballpark",                      city: "san-jose",      cityLabel: "San Jose",      emoji: "⚾", tags: "Baseball · MiLB" },
  { id: "mcenery",         name: "McEnery Convention Center",              venueMatch: "McEnery Convention Center",            city: "san-jose",      cityLabel: "San Jose",      emoji: "🎪", tags: "Conventions · Special Events" },
  { id: "discovery",       name: "Discovery Meadows",                      venueMatch: "Discovery Meadows",                    city: "san-jose",      cityLabel: "San Jose",      emoji: "🌿", tags: "Outdoor · Family" },
  { id: "happy-hollow",    name: "Happy Hollow Park & Zoo",                venueMatch: "Happy Hollow",                         city: "san-jose",      cityLabel: "San Jose",      emoji: "🦁", tags: "Family · Zoo" },
  { id: "sjpl",            name: "San Jose Public Library",                venueMatch: "San Jose Public Library",              city: "san-jose",      cityLabel: "San Jose",      emoji: "📚", tags: "Library · Classes · Family" },
  // ── Mountain View ──
  { id: "shoreline",       name: "Shoreline Amphitheatre",                 venueMatch: "Shoreline Amphitheatre",               city: "mountain-view", cityLabel: "Mountain View", emoji: "🎵", tags: "Outdoor Concerts" },
  { id: "mv-cpa",          name: "Mountain View Center for the Performing Arts", venueMatch: "Mountain View Center for the Performing", city: "mountain-view", cityLabel: "Mountain View", emoji: "🎭", tags: "Theater · Dance · Music" },
  { id: "chm",             name: "Computer History Museum",                venueMatch: "Computer History Museum",              city: "mountain-view", cityLabel: "Mountain View", emoji: "💾", tags: "Tech · Exhibits · Talks" },
  { id: "mvpl",            name: "Mountain View Public Library",           venueMatch: "Mountain View Public Library",         city: "mountain-view", cityLabel: "Mountain View", emoji: "📚", tags: "Library · Classes · Family" },
  // ── Santa Clara ──
  { id: "levis-stadium",   name: "Levi's Stadium",                         venueMatch: "Levi's Stadium",                       city: "santa-clara",   cityLabel: "Santa Clara",   emoji: "🏈", tags: "Football · Concerts · Events" },
  { id: "triton-museum",   name: "Triton Museum of Art",                   venueMatch: "Triton Museum",                        city: "santa-clara",   cityLabel: "Santa Clara",   emoji: "🖼️", tags: "Art · Exhibits · Free" },
  // ── Palo Alto / Stanford ──
  { id: "frost",           name: "Frost Amphitheatre",                     venueMatch: "Frost Amphitheatre",                   city: "palo-alto",     cityLabel: "Stanford",      emoji: "🌙", tags: "Outdoor Concerts" },
  { id: "cantor",          name: "Cantor Arts Center",                     venueMatch: "Cantor Arts Center",                   city: "palo-alto",     cityLabel: "Stanford",      emoji: "🗿", tags: "Art · Exhibits · Free" },
  { id: "palo-alto-library", name: "Palo Alto City Library",              venueMatch: "Palo Alto City Library",               city: "palo-alto",     cityLabel: "Palo Alto",     emoji: "📚", tags: "Library · Classes · Family" },
  // ── Saratoga ──
  { id: "montalvo",        name: "Montalvo Arts Center",                   venueMatch: "Montalvo",                             city: "saratoga",      cityLabel: "Saratoga",      emoji: "🎶", tags: "Concerts · Arts · Outdoor" },
  // ── Sunnyvale ──
  { id: "sunnyvale-library", name: "Sunnyvale Public Library",             venueMatch: "Sunnyvale Public Library",             city: "sunnyvale",     cityLabel: "Sunnyvale",     emoji: "📚", tags: "Library · Classes · Family" },
  // ── Los Gatos ──
  { id: "los-gatos-library", name: "Los Gatos Library",                   venueMatch: "Los Gatos Library",                    city: "los-gatos",     cityLabel: "Los Gatos",     emoji: "📚", tags: "Library · Classes · Family" },
  // ── Campbell ──
  { id: "campbell-library", name: "Campbell Library",                      venueMatch: "Campbell Library",                     city: "campbell",      cityLabel: "Campbell",      emoji: "📚", tags: "Library · Classes · Family" },
  // ── Milpitas ──
  { id: "milpitas-library", name: "Milpitas Library",                      venueMatch: "Milpitas Library",                     city: "milpitas",      cityLabel: "Milpitas",      emoji: "📚", tags: "Library · Classes · Family" },
];

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
  return n.getHours() * 60 + n.getMinutes();
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
              {event.title}
            </a>
          ) : event.title}
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

export default function EventsView({ selectedCities, homeCity }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("upcoming");
  const [category, setCategory] = useState<EventCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [showKidsOnly, setShowKidsOnly] = useState(false);
  const [showAllLater, setShowAllLater] = useState(false);
  const [selectedVenue, setSelectedVenue] = useState<string | null>(null);

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const primary = homeCity ?? "san-jose";

  const todayIso = now.toISOString().split("T")[0];
  const tomorrowIso = new Date(now.getTime() + 86400000).toISOString().split("T")[0];
  const weekEndIso = new Date(now.getTime() + 7 * 86400000).toISOString().split("T")[0];

  // ── Upcoming events (scraped, specific dates) ──
  const filteredUpcoming = useMemo(() => {
    const allCities = selectedCities.size === 11;
    const filtered = upcomingEvents.filter((e) => {
      if (!allCities && !selectedCities.has(e.city as City)) return false;
      if (category !== "all" && e.category !== category) return false;
      if (showKidsOnly && !e.kidFriendly) return false;
      // Hide today's events once they've started
      if (e.date === todayIso && !hasNotStarted(e.time)) return false;
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
  }, [selectedCities, category, showKidsOnly, search, primary]);

  // ── Recurring events (static, weekly/monthly/seasonal) ──
  const filteredRecurring = useMemo(() => {
    const allCities = selectedCities.size === 11;
    return SOUTH_BAY_EVENTS
      .filter((e) => {
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

  // ── Venue events (TM events grouped by venue) ──
  const venueEvents = useMemo(() => {
    const result: Record<string, UpcomingEvent[]> = {};
    for (const v of SOUTH_BAY_VENUES) {
      result[v.id] = allUpcomingEvents
        .filter((e) => e.venue?.toLowerCase().includes(v.venueMatch.toLowerCase()) && !e.ongoing)
        .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    }
    return result;
  }, []);

  // Events at selected venue, with search/category/kids filter applied
  const venueFilteredEvents = useMemo(() => {
    if (!selectedVenue) return [];
    const v = SOUTH_BAY_VENUES.find((x) => x.id === selectedVenue);
    if (!v) return [];
    return allUpcomingEvents
      .filter((e) => {
        if (!e.venue?.toLowerCase().includes(v.venueMatch.toLowerCase())) return false;
        if (e.ongoing) return false;
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
  }, [filteredUpcoming, todayIso, tomorrowIso, weekEndIso]);

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
          /* Venue grid */
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
            {SOUTH_BAY_VENUES.map((v) => {
              const shows = venueEvents[v.id] ?? [];
              const hasShows = shows.length > 0;
              const nextShow = shows[0];
              return (
                <div
                  key={v.id}
                  onClick={() => hasShows && setSelectedVenue(v.id)}
                  style={{
                    background: hasShows ? "#fff" : "var(--sb-card)",
                    border: "1.5px solid var(--sb-border-light)",
                    borderRadius: 8,
                    padding: "16px",
                    cursor: hasShows ? "pointer" : "default",
                    opacity: hasShows ? 1 : 0.5,
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
