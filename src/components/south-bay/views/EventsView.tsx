import { useState, useMemo, useEffect } from "react";
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

// Smarter emoji/tag inference from venue name + event content
const VENUE_KEYWORD_RULES: { test: RegExp; emoji: string; tags: string }[] = [
  { test: /\blibrary\b/i,                           emoji: "📚", tags: "Library · Classes · Family" },
  { test: /\buniversity\b|\bcollege\b|\bsjsu\b/i,   emoji: "🎓", tags: "University · Events" },
  { test: /\bschool\b/i,                            emoji: "🏫", tags: "School · Education" },
  { test: /\bpark\b(?!ing)/i,                       emoji: "🌳", tags: "Park · Outdoor" },
  { test: /\bstadium\b|\barena\b|\bballpark\b/i,    emoji: "🏟️", tags: "Sports · Events" },
  { test: /\btheatre\b|\btheater\b|\bperforming/i,  emoji: "🎭", tags: "Theater · Performing Arts" },
  { test: /\bmuseum\b|\bgallery\b/i,                emoji: "🖼️", tags: "Museum · Exhibits" },
  { test: /\bchurch\b|\btemple\b|\bmosque\b/i,      emoji: "⛪", tags: "Worship · Community" },
  { test: /\bjazz\b|\bmusic\b|\bconcert/i,          emoji: "🎷", tags: "Music · Live Shows" },
  { test: /\bbrewery\b|\bwinery\b|\btap/i,          emoji: "🍺", tags: "Drinks · Social" },
  { test: /\bcafe\b|\bcoffee\b|\brestaurant/i,      emoji: "☕", tags: "Food · Drinks" },
  { test: /\bgarden\b|\bbotanical\b|\bconservancy/i, emoji: "🌿", tags: "Garden · Nature" },
  { test: /\btrail\b|\bpreserve\b|\bopen space/i,   emoji: "🥾", tags: "Trails · Nature" },
  { test: /\bcommunity center\b|\brec center/i,     emoji: "🏠", tags: "Community · Recreation" },
  { test: /\bhacker\b|\bcowork\b|\btech\b/i,        emoji: "💻", tags: "Tech · Meetups" },
  { test: /\bpool\b|\baquatic/i,                    emoji: "🏊", tags: "Swimming · Recreation" },
  { test: /\bzoo\b|\bwildlife\b|\banimal/i,         emoji: "🦁", tags: "Wildlife · Family" },
  { test: /\bfarm\b|\borchard\b/i,                  emoji: "🌾", tags: "Farm · Agriculture" },
  { test: /\bmarket\b/i,                            emoji: "🥦", tags: "Market · Shopping" },
];

