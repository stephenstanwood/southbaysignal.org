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

type ViewMode = "upcoming" | "recurring";

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
}

const upcomingEvents = (upcomingJson as { events: UpcomingEvent[] }).events || [];
const upcomingSources = (upcomingJson as { sources: string[] }).sources || [];

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

// ── Upcoming Event Card ──

function UpcomingEventCard({ event }: { event: UpcomingEvent }) {
  const badge = costBadge(event.cost);
  return (
    <div
      style={{
        background: "#fff",
        border: "1.5px solid var(--sb-border-light)",
        borderRadius: "var(--sb-radius-lg, 6px)",
        padding: "12px 14px",
        transition: "box-shadow 0.15s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "var(--sb-shadow-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "none")}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 4 }}>
        <div>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--sb-ink)", lineHeight: 1.3, display: "block" }}>
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
          </span>
        </div>
        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontWeight: 700,
            fontFamily: "'Space Mono', monospace",
            letterSpacing: "0.04em",
            padding: "2px 7px",
            borderRadius: 3,
            background: badge.bg,
            color: badge.fg,
            border: `1px solid ${badge.border}`,
          }}
        >
          {badge.label}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "4px 10px",
          fontSize: 11,
          color: "var(--sb-muted)",
          marginBottom: 5,
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--sb-accent)" }}>📅 {event.displayDate}</span>
        {event.time && <span>🕐 {event.time}{event.endTime ? ` – ${event.endTime}` : ""}</span>}
        <span>📍 {cityLabel(event.city)}</span>
        {event.venue && <span>· {event.venue}</span>}
        {event.kidFriendly && <span>👶 Kid-friendly</span>}
      </div>

      {event.description && (
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--sb-muted)" }}>
          {event.description}
        </p>
      )}

      <div style={{ marginTop: 4, fontSize: 10, color: "var(--sb-light)", fontFamily: "'Space Mono', monospace" }}>
        via {event.source}
      </div>
    </div>
  );
}

// ── Recurring Event Card ──

function RecurringEventCard({ event }: { event: SBEvent }) {
  const badge = costBadge(event.cost);
  const now = new Date();
  const activeToday = isEventActiveToday(event, now);

  return (
    <div
      style={{
        background: "#fff",
        border: "1.5px solid var(--sb-border-light)",
        borderRadius: "var(--sb-radius-lg, 6px)",
        padding: "12px 14px",
        transition: "box-shadow 0.15s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "var(--sb-shadow-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "none")}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--sb-ink)", lineHeight: 1.3 }}>
          {event.emoji} {event.url ? (
            <a href={event.url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}
              onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
              onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
            >{event.title}</a>
          ) : event.title}
        </span>
        <span
          style={{
            flexShrink: 0, fontSize: 10, fontWeight: 700,
            fontFamily: "'Space Mono', monospace", letterSpacing: "0.04em",
            padding: "2px 7px", borderRadius: 3,
            background: badge.bg, color: badge.fg, border: `1px solid ${badge.border}`,
          }}
        >
          {badge.label}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", fontSize: 11, color: "var(--sb-muted)", marginBottom: 5 }}>
        <span>📍 {cityLabel(event.city)}</span>
        <span>📅 {recurrenceLabel(event)}</span>
        {event.time && <span>🕐 {event.time}</span>}
        {event.kidFriendly && <span>👶 Kid-friendly</span>}
        {activeToday && <span style={{ color: "#16803C", fontWeight: 600 }}>✓ Today</span>}
      </div>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--sb-muted)" }}>
        {event.description}
      </p>
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
      // 3. Same date: boost under-represented sources (fewer total = shown first)
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

  const activeList = viewMode === "upcoming" ? filteredUpcoming : filteredRecurring;

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
          </span>
        </span>
        <div className="sb-section-line" />
      </div>

      {/* View mode toggle */}
      <div style={{ display: "flex", gap: 0, marginBottom: 12 }}>
        {(["upcoming", "recurring"] as ViewMode[]).map((mode) => {
          const active = viewMode === mode;
          const labels = { upcoming: `Upcoming (${filteredUpcoming.length})`, recurring: `Recurring (${filteredRecurring.length})` };
          return (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              style={{
                padding: "6px 16px",
                border: `1.5px solid ${active ? "var(--sb-primary)" : "var(--sb-border)"}`,
                borderRadius: mode === "upcoming" ? "6px 0 0 6px" : "0 6px 6px 0",
                background: active ? "var(--sb-primary)" : "#fff",
                color: active ? "#fff" : "var(--sb-muted)",
                fontSize: 12,
                fontWeight: active ? 700 : 400,
                cursor: "pointer",
                fontFamily: "inherit",
                marginLeft: mode === "recurring" ? -1.5 : 0,
              }}
            >
              {labels[mode]}
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

        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--sb-light)", fontFamily: "'Space Mono', monospace" }}>
          {activeList.length} events
        </span>
      </div>

      {/* Event cards */}
      {activeList.length === 0 ? (
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
              <div key={label} style={{ marginBottom: 20 }}>
                {/* Date group header */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 10,
                    paddingBottom: 6,
                    borderBottom: "2px solid var(--sb-border)",
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      fontFamily: "'Space Mono', monospace",
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: label === "Today" ? "var(--sb-accent)" : "var(--sb-muted)",
                    }}
                  >
                    {label}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--sb-light)",
                      fontFamily: "'Space Mono', monospace",
                    }}
                  >
                    {events.length} event{events.length !== 1 ? "s" : ""}
                  </span>
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
          {upcomingEvents.length} upcoming events from {upcomingSources.length} sources.
        </strong>{" "}
        Via {upcomingSources.join(", ")}.
        {" "}Plus {SOUTH_BAY_EVENTS.length} recurring events across the South Bay.
      </div>
    </>
  );
}
