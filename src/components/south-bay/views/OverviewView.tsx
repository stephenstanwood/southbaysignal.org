import { useState, useEffect } from "react";
import SportsView from "./SportsView";
import {
  SOUTH_BAY_EVENTS,
  type SBEvent,
  type DayOfWeek,
} from "../../../data/south-bay/events-data";
import { DEV_PROJECTS } from "../../../data/south-bay/development-data";
import { CITIES, getCityName } from "../../../lib/south-bay/cities";
import type { City, Tab } from "../../../lib/south-bay/types";
import upcomingJson from "../../../data/south-bay/upcoming-events.json";
import digestsJson from "../../../data/south-bay/digests.json";

// ── Types ─────────────────────────────────────────────────────────────────────

type UpcomingEvent = {
  id: string;
  title: string;
  date: string;
  time: string | null;
  endTime?: string | null;
  venue: string;
  city: string;
  category: string;
  cost: string;
  description?: string;
  url?: string | null;
  source: string;
  kidFriendly: boolean;
  ongoing?: boolean;
};

// ── Time constants ─────────────────────────────────────────────────────────────

const NOW = new Date();
const NOW_MINUTES = NOW.getHours() * 60 + NOW.getMinutes();
const TODAY_ISO = NOW.toISOString().split("T")[0];
const MONTH = NOW.getMonth() + 1;
const NEXT_MONTH = MONTH === 12 ? 1 : MONTH + 1;
const DAY_IDX = NOW.getDay();
const DAY_NAME = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][DAY_IDX];
const WEEKDAY = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][DAY_IDX];
const MONTH_NAME = NOW.toLocaleDateString("en-US", { month: "long" });
const NEXT_MONTH_NAME = new Date(NOW.getFullYear(), NOW.getMonth() + 1, 1).toLocaleDateString("en-US", { month: "long" });

// ── Time helpers ───────────────────────────────────────────────────────────────