function inferVenueEmojiAndTags(
  venueName: string,
  topCategory: string,
  events: UpcomingEvent[],
): { emoji: string; tags: string } {
  // Check venue name against keyword rules
  for (const rule of VENUE_KEYWORD_RULES) {
    if (rule.test.test(venueName)) return { emoji: rule.emoji, tags: rule.tags };
  }

  // Check event titles for hints (sample first 10)
  const titleSample = events.slice(0, 10).map((e) => e.title).join(" ");
  for (const rule of VENUE_KEYWORD_RULES) {
    if (rule.test.test(titleSample)) return { emoji: rule.emoji, tags: rule.tags };
  }

  // Fall back to category emoji
  const catEmoji = CATEGORY_EMOJI[topCategory] ?? "📍";
  const catTag = topCategory.charAt(0).toUpperCase() + topCategory.slice(1);
  return { emoji: catEmoji, tags: catTag };
}

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
    const inferred = inferVenueEmojiAndTags(g.venue, topCat, g.events);

    venues.push({
      id,
      name: override?.name ?? g.venue,
      venueMatch: g.venue,
      city: g.city,
      cityLabel: override?.cityLabel ?? cityLabel,
      emoji: override?.emoji ?? inferred.emoji,
      tags: override?.tags ?? inferred.tags,
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
  // For comma-separated session times ("12pm, 1pm, 2pm"), use the last one
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

function UpcomingEventCard({ event, showDate }: { event: UpcomingEvent; showDate?: boolean }) {
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
          {showDate && event.displayDate && (
            <><span style={{
              fontWeight: 700, color: "var(--sb-ink)", fontSize: 11,
              background: "var(--sb-card)", border: "1px solid var(--sb-border-light)",
              borderRadius: 3, padding: "0px 5px",
            }}>{event.displayDate}</span>
            {(event.time || event.venue || event.city) && <span style={{ color: "var(--sb-border)" }}>·</span>}</>
          )}
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

        {/* Make it a day */}
        {event.date && event.city && (
          <MakeItADayButton eventId={event.id} city={event.city} date={event.date} />
        )}
      </div>
    </div>
  );
}

// ── "Make it a day" button ──

function MakeItADayButton({ eventId, city, date }: { eventId: string; city: string; date: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (state !== "idle") return;
    setState("loading");

    try {
      // 1. Generate a plan with this event locked
      const planRes = await fetch("/api/plan-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city,
          kids: false,
          lockedIds: [`event:${eventId}`],
          currentHour: 9,
          planDate: date,
        }),
      });
      if (!planRes.ok) throw new Error("plan failed");
      const planData = await planRes.json();

      // 2. Save to get a shareable URL
      const shareRes = await fetch("/api/share-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cards: planData.cards,
          city,
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
      style={{
        marginTop: 6,
        padding: "3px 10px",
        fontSize: 10,
        fontWeight: 700,
        fontFamily: "'Space Mono', monospace",
        letterSpacing: "0.04em",
        border: "1px solid var(--sb-border-light)",
        borderRadius: 4,
        background: state === "loading" ? "#f5f5f5" : "var(--sb-card)",
        color: state === "done" ? "#16a34a" : "var(--sb-muted)",
        cursor: state === "loading" ? "wait" : "pointer",
        transition: "all 0.15s",
      }}
      onMouseEnter={(e) => { if (state === "idle") e.currentTarget.style.borderColor = "#999"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--sb-border-light)"; }}
    >
      {state === "loading" ? "Building plan..." : state === "done" ? "Plan ready ✓" : "Make it a day →"}
    </button>
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

function shortDate(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function weekMonday(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  const dow = d.getDay(); // 0=Sun
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const mon = new Date(d.getTime() - daysToMon * 86400000);
  return mon.toLocaleDateString("en-CA");
}

function weekLabel(monIso: string): string {
  const sun = new Date(monIso + "T12:00:00");
  sun.setDate(sun.getDate() + 6);
  return `${shortDate(monIso)}–${shortDate(sun.toLocaleDateString("en-CA"))}`;
}

function getEventBucket(dateIso: string, todayIso: string, tomorrowIso: string, weekEndIso: string): string {
  if (dateIso === todayIso) return "Today";
  if (dateIso === tomorrowIso) return "Tomorrow";
  if (dateIso <= weekEndIso) return "This Week";
  return `week:${weekMonday(dateIso)}`;
}

function bucketLabel(bucket: string, weekEndIso: string): string {
  if (bucket === "Today" || bucket === "Tomorrow" || bucket === "This Week") return bucket;
  const monIso = bucket.slice(5); // "week:2026-04-13" → "2026-04-13"
  const today = new Date();
  const monDate = new Date(monIso + "T12:00:00");
  const diffDays = Math.round((monDate.getTime() - today.getTime()) / 86400000);
  if (diffDays <= 7) return `Next Week · ${weekLabel(monIso)}`;
  return `Week of ${shortDate(monIso)}`;
}

const DATE_GROUP_STATIC = ["Today", "Tomorrow", "This Week"];

// ── San José neighborhood filter ───────────────────────────────────────────

interface SjNeighborhood {
  id: string;
  label: string;
  emoji: string;
  /** venue substrings (case-insensitive) that belong to this area */
  venues: string[];
}

const SJ_NEIGHBORHOODS: SjNeighborhood[] = [
  {
    id: "downtown",
    label: "Downtown",
    emoji: "🏙️",
    venues: [
      "san jose improv", "the ritz", "sap center", "san jose civic",
      "sjz break room", "hammer theatre", "macla", "city lights theater",
      "ica san", "san jose center for the performing", "king library",
      "san jose jazz", "arena green", "o\u2019flaherty", "o'flaherty",
      "o&#8217;flaherty", "plaza de cesar chavez", "downtown san jose", "south first",
      "san pedro square", "mcenery convention", "convention center",
      "sofa market", "courage anyone",
    ],
  },
  {
    id: "sjsu",
    label: "SJSU Area",
    emoji: "🎓",
    venues: ["san jose state", "san jose museum of art"],
  },
  {
    id: "japantown",
    label: "Japantown",
    emoji: "🏮",
    venues: ["japanese american museum", "sjda", "japantown"],
  },
  {
    id: "willow-glen",
    label: "Willow Glen",
    emoji: "🌳",
    venues: ["willow glen library", "hicklebee"],
  },
  {
    id: "east-side",
    label: "East Side",
    emoji: "🌄",
    venues: [
      "berryessa library", "vineland library", "educational park library",
      "edenvale library", "alum rock library",
      "history park", "history san jose", "east sj carnegie", "mt. pleasant library",
    ],
  },
  {
    id: "south-sj",
    label: "South SJ",
    emoji: "🏡",
    venues: [
      "almaden library", "santa teresa library", "cambrian library",
      "hillview library", "pearl avenue library",
    ],
  },
  {
    id: "evergreen",
    label: "Evergreen",
    emoji: "🌿",
    venues: ["evergreen library", "village square library"],
  },
  {
    id: "west-sj",
    label: "West SJ",
    emoji: "🛍️",
    venues: ["santana row", "bascom library", "westfield valley fair", "valley fair"],
  },
  {
    id: "sports",
    label: "Sports Venues",
    emoji: "🏟️",
    venues: ["paypal park", "excite ballpark", "tech cu arena"],
  },
];

function getSjNeighborhood(venue: string | null): string | null {
  if (!venue) return null;
  const vl = venue.toLowerCase();
  for (const n of SJ_NEIGHBORHOODS) {
    if (n.venues.some((v) => vl.includes(v))) return n.id;
  }
  return null;
}

// ── Main View ──

// ── Spring Break constants ──────────────────────────────────────────────────
const SB_BANNER_START = "2026-03-29"; // show banner from now through end of break
const SB_BREAK_START  = "2026-04-03"; // first district break starts (Easter 2026 was Apr 5)
const SB_BREAK_WK1    = "2026-04-10"; // end of first break window
const SB_BREAK_END    = "2026-04-17"; // end of second break window

export default function EventsView({ selectedCities }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("upcoming");
  const [category, setCategory] = useState<EventCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [showKidsOnly, setShowKidsOnly] = useState(false);
  const [showAllLater, setShowAllLater] = useState(false);
  const [selectedVenue, setSelectedVenue] = useState<string | null>(null);
  const [springBreakMode, setSpringBreakMode] = useState(false);
  const [sjNeighborhoodRaw, setSjNeighborhood] = useState<string | null>(null);
  // Only apply neighborhood filter when SJ is the sole city
  const sjNeighborhood = (selectedCities.size === 1 && selectedCities.has("san-jose")) ? sjNeighborhoodRaw : null;
  const [todayForecast, setTodayForecast] = useState<{
    high: number; rainPct: number; emoji: string; desc: string;
  } | null>(null);

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const primary = "san-jose";

  const todayIso = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const tomorrowIso = new Date(now.getTime() + 86400000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const weekEndIso = new Date(now.getTime() + 7 * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  const showSpringBreakBanner = todayIso >= SB_BANNER_START && todayIso <= SB_BREAK_END;
  const daysUntilBreak = Math.ceil((new Date(SB_BREAK_START).getTime() - now.getTime()) / 86400000);
  const breakInProgress = todayIso >= SB_BREAK_START && todayIso <= SB_BREAK_END;

  // ── Fetch today's weather (sessionStorage-cached to avoid duplicate calls) ──
  useEffect(() => {
    const cacheKey = `sb-events-weather-${primary}-${todayIso}`;
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) { setTodayForecast(JSON.parse(cached)); return; }
    } catch {}
    fetch(`/api/weather?city=${primary}`)
      .then((r) => r.json())
      .then((d) => {
        const f = d.forecast?.[0];
        if (f) {
          const summary = { high: f.high, rainPct: f.rainPct, emoji: f.emoji, desc: f.desc };
          setTodayForecast(summary);
          try { sessionStorage.setItem(cacheKey, JSON.stringify(summary)); } catch {}
        }
      })
      .catch(() => {});
  }, [primary, todayIso]);

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
      if (sjNeighborhood && e.city === "san-jose" && getSjNeighborhood(e.venue) !== sjNeighborhood) return false;
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
  }, [selectedCities, category, showKidsOnly, search, primary, springBreakMode, todayIso, sjNeighborhood]);

  // ── Per-category counts (all filters applied except category, for pill badges) ──
  const categoryCounts = useMemo(() => {
    const allCities = selectedCities.size === 11;
    const counts: Record<string, number> = {};
    for (const e of upcomingEvents) {
      if (!allCities && !selectedCities.has(e.city as City)) continue;
      if (sjNeighborhood && e.city === "san-jose" && getSjNeighborhood(e.venue) !== sjNeighborhood) continue;
      if (showKidsOnly && !e.kidFriendly) continue;
      if (e.date === todayIso && !hasNotStarted(e.time)) continue;
      if (springBreakMode && (e.date < SB_BREAK_START || e.date > SB_BREAK_END)) continue;
      if (search) {
        const q = search.toLowerCase();
        if (!e.title.toLowerCase().includes(q) && !e.description.toLowerCase().includes(q) &&
            !e.city.toLowerCase().includes(q) && !e.venue.toLowerCase().includes(q)) continue;
      }
      counts[e.category] = (counts[e.category] || 0) + 1;
    }
    // "all" = sum of everything
    counts["all"] = Object.values(counts).reduce((a, b) => a + b, 0);
    return counts;
  }, [selectedCities, showKidsOnly, search, springBreakMode, todayIso, sjNeighborhood]);

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
      // Spring break: group by week, with a dedicated bucket for the Apr 11–12 weekend
      const SB_WEEKEND_START = "2026-04-11";
      const SB_WEEKEND_END   = "2026-04-12";
      const groups: Record<string, UpcomingEvent[]> = {};
      for (const e of filteredUpcoming) {
        const label = e.date <= SB_BREAK_WK1
          ? "Spring Break · Wk 1 (Apr 3–10)"
          : e.date <= SB_WEEKEND_END
            ? "Weekend — Apr 11–12"
            : "Spring Break · Wk 2 (Apr 13–17)";
        if (!groups[label]) groups[label] = [];
        groups[label].push(e);
      }
      const order = ["Spring Break · Wk 1 (Apr 3–10)", "Weekend — Apr 11–12", "Spring Break · Wk 2 (Apr 13–17)"];
      return order.filter((g) => groups[g]?.length > 0).map((label) => ({ label, events: groups[label], showDate: false }));
    }

    const groups: Record<string, UpcomingEvent[]> = {};
    for (const e of filteredUpcoming) {
      const bucket = getEventBucket(e.date || "", todayIso, tomorrowIso, weekEndIso);
      if (!groups[bucket]) groups[bucket] = [];
      groups[bucket].push(e);
    }

    // Sort buckets: static groups first, then calendar weeks in order
    const staticBuckets = DATE_GROUP_STATIC.filter((g) => groups[g]?.length > 0);
    const weekBuckets = Object.keys(groups)
      .filter((k) => k.startsWith("week:"))
      .sort();

    return [...staticBuckets, ...weekBuckets]
      .filter((bucket) => groups[bucket]?.length > 0)
      .map((bucket) => ({
        label: bucketLabel(bucket, weekEndIso),
        events: groups[bucket],
        showDate: !DATE_GROUP_STATIC.includes(bucket),
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

      {/* Category pills + SJ neighborhood filter — sticky below nav */}
      <div className="sb-events-sticky-filter">
        <div style={{
          display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4,
          scrollbarWidth: "none" as React.CSSProperties["scrollbarWidth"],
        }}>
          {EVENT_CATEGORIES.map((cat) => {
            const active = category === cat.id;
            const count = viewMode === "upcoming" ? (categoryCounts[cat.id] ?? 0) : null;
            const showCount = count !== null && count > 0;
            return (
              <button
                key={cat.id}
                onClick={() => setCategory(cat.id as EventCategory | "all")}
                style={{
                  display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
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
                {showCount && (
                  <span style={{
                    fontSize: 10, fontWeight: 700,
                    background: active ? "rgba(255,255,255,0.25)" : "var(--sb-border-light, #f0f0f0)",
                    color: active ? "#fff" : "var(--sb-muted)",
                    borderRadius: 100, padding: "0 5px", lineHeight: "16px",
                    minWidth: 16, textAlign: "center",
                  }}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* San José neighborhood filter — shown when SJ is the only selected city */}
        {selectedCities.size === 1 && selectedCities.has("san-jose") && viewMode === "upcoming" && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 6, paddingBottom: 2, alignItems: "center" }}>
            <span style={{
              fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
              letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--sb-muted)",
              flexShrink: 0, paddingTop: 2,
            }}>
              Area:
            </span>
            <button
              onClick={() => setSjNeighborhood(null)}
              style={{
                padding: "3px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit",
                border: `1.5px solid ${sjNeighborhood === null ? "var(--sb-primary)" : "var(--sb-border)"}`,
                borderRadius: 100,
                background: sjNeighborhood === null ? "var(--sb-primary)" : "#fff",
                color: sjNeighborhood === null ? "#fff" : "var(--sb-muted)",
                fontWeight: sjNeighborhood === null ? 600 : 400,
                transition: "all 0.12s",
              }}
            >
              All SJ
            </button>
            {SJ_NEIGHBORHOODS.map((n) => {
              const active = sjNeighborhood === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => setSjNeighborhood(active ? null : n.id)}
                  style={{
                    padding: "3px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit",
                    border: `1.5px solid ${active ? "var(--sb-primary)" : "var(--sb-border)"}`,
                    borderRadius: 100,
                    background: active ? "var(--sb-primary)" : "#fff",
                    color: active ? "#fff" : "var(--sb-muted)",
                    fontWeight: active ? 600 : 400,
                    transition: "all 0.12s",
                    display: "flex", alignItems: "center", gap: 4,
                  }}
                >
                  <span>{n.emoji}</span>
                  <span>{n.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Kids toggle + event count */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10, gap: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--sb-muted)", cursor: "pointer", userSelect: "none" }}>
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
              {breakInProgress
                ? (todayIso === SB_BREAK_END ? "Last day of Spring Break!" : "Spring Break is here!")
                : `Spring Break in ${daysUntilBreak} day${daysUntilBreak === 1 ? "" : "s"}`}
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

      {/* Weather-aware banner */}
      {todayForecast && viewMode === "upcoming" && category === "all" && (() => {
        const { high, rainPct, emoji, desc } = todayForecast;
        if (rainPct >= 40) {
          return (
            <div style={{
              marginBottom: 14, padding: "9px 14px",
              background: "#f0f9ff",
              border: "1.5px solid #bae6fd",
              borderRadius: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>🌧️</span>
              <div style={{ flex: 1, minWidth: 180 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: "var(--sb-ink)", fontFamily: "var(--sb-sans)" }}>
                  Rainy today ({high}°F, {rainPct}% chance of rain)
                </span>
                <span style={{ fontSize: 12, color: "var(--sb-muted)", marginLeft: 6 }}>
                  — great day for a library program or indoor event.
                </span>
              </div>
            </div>
          );
        }
        const isClear = rainPct < 20 && (
          desc.toLowerCase().includes("clear") ||
          desc.toLowerCase().includes("sunny") ||
          desc.toLowerCase().includes("fair") ||
          rainPct === 0
        );
        if (isClear) {
          return (
            <div style={{
              marginBottom: 14, padding: "9px 14px",
              background: "#fffbeb",
              border: "1.5px solid #fcd34d",
              borderRadius: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>{emoji}</span>
              <div style={{ flex: 1, minWidth: 180 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: "var(--sb-ink)", fontFamily: "var(--sb-sans)" }}>
                  {desc} today, {high}°F
                </span>
                <span style={{ fontSize: 12, color: "var(--sb-muted)", marginLeft: 6 }}>
                  — great day to get outside!
                </span>
              </div>
              <button
                onClick={() => setCategory("outdoor")}
                style={{
                  padding: "5px 12px", background: "#16a34a", color: "#fff",
                  border: "none", borderRadius: 6, fontSize: 12, fontWeight: 700,
                  cursor: "pointer", fontFamily: "var(--sb-sans)", whiteSpace: "nowrap",
                }}
              >
                Show Outdoor Events
              </button>
            </div>
          );
        }
        return null;
      })()}

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
          {groupedUpcoming.map(({ label, events, showDate }) => {
            const isWeekBucket = !DATE_GROUP_STATIC.includes(label) && !label.startsWith("Spring");
            const visible = isWeekBucket && !showAllLater ? events.slice(0, 50) : events;
            const isToday = label === "Today";
            const isTomorrow = label === "Tomorrow";
            return (
              <div key={label} style={{ marginBottom: 24 }}>
                {/* Date group header */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <span style={{
                    fontSize: isToday || isTomorrow ? 13 : 11,
                    fontWeight: 800,
                    fontFamily: "'Space Mono', monospace",
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: isToday ? "#fff" : "var(--sb-ink)",
                    ...(isToday ? {
                      background: "var(--sb-accent)",
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
                    <UpcomingEventCard key={event.id} event={event} showDate={showDate} />
                  ))}
                </div>
                {isWeekBucket && !showAllLater && events.length > 50 && (
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