function parseMinutes(timeStr: string, useLast = false): number | null {
  if (!timeStr) return null;
  const parts = timeStr.split(/\s*[–\-]\s*/);
  const target = (useLast ? parts[parts.length - 1] : parts[0]).trim();
  const match = target.match(/^(\d+)(?::(\d+))?\s*(am|pm)$/i);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = parseInt(match[2] ?? "0");
  const ampm = match[3].toLowerCase();
  if (ampm === "pm" && h !== 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return h * 60 + m;
}

function startMinutes(timeStr: string | undefined | null): number {
  if (!timeStr) return 999;
  return parseMinutes(timeStr, false) ?? 999;
}

function isNotEnded(timeStr: string | undefined | null): boolean {
  if (!timeStr) return true;
  const endMin = parseMinutes(timeStr, true);
  if (endMin === null) return true;
  return endMin > NOW_MINUTES;
}

// Time bucket: now / morning / afternoon / evening / none
type TimeBucket = "now" | "morning" | "afternoon" | "evening" | "none";

function timeBucket(timeStr: string | undefined | null): TimeBucket {
  if (!timeStr) return "none";
  const start = parseMinutes(timeStr, false);
  if (start === null) return "none";
  const end = parseMinutes(timeStr, true) ?? start + 120;
  // "Now" = started within last 90 min and hasn't ended
  if (start <= NOW_MINUTES && end > NOW_MINUTES) return "now";
  if (start < 12 * 60) return "morning";
  if (start < 17 * 60) return "afternoon";
  return "evening";
}

// ── Next meeting date calculator ──────────────────────────────────────────────

const WEEKDAY_IDX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function nthWeekdayOfMonth(year: number, month: number, n: number, dow: number): Date {
  const first = new Date(year, month, 1);
  const offset = ((dow - first.getDay()) + 7) % 7;
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}

function calcNextMeeting(schedule: string): string | null {
  // e.g. "1st and 3rd Tuesday", "2nd and 4th Monday"
  const m = schedule.match(/(\d)(?:st|nd|rd|th)\s+and\s+(\d)(?:st|nd|rd|th)\s+(\w+)/i);
  if (!m) return null;
  const weeks = [parseInt(m[1]), parseInt(m[2])];
  const dow = WEEKDAY_IDX[m[3].toLowerCase()];
  if (dow === undefined) return null;

  const today = new Date(NOW);
  today.setHours(0, 0, 0, 0);

  for (let mo = 0; mo <= 1; mo++) {
    const yr = NOW.getFullYear();
    const month = NOW.getMonth() + mo;
    const dates = weeks.map((w) => nthWeekdayOfMonth(yr, month, w, dow));
    dates.sort((a, b) => a.getTime() - b.getTime());
    for (const d of dates) {
      if (d >= today) {
        return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      }
    }
  }
  return null;
}

// ── Static event helpers ──────────────────────────────────────────────────────

function isActiveToday(e: SBEvent): boolean {
  if (e.months && !e.months.includes(MONTH)) return false;
  if (!e.days) return e.recurrence !== "seasonal";
  if (!e.days.includes(DAY_NAME as DayOfWeek)) return false;
  return isNotEnded(e.time);
}

function cityLabel(city: string): string {
  return city.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function costBadge(cost: string, costNote?: string): { label: string; bg: string; color: string } {
  if (cost === "free") return { label: "FREE", bg: "#D1FAE5", color: "#065F46" };
  if (cost === "low") return { label: costNote?.split(" ")[0] ?? "$", bg: "#FEF3C7", color: "#92400E" };
  return { label: costNote?.split(" ")[0] ?? "$$", bg: "#EDE9FE", color: "#5B21B6" };
}

const CATEGORY_EMOJI: Record<string, string> = {
  music: "🎵", arts: "🎨", family: "👨‍👩‍👦", education: "📚", community: "🤝",
  market: "🌽", food: "🍜", outdoor: "🌿", sports: "🏟️",
};

// ── Time bucket label ─────────────────────────────────────────────────────────

const BUCKET_LABELS: Record<TimeBucket, string> = {
  now: "Happening Now",
  morning: "This Morning",
  afternoon: "This Afternoon",
  evening: "Tonight",
  none: "Today",
};
const BUCKET_ORDER: TimeBucket[] = ["now", "morning", "afternoon", "evening", "none"];

// ── Sports game callout ───────────────────────────────────────────────────────

function SportsCallout({ events }: { events: UpcomingEvent[] }) {
  if (!events.length) return null;
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 8, marginBottom: 20,
      padding: "12px 14px",
      background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
      borderRadius: "var(--sb-radius-lg, 6px)",
      border: "1px solid #334155",
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace", letterSpacing: "0.1em", color: "#94a3b8", textTransform: "uppercase" }}>
        🏟️ Game Day
      </div>
      {events.map((e) => (
        <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9", lineHeight: 1.3 }}>
              {e.url ? (
                <a href={e.url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                  {e.title}
                </a>
              ) : e.title}
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2, display: "flex", gap: 8 }}>
              {e.time && <span style={{ color: "#38bdf8", fontWeight: 600 }}>{e.time}</span>}
              {e.venue && <span>· {e.venue}</span>}
            </div>
          </div>
          {e.cost === "free" && (
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: "#D1FAE5", color: "#065F46" }}>FREE</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Compact event row (static events) ─────────────────────────────────────────

function EventRow({ event, showCity = true }: { event: SBEvent; showCity?: boolean }) {
  const badge = costBadge(event.cost, event.costNote);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--sb-border-light)" }}>
      <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0, width: 28, textAlign: "center" }}>
        {event.emoji}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--sb-serif)", fontWeight: 600, fontSize: 14, color: "var(--sb-ink)", lineHeight: 1.3 }}>
            {event.url ? (
              <a href={event.url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                {event.title}
              </a>
            ) : event.title}
          </span>
          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: badge.bg, color: badge.color, letterSpacing: "0.04em", flexShrink: 0 }}>
            {badge.label}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--sb-muted)", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {showCity && <span>{cityLabel(event.city)}</span>}
          {event.time && (
            <>
              {showCity && <span style={{ color: "var(--sb-border)" }}>·</span>}
              <span>{event.time}</span>
            </>
          )}
          {event.venue && event.venue !== cityLabel(event.city) && (
            <>
              <span style={{ color: "var(--sb-border)" }}>·</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{event.venue}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Upcoming event row (scraped events) ───────────────────────────────────────

function UpcomingRow({ event, showCity = true, highlight = false }: { event: UpcomingEvent; showCity?: boolean; highlight?: boolean }) {
  const badge = costBadge(event.cost);
  const emoji = CATEGORY_EMOJI[event.category] ?? "📅";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "10px 0",
      borderBottom: "1px solid var(--sb-border-light)",
      borderLeft: highlight ? "3px solid var(--sb-primary)" : undefined,
      paddingLeft: highlight ? 10 : undefined,
      marginLeft: highlight ? -13 : undefined,
    }}>
      <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0, width: 28, textAlign: "center" }}>{emoji}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--sb-serif)", fontWeight: 600, fontSize: 14, color: "var(--sb-ink)", lineHeight: 1.3 }}>
            {event.url ? (
              <a href={event.url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                {event.title}
              </a>
            ) : event.title}
          </span>
          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: badge.bg, color: badge.color, letterSpacing: "0.04em", flexShrink: 0 }}>
            {badge.label}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--sb-muted)", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {showCity && <span>{cityLabel(event.city)}</span>}
          {event.time && (
            <>
              {showCity && <span style={{ color: "var(--sb-border)" }}>·</span>}
              <span>{event.time}</span>
            </>
          )}
          {event.venue && (
            <>
              <span style={{ color: "var(--sb-border)" }}>·</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{event.venue}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── This Month card ────────────────────────────────────────────────────────────

function MonthCard({ event, isUpcoming }: { event: SBEvent; isUpcoming?: boolean }) {
  const badge = costBadge(event.cost, event.costNote);
  return (
    <div style={{ background: "var(--sb-card)", border: "1px solid var(--sb-border-light)", borderRadius: "var(--sb-radius)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 22 }}>{event.emoji}</span>
        {isUpcoming ? (
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#6B7280", background: "#F3F4F6", padding: "2px 7px", borderRadius: 3 }}>{NEXT_MONTH_NAME}</span>
        ) : (
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#065F46", background: "#D1FAE5", padding: "2px 7px", borderRadius: 3 }}>{MONTH_NAME}</span>
        )}
      </div>
      <div>
        <span style={{ fontFamily: "var(--sb-serif)", fontWeight: 700, fontSize: 15, color: "var(--sb-ink)", lineHeight: 1.3, display: "block" }}>
          {event.url ? (
            <a href={event.url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
              {event.title}
            </a>
          ) : event.title}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "var(--sb-muted)" }}>{cityLabel(event.city)}</span>
          <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: badge.bg, color: badge.color, letterSpacing: "0.03em" }}>{badge.label}</span>
        </div>
      </div>
      <p style={{ fontSize: 12, color: "var(--sb-muted)", lineHeight: 1.5, margin: 0, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        {event.description}
      </p>
    </div>
  );
}

// ── City at a glance strip ────────────────────────────────────────────────────

function CityGlance({ city, onNavigate }: { city: City; onNavigate: (tab: Tab) => void }) {
  const digest = (digestsJson as Record<string, { schedule?: string; keyTopics?: string[]; meetingDate?: string }>)[city];
  const nextMeeting = digest?.schedule ? calcNextMeeting(digest.schedule) : null;
  const lastTopic = digest?.keyTopics?.[0] ?? null;

  const activeStatuses = new Set(["proposed", "approved", "under-construction", "opening-soon"]);
  const activeProjects = DEV_PROJECTS.filter(
    (p) => p.cityId === city && activeStatuses.has(p.status)
  ).length;

  if (!nextMeeting && !activeProjects && !lastTopic) return null;

  const tileStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    background: "var(--sb-card)",
    border: "1px solid var(--sb-border-light)",
    borderRadius: "var(--sb-radius)",
    padding: "10px 14px",
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
    transition: "box-shadow 0.12s, border-color 0.12s",
  };

  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}
      className="sb-city-glance">
      {nextMeeting && (
        <button
          style={tileStyle}
          onClick={() => onNavigate("government")}
          onMouseEnter={(e) => { e.currentTarget.style.boxShadow = "var(--sb-shadow-hover)"; e.currentTarget.style.borderColor = "var(--sb-primary)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.borderColor = "var(--sb-border-light)"; }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>
            🏛️ Next Council Meeting
          </div>
          <div style={{ fontWeight: 700, fontSize: 13, color: "var(--sb-ink)" }}>{nextMeeting}</div>
          {lastTopic && (
            <div style={{ fontSize: 11, color: "var(--sb-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Last: {lastTopic}
            </div>
          )}
        </button>
      )}
      {activeProjects > 0 && (
        <button
          style={tileStyle}
          onClick={() => onNavigate("development")}
          onMouseEnter={(e) => { e.currentTarget.style.boxShadow = "var(--sb-shadow-hover)"; e.currentTarget.style.borderColor = "var(--sb-primary)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.borderColor = "var(--sb-border-light)"; }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>
            🏗️ Active Projects
          </div>
          <div style={{ fontWeight: 700, fontSize: 22, color: "var(--sb-ink)", lineHeight: 1 }}>{activeProjects}</div>
          <div style={{ fontSize: 11, color: "var(--sb-muted)", marginTop: 2 }}>projects underway</div>
        </button>
      )}
    </div>
  );
}

// ── City picker ───────────────────────────────────────────────────────────────

function CityPicker({ homeCity, onSelect, onClose }: { homeCity: City | null; onSelect: (city: City) => void; onClose?: () => void }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Pick your home city</span>
        {onClose && (
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--sb-muted)", cursor: "pointer", fontSize: 13, fontWeight: 500, padding: 0 }}>
            Cancel
          </button>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {CITIES.map((city) => (
          <button
            key={city.id}
            onClick={() => onSelect(city.id)}
            style={{ padding: "6px 14px", borderRadius: 100, border: `1px solid ${homeCity === city.id ? "var(--sb-ink)" : "var(--sb-border)"}`, background: homeCity === city.id ? "var(--sb-ink)" : "var(--sb-card)", color: homeCity === city.id ? "white" : "var(--sb-muted)", fontSize: 13, fontWeight: 500, cursor: "pointer", transition: "all 0.15s" }}
          >
            {city.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Bucketed event list ───────────────────────────────────────────────────────

type AnyEvent = { _type: "static"; event: SBEvent } | { _type: "upcoming"; event: UpcomingEvent };

function bucketEvents(
  statics: SBEvent[],
  upcoming: UpcomingEvent[],
  showCity: boolean,
  highlight = false,
): React.ReactNode {
  const buckets: Record<TimeBucket, AnyEvent[]> = { now: [], morning: [], afternoon: [], evening: [], none: [] };

  for (const e of statics) buckets[timeBucket(e.time)].push({ _type: "static", event: e });
  for (const e of upcoming) {
    if (e.category === "sports") continue; // sports shown in callout
    buckets[timeBucket(e.time)].push({ _type: "upcoming", event: e });
  }

  const hasMultipleBuckets =
    BUCKET_ORDER.filter((b) => buckets[b].length > 0).length > 1;

  return (
    <>
      {BUCKET_ORDER.map((bucket) => {
        const items = buckets[bucket];
        if (!items.length) return null;
        return (
          <div key={bucket}>
            {hasMultipleBuckets && (
              <div style={{
                fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                letterSpacing: "0.08em", textTransform: "uppercase",
                color: bucket === "now" ? "var(--sb-accent)" : "var(--sb-muted)",
                paddingTop: 12, paddingBottom: 2,
                borderBottom: "1px solid var(--sb-border-light)",
                marginBottom: 0,
              }}>
                {bucket === "now" && "● "}{BUCKET_LABELS[bucket]}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "0 32px" }}
              className="sb-today-grid">
              {items.map((item) =>
                item._type === "static"
                  ? <EventRow key={item.event.id} event={item.event} showCity={showCity} />
                  : <UpcomingRow key={item.event.id} event={item.event} showCity={showCity} highlight={highlight} />
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  homeCity: City | null;
  setHomeCity: (city: City | null) => void;
  onNavigate: (tab: Tab) => void;
}

export default function OverviewView({ homeCity, setHomeCity, onNavigate }: Props) {
  const [weather, setWeather] = useState<string | null>(null);
  const [changingCity, setChangingCity] = useState(false);
  const [showAllSouthBay, setShowAllSouthBay] = useState(false);

  useEffect(() => {
    fetch("/api/weather")
      .then((r) => r.json())
      .then((d) => setWeather(d.weather ?? null))
      .catch(() => {});
  }, []);

  // ── Upcoming scraped events for today ──
  const allUpcoming = (upcomingJson as { events: UpcomingEvent[] }).events ?? [];
  const todayUpcoming = allUpcoming.filter((e) => e.date === TODAY_ISO && !e.ongoing);

  // Sports events today — pulled out for hero callout
  const todaySportsEvents = todayUpcoming
    .filter((e) => e.category === "sports")
    .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));

  // ── Seasonal events for "This Month" section ──
  const thisMonthEvents = SOUTH_BAY_EVENTS
    .filter((e) => e.recurrence === "seasonal" && e.months?.includes(MONTH) && e.category !== "sports")
    .sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0))
    .slice(0, 6);

  const nextMonthPreview = SOUTH_BAY_EVENTS
    .filter((e) => e.recurrence === "seasonal" && e.months?.includes(NEXT_MONTH) && !e.months?.includes(MONTH) && e.category !== "sports")
    .sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0))
    .slice(0, 4);

  const showThisMonth = thisMonthEvents.length > 0;

  // ── Today: home city ──
  const cityTodayStatic = homeCity
    ? SOUTH_BAY_EVENTS
        .filter((e) => e.city === homeCity && isActiveToday(e))
        .sort((a, b) => startMinutes(a.time) - startMinutes(b.time))
    : [];

  const cityTodayUpcoming = homeCity
    ? todayUpcoming
        .filter((e) => e.city === homeCity)
        .filter((e) => isNotEnded(e.time))
        .sort((a, b) => startMinutes(a.time) - startMinutes(b.time))
    : [];

  const cityTodayCount = cityTodayStatic.length + cityTodayUpcoming.length;

  // ── Today: south bay-wide (excluding home city) ──
  const southBayTodayStatic = SOUTH_BAY_EVENTS
    .filter((e) => isActiveToday(e) && (homeCity ? e.city !== homeCity : true))
    .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));

  const southBayTodayUpcoming = todayUpcoming
    .filter((e) => (homeCity ? e.city !== homeCity : true))
    .filter((e) => isNotEnded(e.time))
    .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));

  const southBayCount = southBayTodayStatic.length + southBayTodayUpcoming.length;

  const cityIsEmpty = homeCity && cityTodayCount < 5;
  const showExpandedRegional = cityIsEmpty;
  const SB_LIMIT = homeCity ? 6 : 8;

  return (
    <>
      {/* ── City prompt / picker ── */}
      {!homeCity && !changingCity ? (
        <div style={{ background: "var(--sb-primary-light)", border: "1px solid var(--sb-border-light)", borderRadius: "var(--sb-radius)", padding: "12px 16px", marginBottom: 24, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "var(--sb-muted)", lineHeight: 1.4 }}>
            Personalize for your city — see your council meetings, active projects, and local events.
          </span>
          <button
            onClick={() => setChangingCity(true)}
            style={{ padding: "6px 14px", borderRadius: 100, border: "1px solid var(--sb-ink)", background: "var(--sb-ink)", color: "white", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
          >
            Set my city →
          </button>
        </div>
      ) : changingCity ? (
        <CityPicker
          homeCity={homeCity}
          onSelect={(city) => { setHomeCity(city); setChangingCity(false); }}
          onClose={() => setChangingCity(false)}
        />
      ) : null}

      {/* ── Weather strip ── */}
      {weather && (
        <div style={{ background: "var(--sb-primary-light)", border: "1px solid var(--sb-border-light)", borderRadius: "var(--sb-radius)", padding: "10px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 14, color: "var(--sb-ink)", fontWeight: 500 }}>{weather}</span>
          <span style={{ fontSize: 11, color: "var(--sb-muted)", letterSpacing: "0.04em" }}>
            · {homeCity ? getCityName(homeCity) : "South Bay"}, CA
          </span>
        </div>
      )}

      {/* ── City at a glance ── */}
      {homeCity && !changingCity && (
        <CityGlance city={homeCity} onNavigate={onNavigate} />
      )}

      {/* ── Sports callout ── */}
      {todaySportsEvents.length > 0 && (
        <SportsCallout events={todaySportsEvents} />
      )}

      {/* ── Your City Today (or expanded regional if sparse) ── */}
      {homeCity && (
        <div style={{ marginBottom: 32 }}>
          <div className="sb-section-header" style={{ marginBottom: 12 }}>
            <span className="sb-section-title">
              {showExpandedRegional ? "Today in the South Bay" : `Today in ${getCityName(homeCity)}`}
            </span>
            {cityTodayCount > 0 && !showExpandedRegional && (
              <span style={{ fontSize: 12, fontWeight: 500, color: "var(--sb-muted)" }}>
                {cityTodayCount} {cityTodayCount === 1 ? "event" : "events"}
              </span>
            )}
            <button
              onClick={() => setChangingCity(true)}
              style={{ marginLeft: "auto", background: "none", border: "none", fontSize: 12, color: "var(--sb-muted)", cursor: "pointer", padding: 0, textDecoration: "underline", textUnderlineOffset: 3 }}
            >
              Change city
            </button>
          </div>

          {showExpandedRegional ? (
            <>
              {cityTodayCount === 0 && southBayCount === 0 ? (
                <div style={{ padding: "16px 0", color: "var(--sb-muted)", fontSize: 13, fontStyle: "italic" }}>
                  Nothing on the calendar today ({WEEKDAY}). Check the Events tab for upcoming events.
                </div>
              ) : (
                <>
                  {bucketEvents(cityTodayStatic, cityTodayUpcoming, false, true)}
                  <div style={{ marginTop: 8 }}>
                    {bucketEvents(
                      southBayTodayStatic.slice(0, SB_LIMIT),
                      southBayTodayUpcoming.slice(0, SB_LIMIT),
                      true,
                    )}
                  </div>
                  {southBayCount > SB_LIMIT && !showAllSouthBay && (
                    <button onClick={() => setShowAllSouthBay(true)} style={{ display: "block", marginTop: 12, padding: "8px 0", background: "none", border: "none", color: "var(--sb-primary)", fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}>
                      Show {southBayCount - SB_LIMIT} more →
                    </button>
                  )}
                  {showAllSouthBay && bucketEvents(
                    southBayTodayStatic.slice(SB_LIMIT),
                    southBayTodayUpcoming.slice(SB_LIMIT),
                    true,
                  )}
                </>
              )}
            </>
          ) : (
            <>
              {cityTodayCount === 0 ? (
                <div style={{ padding: "16px 0", color: "var(--sb-muted)", fontSize: 13, fontStyle: "italic" }}>
                  Nothing scheduled in {getCityName(homeCity)} today ({WEEKDAY}). Check the Events tab for upcoming events.
                </div>
              ) : (
                <>
                  {bucketEvents(cityTodayStatic, cityTodayUpcoming, false)}
                  {cityTodayCount > 10 && (
                    <div style={{ paddingTop: 10, fontSize: 12, color: "var(--sb-muted)" }}>
                      See Events tab for all {getCityName(homeCity)} events.
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* ── This Month in the South Bay ── */}
      {showThisMonth && (
        <div style={{ marginBottom: 32 }}>
          <div className="sb-section-header" style={{ marginBottom: 16 }}>
            <span className="sb-section-title">This Month</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--sb-accent)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{MONTH_NAME}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
            {thisMonthEvents.map((e) => <MonthCard key={e.id} event={e} />)}
          </div>
        </div>
      )}

      {/* ── Coming Up Next Month ── */}
      {nextMonthPreview.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="sb-section-header" style={{ marginBottom: 16 }}>
            <span className="sb-section-title">Coming Up</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{NEXT_MONTH_NAME}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
            {nextMonthPreview.map((e) => <MonthCard key={e.id} event={e} isUpcoming />)}
          </div>
        </div>
      )}

      {/* ── Happening Today, South Bay (only when no home city or not expanded) ── */}
      {!showExpandedRegional && (
        <div style={{ marginBottom: 32 }}>
          <div className="sb-section-header" style={{ marginBottom: 0 }}>
            <span className="sb-section-title">
              {homeCity ? "Across the South Bay" : "Happening Today"}
            </span>
            {southBayCount > 0 && (
              <span style={{ fontSize: 12, fontWeight: 500, color: "var(--sb-muted)" }}>
                {southBayCount} {southBayCount === 1 ? "event" : "events"}
              </span>
            )}
          </div>

          {southBayCount === 0 ? (
            <div style={{ padding: "20px 0", color: "var(--sb-muted)", fontSize: 14, fontStyle: "italic" }}>
              {homeCity
                ? `No events found across the region today (${WEEKDAY}).`
                : `No recurring events on ${WEEKDAY}s this time of year.`}
            </div>
          ) : (
            <>
              {bucketEvents(
                showAllSouthBay ? southBayTodayStatic : southBayTodayStatic.slice(0, SB_LIMIT),
                showAllSouthBay ? southBayTodayUpcoming : southBayTodayUpcoming.slice(0, SB_LIMIT),
                true,
              )}
              {southBayCount > SB_LIMIT && !showAllSouthBay && (
                <button onClick={() => setShowAllSouthBay(true)} style={{ display: "block", marginTop: 12, padding: "8px 0", background: "none", border: "none", color: "var(--sb-primary)", fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}>
                  Show {southBayCount - SB_LIMIT} more events →
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Sports scoreboard ── */}
      <SportsView />
    </>
  );
}
