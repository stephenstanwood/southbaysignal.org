import { useState, useEffect } from "react";
import SportsView from "./SportsView";
import OutagesCard from "../cards/OutagesCard";
import RealEstateCard from "../cards/RealEstateCard";
import AirQualityCard from "../cards/AirQualityCard";
import QuakeWatchCard from "../cards/QuakeWatchCard";
import WaterWatchCard from "../cards/WaterWatchCard";
import {
  SOUTH_BAY_EVENTS,
  type SBEvent,
  type DayOfWeek,
} from "../../../data/south-bay/events-data";
import { DEV_PROJECTS, STATUS_CONFIG } from "../../../data/south-bay/development-data";
import { TRANSIT_AGENCIES, STATUS_CONFIG as TRANSIT_STATUS_CONFIG } from "../../../data/south-bay/transit-data";
import { CITIES, getCityName } from "../../../lib/south-bay/cities";
import type { City, Tab } from "../../../lib/south-bay/types";
import upcomingJson from "../../../data/south-bay/upcoming-events.json";
import digestsJson from "../../../data/south-bay/digests.json";
import aroundTownJson from "../../../data/south-bay/around-town.json";
import weekendPicksJson from "../../../data/south-bay/weekend-picks.json";
import springBreakJson from "../../../data/south-bay/spring-break-picks.json";
import healthScoresJson from "../../../data/south-bay/health-scores.json";
import schoolCalJson from "../../../data/south-bay/school-calendar.json";
import cityBriefingsJson from "../../../data/south-bay/city-briefings.json";
import curatedPhotosJson from "../../../data/south-bay/curated-photos.json";

// ── Types ─────────────────────────────────────────────────────────────────────

type ForecastDay = {
  date: string;
  emoji: string;
  desc: string;
  high: number;
  low: number;
  rainPct: number;
};

type UpcomingEvent = {
  id: string;
  title: string;
  date: string;
  displayDate?: string;
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
// All time/date constants use Pacific time — never UTC
const NOW_PT = new Date(NOW.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
const NOW_MINUTES = NOW_PT.getHours() * 60 + NOW_PT.getMinutes();
const TODAY_ISO = NOW.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const MONTH = NOW_PT.getMonth() + 1;
const NEXT_MONTH = MONTH === 12 ? 1 : MONTH + 1;
const DAY_IDX = NOW_PT.getDay(); // Pacific day-of-week
const DAY_NAME = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][DAY_IDX];
const WEEKDAY = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][DAY_IDX];
const MONTH_NAME = NOW.toLocaleDateString("en-US", { month: "long" });
const NEXT_MONTH_NAME = new Date(NOW.getFullYear(), NOW.getMonth() + 1, 1).toLocaleDateString("en-US", { month: "long" });

// Pre-compute the next 6 dates (tomorrow through 6 days from now)
const NEXT_DAYS: Array<{ iso: string; label: string }> = Array.from({ length: 6 }, (_, i) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + i + 1);
  d.setHours(0, 0, 0, 0);
  const iso = d.toISOString().split("T")[0];
  const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return { iso, label };
});

// ── Weekend mode ───────────────────────────────────────────────────────────────
const IS_WEEKEND_MODE = DAY_IDX === 5 || DAY_IDX === 6 || DAY_IDX === 0; // Fri / Sat / Sun
// Only show tomorrow's events in the weekend section if tomorrow is also a weekend day:
// Fri→Sat ✓, Sat→Sun ✓, Sun→Mon ✗
const SHOW_WEEKEND_TOMORROW = DAY_IDX === 5 || DAY_IDX === 6;
const _tmrow = new Date(NOW_PT.getFullYear(), NOW_PT.getMonth(), NOW_PT.getDate() + 1);
const TOMORROW_DAY_NAME = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][_tmrow.getDay()] as DayOfWeek;
const TOMORROW_MONTH_NUM = _tmrow.getMonth() + 1;
const TOMORROW_ISO_STR = NEXT_DAYS[0]?.iso ?? "";
const TOMORROW_LABEL_STR = NEXT_DAYS[0]?.label ?? "Tomorrow";

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

function formatTimeRange(time: string | undefined | null, endTime: string | undefined | null, isSports = false): string | null {
  if (!time) return null;
  if (!endTime || isSports) return time;
  const startPeriod = time.match(/(am|pm)$/i)?.[1]?.toUpperCase();
  const endPeriod = endTime.match(/(am|pm)$/i)?.[1]?.toUpperCase();
  if (startPeriod && endPeriod && startPeriod === endPeriod) {
    return `${time.replace(/\s*(am|pm)$/i, "")}–${endTime}`;
  }
  return `${time}–${endTime}`;
}

function isNotEnded(timeStr: string | undefined | null): boolean {
  if (!timeStr) return true;
  const endMin = parseMinutes(timeStr, true);
  if (endMin === null) return true;
  return endMin > NOW_MINUTES;
}

// Hide an event once its start time has passed — user can't go if it's already started
function hasNotStarted(timeStr: string | undefined | null): boolean {
  if (!timeStr) return true; // no time = all-day, always show
  const startMin = parseMinutes(timeStr, false);
  if (startMin === null) return true; // unparseable, keep
  return startMin > NOW_MINUTES;
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
        return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      }
    }
  }
  return null;
}

// ── Static event helpers ──────────────────────────────────────────────────────

function isActiveToday(e: SBEvent): boolean {
  if ((e as any).startDate && TODAY_ISO < (e as any).startDate) return false;
  if (e.months && !e.months.includes(MONTH)) return false;
  if (!e.days) return e.recurrence !== "seasonal";
  if (!e.days.includes(DAY_NAME as DayOfWeek)) return false;
  return hasNotStarted(e.time);
}

function isActiveTomorrow(e: SBEvent): boolean {
  if ((e as any).startDate && TOMORROW_ISO_STR < (e as any).startDate) return false;
  if (e.months && !e.months.includes(TOMORROW_MONTH_NUM)) return false;
  if (!e.days) return e.recurrence !== "seasonal";
  return e.days.includes(TOMORROW_DAY_NAME);
}

function cityLabel(city: string): string {
  return city.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function costBadge(cost: string, costNote?: string): { label: string; bg: string; color: string } {
  if (cost === "free") return { label: "FREE", bg: "#D1FAE5", color: "#065F46" };
  if (cost === "low") return { label: costNote?.split(" ")[0] ?? "$", bg: "#FEF3C7", color: "#92400E" };
  const priceHint = costNote?.split(" ")[0];
  const label = priceHint && /^[\$\d]/.test(priceHint) ? priceHint : "$$";
  return { label, bg: "#EDE9FE", color: "#5B21B6" };
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
  none: "Also Today",
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

function UpcomingRow({ event, showCity = true, highlight = false }: { event: UpcomingEvent; showCity?: boolean; highlight?: boolean }) {
  const badge = costBadge(event.cost);
  const showBadge = !(event.cost === "free" && event.category === "community");
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
                {meetingDisplayTitle(event.title, event.city)}
              </a>
            ) : meetingDisplayTitle(event.title, event.city)}
          </span>
          {showBadge && (
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: badge.bg, color: badge.color, letterSpacing: "0.04em", flexShrink: 0 }}>
              {badge.label}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--sb-muted)", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {showCity && <span>{cityLabel(event.city)}</span>}
          {event.time && (
            <>
              {showCity && <span style={{ color: "var(--sb-border)" }}>·</span>}
              <span>{formatTimeRange(event.time, event.endTime, event.category === "sports")}</span>
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

  const activeStatuses = new Set(["proposed", "approved", "under-construction", "opening-soon"]);
  const activeProjects = DEV_PROJECTS.filter(
    (p) => p.cityId === city && activeStatuses.has(p.status)
  ).length;

  if (!nextMeeting && !activeProjects) return null;

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
            🏛️ Next {getCityName(city)} Council Meeting
          </div>
          <div style={{ fontWeight: 700, fontSize: 13, color: "var(--sb-ink)" }}>{nextMeeting}</div>
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

// ── This Week in [City] briefing ──────────────────────────────────────────────

interface CityHighlight {
  type: "event" | "council" | "cityhall";
  title: string;
  when: string | null;
  venue: string | null;
  category: string;
  url: string | null;
}

interface CityBriefing {
  cityId: string;
  cityName: string;
  summary: string;
  highlights: CityHighlight[];
  weekLabel: string;
  generatedAt: string;
}

function CityWeeklyBriefing({ city }: { city: City }) {
  const data = cityBriefingsJson as { cities?: Record<string, CityBriefing> };
  const briefing = data.cities?.[city];
  if (!briefing?.summary) return null;

  const HIGHLIGHT_EMOJI: Record<string, string> = {
    music: "🎵", arts: "🎨", family: "👨‍👩‍👦", education: "📚",
    community: "🤝", market: "🌽", food: "🍜", outdoor: "🌿",
    sports: "🏟️", government: "🏛️",
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div className="sb-section-header" style={{ marginBottom: 14 }}>
        <span className="sb-section-title">📍 This Week in {briefing.cityName}</span>
        <span style={{ fontSize: 11, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace" }}>
          {briefing.weekLabel}
        </span>
      </div>

      <div style={{
        background: "#FEFCE8",
        border: "1.5px solid #FDE68A",
        borderRadius: 8,
        padding: "12px 14px",
      }}>
        {/* AI editorial lead */}
        <p style={{
          margin: "0 0 10px 0",
          fontSize: 13,
          lineHeight: 1.55,
          color: "var(--sb-ink)",
          fontStyle: "italic",
        }}>
          {briefing.summary}
        </p>

        {/* Highlights */}
        {briefing.highlights.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {briefing.highlights.map((h, i) => {
              const emoji = HIGHLIGHT_EMOJI[h.category] ?? "📅";
              const inner = (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }}>{emoji}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, fontWeight: 600,
                      color: h.url ? "var(--sb-primary)" : "var(--sb-ink)",
                      lineHeight: 1.35,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {h.title}
                    </div>
                    {(h.when || h.venue) && (
                      <div style={{
                        fontSize: 11, color: "var(--sb-muted)",
                        fontFamily: "'Space Mono', monospace", marginTop: 1,
                      }}>
                        {[h.when, h.venue].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </div>
                </div>
              );
              return h.url ? (
                <a
                  key={i}
                  href={h.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none", display: "block" }}
                >
                  {inner}
                </a>
              ) : (
                <div key={i}>{inner}</div>
              );
            })}
          </div>
        )}
      </div>
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

// ── Signal Briefing ───────────────────────────────────────────────────────────
// Newspaper front-page hero: 3 lead stories generated from live data

interface BriefingStory {
  category: string;
  headline: string;
  lede: string;
  tab: Tab;
  emoji: string;
  accentColor: string;
  url?: string;
}

function pickEventStory(): BriefingStory | null {
  // On weekends: use AI-curated pick if it's for this weekend (not stale)
  if (IS_WEEKEND_MODE) {
    const wknd = weekendPicksJson as { weekendStart?: string; picks?: Array<{ title: string; why: string; url?: string | null; cost: string; category: string; city: string }> };
    const { weekendStart, picks = [] } = wknd;
    if (weekendStart) {
      const daysDiff = (new Date(weekendStart + "T12:00:00").getTime() - Date.now()) / 86400000;
      const pick = daysDiff > -3 ? picks[0] : undefined; // fresh if started within last 3 days
      if (pick) {
        return {
          category: "This Weekend",
          headline: pick.title,
          lede: pick.why,
          tab: "events",
          emoji: CATEGORY_EMOJI[pick.category] ?? "📅",
          accentColor: "#16a34a",
          url: pick.url ?? undefined,
        };
      }
    }
  }

  // Weekday or stale weekend: find next upcoming event with a specific time
  const events = (upcomingJson as { events?: UpcomingEvent[] }).events ?? [];
  const next = events
    .filter((e) => !e.ongoing && e.date >= TODAY_ISO && e.time && e.category !== "sports")
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""))[0];

  if (next) {
    const label = next.displayDate + (next.time ? ` · ${next.time}` : "");
    return {
      category: "Coming Up",
      headline: next.title,
      lede: `${label} · ${next.venue || next.city}`,
      tab: "events",
      emoji: CATEGORY_EMOJI[next.category] ?? "📅",
      accentColor: "#16a34a",
      url: next.url ?? undefined,
    };
  }
  return null;
}

function pickElectionStory(): BriefingStory | null {
  const nowMidnight = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
  const primaryDate = new Date(2026, 5, 2); // June 2, 2026
  const generalDate = new Date(2026, 10, 3); // Nov 3, 2026
  const regDeadline = new Date(2026, 4, 18); // May 18, 2026

  const daysToReg = Math.ceil((regDeadline.getTime() - nowMidnight.getTime()) / 86400000);
  const daysToPrimary = Math.ceil((primaryDate.getTime() - nowMidnight.getTime()) / 86400000);
  const daysToGeneral = Math.ceil((generalDate.getTime() - nowMidnight.getTime()) / 86400000);

  // Only surface within 90 days of primary or general
  if (daysToPrimary < -30 && daysToGeneral > 90) return null;
  if (daysToPrimary > 90 && daysToGeneral > 90) return null;

  let headline: string;
  let lede: string;

  if (daysToPrimary > 0 && daysToReg > 0 && daysToReg <= 30) {
    headline = `Voter registration closes in ${daysToReg} days`;
    lede = `CA Primary is June 2 — deadline to register online/by mail is May 18. Governor race, US Senate, city councils, and more on the ballot.`;
  } else if (daysToPrimary > 0 && daysToPrimary <= 14) {
    headline = `CA Primary Election in ${daysToPrimary} days`;
    lede = `June 2 — vote on Governor, US Senate, State Legislature, Santa Clara County, and city council races across the South Bay.`;
  } else if (daysToPrimary > 0) {
    headline = `CA Primary Election: ${daysToPrimary} days away`;
    lede = `June 2, 2026. Governor (open seat), US Senate, and key South Bay city council races. Check your registration at sccvote.org.`;
  } else if (daysToGeneral > 0 && daysToGeneral <= 90) {
    headline = `General Election: ${daysToGeneral} days`;
    lede = `November 3, 2026 — general election for Governor, Congress, state legislature, and local offices across Santa Clara County.`;
  } else {
    return null;
  }

  return {
    category: "Elections 2026",
    headline,
    lede,
    tab: "government",
    emoji: "🗳️",
    accentColor: "#1d4ed8",
  };
}

function pickHealthStory(): BriefingStory | null {
  const { flags = [] } = healthScoresJson as { flags?: Array<{ name: string; city: string; date: string; result: string; summary: string }> };
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];
  const closures = flags.filter((f) => f.result === "Y" && f.date >= cutoff);
  if (!closures.length) return null;
  const f = closures[0];
  const sum = f.summary?.slice(0, 110) ?? "Temporarily closed following health inspection.";
  return {
    category: "Food Safety",
    headline: `${f.name} temporarily closed`,
    lede: `${f.city} · ${sum}${sum.length >= 110 ? "…" : ""}`,
    tab: "government",
    emoji: "⚠️",
    accentColor: "#92400E",
  };
}

// Topics that are procedural noise — not newsworthy
const GOVT_NOISE_TOPICS = [
  "roll call", "approval of minutes", "approval of agenda", "public comment",
  "approval of consent", "consent calendar", "closed session", "adjournment",
  "pledge of allegiance", "invocation", "presentations and proclamations",
  // Meeting logistics / accessibility — not civic decisions
  "multiple ways to watch", "live translation", "accessible meeting",
  "no public comment", "translation available",
  // Scheduling / procedural outcomes
  "cancelled", "rescheduled", "postponed", "continued to",
  "city council administrative",
];

function isNoisyTopic(topic: string): boolean {
  const lower = topic.toLowerCase();
  return GOVT_NOISE_TOPICS.some((n) => lower.startsWith(n));
}

function digestAge(meetingDate: string | undefined): number {
  if (!meetingDate) return 999;
  const d = new Date(meetingDate);
  if (isNaN(d.getTime())) return 999;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

function pickCityHallStory(
  homeCity: City | null,
  digests: Record<string, { summary?: string; keyTopics?: string[]; meetingDate?: string; schedule?: string }>,
): BriefingStory | null {
  // Prefer around-town.json — continuously updated from Stoa, always recent
  const items = (aroundTownJson as { items: AroundTownItem[] }).items ?? [];
  const cityItems = homeCity ? items.filter(it => it.cityId === homeCity) : [];
  const aroundItem = cityItems[0] ?? items[0];
  if (aroundItem) {
    const lede = aroundItem.cityName + " · " + (
      aroundItem.summary.length > 110
        ? aroundItem.summary.slice(0, 107) + "…"
        : aroundItem.summary
    );
    return {
      category: "Government",
      headline: aroundItem.headline,
      lede,
      tab: "government",
      emoji: "🏛️",
      accentColor: "#1d4ed8",
      url: aroundItem.sourceUrl,
    };
  }

  // Fall back to pre-generated digest data
  const cityOrder = [
    homeCity ?? "san-jose",
    "san-jose", "sunnyvale", "mountain-view", "palo-alto",
    "santa-clara", "cupertino", "saratoga", "los-gatos", "campbell",
  ].filter((v, i, a) => a.indexOf(v) === i);

  for (const city of cityOrder) {
    const digest = digests[city];
    if (!digest) continue;
    if (digestAge(digest.meetingDate) > 30) continue;
    const topic = digest.keyTopics?.find((t) => !isNoisyTopic(t));
    if (!topic) continue;
    const cLabel = getCityName(city as City);
    const lede = digest.summary?.slice(0, 130) ?? `${cLabel} City Council, ${digest.meetingDate ?? "recent meeting"}.`;
    return {
      category: "Government",
      headline: topic,
      lede: lede.length > 130 ? lede.slice(0, 127) + "…" : lede,
      tab: "government",
      emoji: "🏛️",
      accentColor: "#1d4ed8",
    };
  }

  return {
    category: "Government",
    headline: "City Hall Digest",
    lede: "Plain-English summaries of city council meetings across 8 South Bay cities.",
    tab: "government",
    emoji: "🏛️",
    accentColor: "#1d4ed8",
  };
}

// Timelines that signal a decade-away project — not "what's happening now"
const FAR_FUTURE_PATTERN = /2030s|2031|2032|2033|2034|2035|2036|2037|2038|2039|2040s|long.term/i;

function isNearTerm(timeline: string | undefined): boolean {
  if (!timeline) return true;
  return !FAR_FUTURE_PATTERN.test(timeline);
}

function pickDevelopmentStory(): BriefingStory | null {
  const active = DEV_PROJECTS.filter(
    (p) => p.status === "under-construction" || p.status === "opening-soon",
  );
  if (!active.length) return null;

  // Priority: opening-soon > near-term under-construction > anything else
  const openingSoon = active.filter((p) => p.status === "opening-soon");
  const nearTerm = active.filter(
    (p) => p.status === "under-construction" && isNearTerm(p.timeline),
  );
  const fallback = active;

  const pool = openingSoon.length ? openingSoon : nearTerm.length ? nearTerm : fallback;
  // Within the pool, prefer featured; otherwise first
  const p = pool.find((p) => p.featured) ?? pool[0];

  const statusLabel = STATUS_CONFIG[p.status]?.label ?? p.status;
  const lede = p.description
    ? (p.description.length > 120 ? p.description.slice(0, 117) + "…" : p.description)
    : `${statusLabel} · ${p.city}${p.scale ? ` · ${p.scale}` : ""}${p.timeline ? ` · ${p.timeline}` : ""}`;
  return {
    category: "Development",
    headline: p.name,
    lede,
    tab: "development",
    emoji: "🏗️",
    accentColor: "#b45309",
  };
}

function SignalBriefing({
  homeCity,
  todayUpcoming,
  todayStatic,
  onNavigate,
}: {
  homeCity: City | null;
  todayUpcoming: UpcomingEvent[];
  todayStatic: SBEvent[];
  onNavigate: (tab: Tab) => void;
}) {
  const digests = digestsJson as Record<string, { summary?: string; keyTopics?: string[]; meetingDate?: string; schedule?: string }>;

  const stories: BriefingStory[] = [
    pickEventStory(),
    pickCityHallStory(homeCity, digests),
    pickElectionStory() ?? pickHealthStory() ?? pickDevelopmentStory(),
  ].filter((s): s is BriefingStory => s !== null);

  if (!stories.length) return null;

  return (
    <div style={{ marginBottom: 32 }}>
      {/* Section label */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, marginBottom: 14,
      }}>
        <div style={{
          height: 1, flex: 1,
          background: "var(--sb-border-light)",
        }} />
        <span style={{
          fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace",
          letterSpacing: "0.14em", textTransform: "uppercase",
          color: "var(--sb-muted)", flexShrink: 0,
        }}>
          Signal Briefing
        </span>
        <div style={{
          height: 1, flex: 1,
          background: "var(--sb-border-light)",
        }} />
      </div>

      {/* 3-column newspaper grid */}
      <div className="sb-briefing-grid">
        {stories.map((story, i) => (
          <button
            key={i}
            className="sb-briefing-card"
            onClick={() => {
              if (story.url) window.open(story.url, "_blank", "noopener");
              else onNavigate(story.tab);
            }}
          >
            {/* Category label */}
            <div style={{
              fontSize: 9, fontWeight: 700, letterSpacing: "0.12em",
              textTransform: "uppercase", color: story.accentColor,
              fontFamily: "'Space Mono', monospace",
              marginBottom: 6,
            }}>
              {story.emoji} {story.category}
            </div>

            {/* Headline */}
            <div style={{
              fontFamily: "var(--sb-serif)",
              fontWeight: 700,
              fontSize: 15,
              lineHeight: 1.35,
              color: "var(--sb-ink)",
              marginBottom: 8,
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}>
              {story.headline}
            </div>

            {/* Lede */}
            <div style={{
              fontSize: 12,
              color: "var(--sb-muted)",
              lineHeight: 1.55,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              flex: 1,
            }}>
              {story.lede}
            </div>

            {/* Read more */}
            <div style={{
              marginTop: 10,
              fontSize: 11,
              fontWeight: 600,
              color: story.accentColor,
              display: "flex",
              alignItems: "center",
              gap: 3,
            }}>
              {story.url
                ? "Read more →"
                : story.category === "Government" ? "Read full digest →"
                : story.category === "Food Safety" ? "See health scores →"
                : story.category === "Development" ? "See all projects →"
                : "See all events →"}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Our Picks (weekend editorial) ────────────────────────────────────────────

interface WeekendPick {
  id: string;
  title: string;
  date: string;
  displayDate: string;
  time: string | null;
  city: string;
  venue: string;
  cost: string;
  url?: string | null;
  category: string;
  why: string;
}

function WeekendPicksCard() {
  const data = weekendPicksJson as { weekendLabel?: string; picks?: WeekendPick[] };
  const picks = (data.picks ?? []).filter((p) => {
    if (p.date < TODAY_ISO) return false;
    if (p.date === TODAY_ISO) return hasNotStarted(p.time);
    return true;
  });
  if (!picks.length) return null;

  return (
    <div style={{ marginBottom: 32 }}>
      <div className="sb-section-header" style={{ marginBottom: 12 }}>
        <span className="sb-section-title">⭐ Our Picks</span>
        {data.weekendLabel && (
          <span style={{ fontSize: 11, color: "var(--sb-muted)", fontWeight: 500 }}>
            {data.weekendLabel}
          </span>
        )}
        <div className="sb-section-line" />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {picks.map((pick) => {
          const emoji = CATEGORY_EMOJI[pick.category] ?? "📅";
          const cityName = pick.city
            .split("-")
            .map((w) => w[0].toUpperCase() + w.slice(1))
            .join(" ");

          return (
            <div
              key={pick.id}
              style={{
                border: "1.5px solid var(--sb-border-light)",
                borderRadius: 8,
                padding: "12px 14px",
                background: "#fff",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <span style={{ fontSize: 20, flexShrink: 0, marginTop: 1 }}>{emoji}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 3 }}>
                    {pick.url ? (
                      <a
                        href={pick.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          fontSize: 14, fontWeight: 700, color: "var(--sb-ink)",
                          textDecoration: "none",
                        }}
                      >
                        {pick.title}
                      </a>
                    ) : (
                      <span style={{ fontSize: 14, fontWeight: 700, color: "var(--sb-ink)" }}>
                        {pick.title}
                      </span>
                    )}
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
                      background: pick.cost === "free" ? "#DCFCE7" : "#F3F4F6",
                      color: pick.cost === "free" ? "#15803D" : "var(--sb-muted)",
                      flexShrink: 0,
                    }}>
                      {pick.cost === "free" ? "FREE" : "PAID"}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--sb-muted)", marginBottom: 5, lineHeight: 1.45 }}>
                    {pick.why}
                  </div>
                  <div style={{
                    fontSize: 11, color: "var(--sb-light)",
                    fontFamily: "'Space Mono', monospace",
                    display: "flex", gap: 8, flexWrap: "wrap",
                  }}>
                    <span>{pick.displayDate}{pick.time ? ` · ${pick.time}` : ""}</span>
                    <span>·</span>
                    <span>{pick.venue || cityName}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Spring Break Guide ────────────────────────────────────────────────────────

interface SpringBreakPick {
  id: string;
  title: string;
  date: string;
  displayDate: string;
  time: string | null;
  ongoing: boolean;
  city: string;
  venue: string;
  cost: string;
  url?: string | null;
  category: string;
  why: string;
}

function SpringBreakCard() {
  const data = springBreakJson as {
    label?: string;
    subtitle?: string;
    breakStart?: string;
    breakEnd?: string;
    picks?: SpringBreakPick[];
  };
  const picks = data.picks ?? [];
  if (!picks.length) return null;

  // Show from one week before break through end of break
  const today = new Date().toISOString().split("T")[0];
  const showAfter = "2026-03-28"; // one week before Easter weekend
  const showUntil = data.breakEnd ?? "2026-04-17";
  if (today < showAfter || today > showUntil) return null;

  return (
    <div style={{ marginBottom: 32 }}>
      <div className="sb-section-header" style={{ marginBottom: 12 }}>
        <span className="sb-section-title">🌸 Spring Break Guide</span>
        {data.subtitle && (
          <span style={{ fontSize: 11, color: "var(--sb-muted)", fontWeight: 500 }}>
            {data.subtitle}
          </span>
        )}
        <div className="sb-section-line" />
      </div>

      {(() => {
        // Group picks by week
        const weeks = [
          { label: "Easter Weekend", dateRange: "Apr 3–5", start: "2026-04-03", end: "2026-04-05" },
          { label: "Week 1", dateRange: "Apr 6–10", start: "2026-04-06", end: "2026-04-10" },
          { label: "Week 2", dateRange: "Apr 11–17", start: "2026-04-11", end: "2026-04-17" },
        ];
        // Sort picks by date
        const sorted = [...picks].sort((a, b) => a.date.localeCompare(b.date));
        return weeks.map((week) => {
          const weekPicks = sorted.filter((p) => p.date >= week.start && p.date <= week.end);
          if (weekPicks.length === 0) return null;
          return (
            <div key={week.label} style={{ marginBottom: 16 }}>
              <div style={{
                fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                letterSpacing: "0.1em", textTransform: "uppercase",
                color: "var(--sb-muted)", marginBottom: 8,
                display: "flex", alignItems: "center", gap: 8,
              }}>
                <span style={{ color: "var(--sb-accent)", background: "var(--sb-cream)", border: "1px solid var(--sb-border-light)", borderRadius: 3, padding: "2px 6px" }}>{week.label}</span>
                <span>{week.dateRange}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {weekPicks.map((pick) => {
                  const emoji = CATEGORY_EMOJI[pick.category] ?? "📅";
                  const cityName = pick.city
                    .split("-")
                    .map((w: string) => w[0].toUpperCase() + w.slice(1))
                    .join(" ");
                  return (
                    <div
                      key={pick.id}
                      style={{
                        border: "1.5px solid var(--sb-border-light)",
                        borderRadius: 8,
                        padding: "12px 14px",
                        background: "#fff",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                        <span style={{ fontSize: 20, flexShrink: 0, marginTop: 1 }}>{emoji}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 3 }}>
                            {pick.url ? (
                              <a
                                href={pick.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                  fontSize: 14, fontWeight: 700, color: "var(--sb-ink)",
                                  textDecoration: "none",
                                }}
                              >
                                {pick.title}
                              </a>
                            ) : (
                              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--sb-ink)" }}>
                                {pick.title}
                              </span>
                            )}
                            <span style={{
                              fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
                              background: pick.cost === "free" ? "#DCFCE7" : "#F3F4F6",
                              color: pick.cost === "free" ? "#15803D" : "var(--sb-muted)",
                              flexShrink: 0,
                            }}>
                              {pick.cost === "free" ? "FREE" : "PAID"}
                            </span>
                          </div>
                          <div style={{ fontSize: 12, color: "var(--sb-muted)", marginBottom: 5, lineHeight: 1.45 }}>
                            {pick.why}
                          </div>
                          <div style={{
                            fontSize: 11, color: "var(--sb-light)",
                            fontFamily: "'Space Mono', monospace",
                            display: "flex", gap: 8, flexWrap: "wrap",
                          }}>
                            {pick.ongoing ? (
                              <span>Ongoing exhibit</span>
                            ) : (
                              <span>{pick.displayDate}{pick.time ? ` · ${pick.time}` : ""}</span>
                            )}
                            <span>·</span>
                            <span>{pick.venue || cityName}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        });
      })()}
    </div>
  );
}

// ── 5-day forecast strip ──────────────────────────────────────────────────────

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── Transit Status Bar ────────────────────────────────────────────────────────
// Shows on Overview when any South Bay agency has non-normal status or active alerts.
// Always shows Caltrain + VTA (the primary South Bay commuter services).

function TransitStatusBar({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  // Focus on the two primary South Bay commuter agencies
  const SHOWN_IDS = ["caltrain", "vta"];
  const agencies = TRANSIT_AGENCIES.filter((a) => SHOWN_IDS.includes(a.id));

  // Parse date like "March 31, 2026" or "April 15, 2026"
  function parseAlertDate(s: string | undefined): Date | null {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // Active alerts: those without an endDate or whose endDate hasn't passed yet
  // Exclude permanent informational ones (no endDate + not about a disruption)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  function activeAlerts(agency: typeof TRANSIT_AGENCIES[0]) {
    return agency.alerts.filter((a) => {
      const end = parseAlertDate(a.endDate);
      // If there's an endDate, keep if it's today or future
      if (end) return end >= today;
      // No endDate — only show if the agency has a non-normal status (operational alert)
      return agency.status !== "normal";
    });
  }

  const hasAnyAlerts = agencies.some(
    (a) => a.status !== "normal" || activeAlerts(a).length > 0
  );

  // Always render the bar — it gives residents a quick daily check
  // But keep it very compact

  return (
    <div style={{
      marginBottom: 16,
      border: "1px solid var(--sb-border-light)",
      borderRadius: 8,
      overflow: "hidden",
      background: "#FAFAFA",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 12px",
        borderBottom: "1px solid var(--sb-border-light)",
        background: hasAnyAlerts ? "#FFFBEB" : "#F9FAFB",
      }}>
        <span style={{ fontSize: 13 }}>🚉</span>
        <span style={{
          fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
          textTransform: "uppercase", fontFamily: "'Space Mono', monospace",
          color: hasAnyAlerts ? "#92400E" : "var(--sb-muted)",
        }}>
          Transit Status
        </span>
        <button
          onClick={() => onNavigate("transit")}
          style={{
            marginLeft: "auto", background: "none", border: "none",
            fontSize: 11, color: "var(--sb-primary)", cursor: "pointer",
            padding: 0, fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 2,
          }}
        >
          Full info →
        </button>
      </div>

      {/* Agency rows */}
      <div style={{ padding: "6px 0" }}>
        {agencies.map((agency, i) => {
          const cfg = TRANSIT_STATUS_CONFIG[agency.status];
          const alerts = activeAlerts(agency);
          return (
            <div
              key={agency.id}
              style={{
                padding: "5px 12px",
                borderBottom: i < agencies.length - 1 ? "1px solid var(--sb-border-light)" : "none",
              }}
            >
              {/* Agency name + status badge */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13 }}>{agency.emoji}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--sb-ink)" }}>
                  {agency.shortName}
                </span>
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  fontSize: 10, fontWeight: 600, padding: "1px 7px",
                  borderRadius: 100, color: cfg.color, background: cfg.bg,
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: "50%",
                    background: cfg.dot, flexShrink: 0, display: "inline-block",
                  }} />
                  {cfg.label}
                </span>
                {agency.status !== "normal" && (
                  <span style={{ fontSize: 11, color: "#92400E" }}>{agency.statusNote}</span>
                )}
              </div>

              {/* Active alerts for this agency */}
              {alerts.map((alert) => (
                <div key={alert.id} style={{
                  marginTop: 3,
                  paddingLeft: 22,
                  fontSize: 11,
                  color: "var(--sb-muted)",
                  lineHeight: 1.4,
                }}>
                  <span style={{ color: alert.endDate ? "#92400E" : "var(--sb-muted)" }}>
                    {alert.summary}
                  </span>
                  {alert.endDate && (
                    <span style={{ color: "var(--sb-muted)", marginLeft: 4 }}>
                      · thru {alert.endDate}
                    </span>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function tempColor(t: number) {
  if (t >= 95) return "#C2290A";
  if (t >= 85) return "#E8531D";
  if (t >= 75) return "#D97706";
  if (t >= 65) return "#4D7C0F";
  if (t >= 55) return "#0284C7";
  return "#4F46E5";
}

function tempBg(t: number, strong = false) {
  const a = strong ? 0.10 : 0.05;
  if (t >= 95) return `rgba(194,41,10,${a})`;
  if (t >= 85) return `rgba(232,83,29,${a})`;
  if (t >= 75) return `rgba(217,119,6,${a})`;
  if (t >= 65) return `rgba(77,124,15,${a})`;
  if (t >= 55) return `rgba(2,132,199,${a})`;
  return `rgba(79,70,229,${a})`;
}

function ForecastStrip({ forecast }: { forecast: ForecastDay[] }) {
  const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: `repeat(${forecast.length}, 1fr)`,
        border: "1.5px solid var(--sb-border-light)",
        borderRadius: 8,
        overflow: "hidden",
        background: "#fff",
      }}>
        {forecast.map((day, i) => {
          const isToday = day.date === todayISO;
          const d = new Date(day.date + "T12:00:00");
          const label = isToday ? "TODAY" : DAY_LABELS[d.getDay()].toUpperCase();
          const hasRainEmoji = /🌦|🌧|⛈|🌨/.test(day.emoji);
          const showRain = day.rainPct >= 20 || hasRainEmoji;
          const color = tempColor(day.high);
          const bg = tempBg(day.high, isToday);
          return (
            <div
              key={day.date}
              style={{
                padding: "12px 4px 10px",
                textAlign: "center",
                borderRight: i < forecast.length - 1 ? "1px solid var(--sb-border-light)" : "none",
                background: bg,
                borderTop: isToday ? `3px solid ${color}` : "3px solid transparent",
              }}
            >
              <div style={{
                fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                letterSpacing: "0.08em",
                color: isToday ? color : "var(--sb-muted)",
                marginBottom: 6,
              }}>
                {label}
              </div>
              <div style={{ fontSize: 22, lineHeight: 1, marginBottom: 6 }}>{day.emoji}</div>
              <div style={{
                fontSize: isToday ? 42 : 32,
                fontWeight: 800,
                lineHeight: 1,
                color,
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "-0.02em",
                marginBottom: 3,
              }}>
                {day.high}°
              </div>
              <div style={{
                fontSize: 11, color: "var(--sb-muted)",
                fontVariantNumeric: "tabular-nums",
              }}>
                {day.low}°
              </div>
              {showRain && (
                <div style={{
                  fontSize: 9, color: "#0284C7", fontWeight: 700,
                  marginTop: 4, fontVariantNumeric: "tabular-nums",
                  fontFamily: "'Space Mono', monospace",
                }}>
                  💧{day.rainPct}%
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── NWS Weather Alert Banner ──────────────────────────────────────────────────

interface NwsAlertProps {
  event: string;
  headline: string;
  severity: string;
  expires: string;
}

function alertStyle(severity: string, event: string) {
  if (severity === "Extreme" || event.toLowerCase().includes("warning")) {
    return { bg: "#FEF2F2", border: "#FECACA", color: "#DC2626", dot: "#DC2626" };
  }
  if (severity === "Severe" || event.toLowerCase().includes("watch")) {
    return { bg: "#FFFBEB", border: "#FDE68A", color: "#B45309", dot: "#F59E0B" };
  }
  // Advisory / Statement
  return { bg: "#EFF6FF", border: "#BFDBFE", color: "#1D4ED8", dot: "#3B82F6" };
}

function WeatherAlertBanner() {
  const [alerts, setAlerts] = useState<NwsAlertProps[]>([]);

  useEffect(() => {
    // Santa Clara Valley (inland) zone covers San Jose, Mountain View, Sunnyvale, Cupertino, etc.
    fetch("https://api.weather.gov/alerts/active?zone=CAZ511", {
      headers: { "User-Agent": "SouthBaySignal/1.0 (southbaysignal.org)" },
    })
      .then((r) => r.json())
      .then((data) => {
        const now = new Date();
        const active: NwsAlertProps[] = (data.features ?? [])
          .filter((f: { properties: { expires: string } }) => new Date(f.properties.expires) > now)
          .map((f: { properties: NwsAlertProps }) => ({
            event: f.properties.event,
            headline: f.properties.headline,
            severity: f.properties.severity,
            expires: f.properties.expires,
          }));
        setAlerts(active);
      })
      .catch(() => {/* silent fail — show nothing if NWS unreachable */});
  }, []);

  if (alerts.length === 0) return null;

  return (
    <div style={{ marginBottom: 16, borderRadius: 8, overflow: "hidden" }}>
      {alerts.slice(0, 3).map((alert, i) => {
        const s = alertStyle(alert.severity, alert.event);
        const exp = new Date(alert.expires);
        const expStr = exp.toLocaleDateString("en-US", {
          weekday: "short", month: "short", day: "numeric",
          hour: "numeric", timeZone: "America/Los_Angeles",
        });
        // Strip the boilerplate preamble from headlines (e.g. "Heat Advisory issued ...")
        const shortHeadline = alert.headline
          .replace(/^[A-Za-z\s]+issued[^\.]+\.\s*/i, "")
          .replace(/^[A-Za-z\s]+in effect[^\.]+\.\s*/i, "")
          .slice(0, 150);
        const isFirst = i === 0;
        const isLast = i === alerts.length - 1;
        const borderRadiusVal = isFirst && isLast ? 8
          : isFirst ? "8px 8px 0 0"
          : isLast ? "0 0 8px 8px" : 0;
        return (
          <div
            key={i}
            style={{
              display: "flex", alignItems: "flex-start", gap: 10,
              padding: "10px 14px",
              background: s.bg,
              border: `1px solid ${s.border}`,
              borderTop: i > 0 ? "none" : undefined,
              borderRadius: borderRadiusVal,
            }}
          >
            <span style={{ color: s.dot, fontSize: 15, lineHeight: 1.3, flexShrink: 0, marginTop: 1 }}>⚠</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 2 }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
                  textTransform: "uppercase", fontFamily: "'Space Mono', monospace",
                  color: s.color,
                }}>
                  {alert.event}
                </span>
                <span style={{ fontSize: 10, color: s.color, opacity: 0.75 }}>
                  · until {expStr}
                </span>
              </div>
              {shortHeadline && (
                <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.45 }}>
                  {shortHeadline}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Around the South Bay ─────────────────────────────────────────────────────

interface AroundTownItem {
  id: string;
  cityId: string;
  cityName: string;
  date: string;
  headline: string;
  summary: string;
  sourceUrl: string;
}

const CITY_ACCENT: Record<string, string> = {
  "campbell":      "#1d4ed8",
  "saratoga":      "#065F46",
  "los-altos":     "#7c3aed",
  "los-gatos":     "#b45309",
  "san-jose":      "#be123c",
  "mountain-view": "#0369a1",
  "sunnyvale":     "#0891b2",
  "cupertino":     "#6d28d9",
  "santa-clara":   "#b45309",
  "milpitas":      "#4d7c0f",
  "palo-alto":     "#1d4ed8",
};

// ── Photo utilities ───────────────────────────────────────────────────────────

type CuratedPhoto = {
  id: string; thumb: string; full: string;
  title: string; photographer: string; photoPage: string;
  license: string; source: string;
};

const ALL_PHOTOS = (curatedPhotosJson as { photos: CuratedPhoto[] }).photos;

/** Seeded shuffle — deterministic per day so strip changes daily */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    s = (s ^ (s >>> 14)) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const DATE_SEED = parseInt(TODAY_ISO.replace(/-/g, ""), 10);
const DAILY_PHOTOS = seededShuffle(ALL_PHOTOS, DATE_SEED);

function getPhoto(index: number): CuratedPhoto | null {
  if (!ALL_PHOTOS.length) return null;
  return DAILY_PHOTOS[index % DAILY_PHOTOS.length];
}

// City-matched photo lookup — keywords found in photo titles/photographer credits
const CITY_KEYWORDS: Record<string, string[]> = {
  "cupertino":     ["cupertino", "apple park", "apple hq"],
  "mountain-view": ["mountain view", "shoreline amphitheatre", "shoreline lake", "moffett"],
  "san-jose":      ["san jose", "san josé", "sap center", "earthquakes", "mineta", "downtown sj"],
  "santa-clara":   ["santa clara", "levi", "49ers", "great america"],
  "sunnyvale":     ["sunnyvale"],
  "campbell":      ["campbell"],
  "los-gatos":     ["los gatos", "vasona"],
  "los-altos":     ["los altos", "hidden villa"],
  "palo-alto":     ["palo alto", "stanford"],
  "saratoga":      ["saratoga"],
  "milpitas":      ["milpitas"],
};

const WILDLIFE_KEYWORDS = [
  "egret", "heron", "hawk", "eagle", "pelican", "duck", "goose", "owl",
  "falcon", "osprey", "cormorant", "kingfisher", "sandpiper", "plover",
  "bird", "wildlife", "deer", "coyote", "fox", "squirrel", "butterfly",
  "dragonfly", "fish", "otter", "seal", "nature", "animal",
];

const { CITY_PHOTO_MAP, WILDLIFE_PHOTOS } = (() => {
  const map: Record<string, CuratedPhoto[]> = {};
  const wildlife: CuratedPhoto[] = [];
  for (const photo of ALL_PHOTOS) {
    const haystack = (photo.title + " " + (photo.photographer ?? "")).toLowerCase();
    let assignedCity = false;
    for (const [city, keywords] of Object.entries(CITY_KEYWORDS)) {
      if (keywords.some(kw => haystack.includes(kw))) {
        (map[city] ??= []).push(photo);
        assignedCity = true;
        break;
      }
    }
    if (!assignedCity && WILDLIFE_KEYWORDS.some(kw => haystack.includes(kw))) {
      wildlife.push(photo);
    }
  }
  return { CITY_PHOTO_MAP: map, WILDLIFE_PHOTOS: wildlife };
})();

function getCityPhoto(cityId: string, offset: number): CuratedPhoto | null {
  const pool = CITY_PHOTO_MAP[cityId];
  if (pool?.length) return pool[offset % pool.length];
  // Fallback: wildlife beats blank
  if (WILDLIFE_PHOTOS.length) return WILDLIFE_PHOTOS[offset % WILDLIFE_PHOTOS.length];
  return null;
}

// ── Photo strip (auto-scrolling marquee) ─────────────────────────────────────

function PhotoStrip() {
  if (ALL_PHOTOS.length < 4) return null;
  // Shuffle per page load so the strip is always different
  const LOAD_SEED = Math.floor(Math.random() * 1_000_000);
  const strip = seededShuffle(ALL_PHOTOS, LOAD_SEED).slice(0, Math.min(20, ALL_PHOTOS.length));

  const tile = (p: CuratedPhoto, keySuffix: string) => (
    <a
      key={p.id + keySuffix}
      href={p.photoPage}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${p.title} — ${p.photographer} — ${p.license}`}
      style={{
        flexShrink: 0, display: "block", position: "relative",
        height: 200, width: 280, overflow: "hidden", background: "#ccc",
      }}
    >
      <img
        src={p.thumb}
        alt={p.title}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        onError={(e) => { (e.currentTarget.closest("a") as HTMLElement).style.display = "none"; }}
      />
      {/* attribution on hover via CSS sibling — use class */}
      <div className="ps-caption">
        <span style={{ fontSize: 9, color: "#fff", fontFamily: "'Space Mono', monospace", lineHeight: 1.5 }}>
          {p.photographer ? `${p.photographer} · ` : ""}{p.license}
        </span>
      </div>
    </a>
  );

  return (
    <div style={{ marginBottom: 32, marginLeft: -16, marginRight: -16, overflow: "hidden" }}>
      <div className="photo-strip-track">
        {/* original + duplicate for seamless loop */}
        {strip.map(p => tile(p, "-a"))}
        {strip.map(p => tile(p, "-b"))}
      </div>
    </div>
  );
}

// ── Around Town ───────────────────────────────────────────────────────────────

function AroundTownSection() {
  const items = (aroundTownJson as { items: AroundTownItem[] }).items;
  if (!items?.length) return null;

  return (
    <div style={{ marginBottom: 32 }}>
      <div className="sb-section-header" style={{ marginBottom: 14 }}>
        <span className="sb-section-title">Around the South Bay</span>
        <span style={{ fontSize: 11, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace" }}>
          from public records
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {items.map((item, i) => {
          const accent = CITY_ACCENT[item.cityId] ?? "var(--sb-primary)";
          const dateFormatted = new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
            month: "short", day: "numeric",
          });
          const photo = getCityPhoto(item.cityId, i + (DATE_SEED % 97));
          return (
            <div key={item.id} style={{
              padding: "14px 0",
              borderBottom: i < items.length - 1 ? "1px solid var(--sb-border-light)" : "none",
              display: "flex", gap: 12, alignItems: "flex-start",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 3,
                    background: accent + "18", color: accent,
                    letterSpacing: "0.04em",
                  }}>
                    {item.cityName.toUpperCase()}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace" }}>
                    {dateFormatted}
                  </span>
                </div>
                <div style={{ fontFamily: "var(--sb-serif)", fontWeight: 700, fontSize: 14, color: "var(--sb-ink)", lineHeight: 1.35, marginBottom: 4 }}>
                  {item.headline}
                </div>
                <div style={{ fontSize: 12, color: "var(--sb-muted)", lineHeight: 1.55 }}>
                  {item.summary}{" "}
                  <a
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: accent, textDecoration: "none", fontWeight: 600 }}
                  >
                    Source →
                  </a>
                </div>
              </div>
              {photo && (
                <a
                  href={photo.photoPage}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`${photo.photographer} · ${photo.license}`}
                  style={{ flexShrink: 0 }}
                >
                  <img
                    src={photo.thumb}
                    alt={photo.title}
                    width={72} height={72}
                    style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 3, border: "1px solid var(--sb-border-light)", display: "block" }}
                    onError={(e) => { (e.currentTarget.closest("a") as HTMLElement).style.display = "none"; }}
                  />
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── On Stage section ─────────────────────────────────────────────────────────
// Compact widget: upcoming shows at major South Bay entertainment venues

function OnStageSection({
  allUpcoming,
  onNavigate,
}: {
  allUpcoming: UpcomingEvent[];
  onNavigate: (tab: Tab) => void;
}) {
  const sevenDaysOut = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const shows = allUpcoming
    .filter(
      (e) =>
        e.source === "Ticketmaster" &&
        e.category !== "sports" &&
        !e.ongoing &&
        e.date >= TODAY_ISO &&
        e.date <= sevenDaysOut &&
        // filter out past events on today (already started)
        (e.date !== TODAY_ISO || hasNotStarted(e.time)),
    )
    .sort((a, b) => {
      const dateCmp = (a.date || "").localeCompare(b.date || "");
      if (dateCmp !== 0) return dateCmp;
      return (a.time || "99:99").localeCompare(b.time || "99:99");
    })
    .slice(0, 5);

  if (!shows.length) return null;

  const title = "On Stage";

  return (
    <div style={{ marginBottom: 32 }}>
      <div className="sb-section-header" style={{ marginBottom: 10 }}>
        <span className="sb-section-title">🎭 {title}</span>
        <span style={{ fontSize: 11, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace" }}>
          South Bay venues
        </span>
        <button
          onClick={() => onNavigate("events")}
          style={{
            marginLeft: "auto", background: "none", border: "none",
            fontSize: 12, color: "var(--sb-accent)", cursor: "pointer",
            padding: 0, fontFamily: "inherit", fontWeight: 600,
          }}
        >
          All shows →
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {shows.map((e, i) => {
          const isToday = e.date === TODAY_ISO;
          const shortDate = (e.displayDate ?? "").replace(/^[A-Za-z]+,\s*/, "");
          return (
            <div
              key={e.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: "10px 0",
                borderBottom:
                  i < shows.length - 1
                    ? "1px solid var(--sb-border-light)"
                    : "none",
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  fontFamily: "'Space Mono', monospace",
                  fontSize: 10,
                  fontWeight: 700,
                  color: isToday ? "#fff" : "var(--sb-muted)",
                  background: isToday ? "var(--sb-accent)" : "var(--sb-primary-light)",
                  padding: "3px 7px",
                  borderRadius: 4,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  minWidth: 50,
                  textAlign: "center",
                  lineHeight: 1.5,
                }}
              >
                {shortDate}
              </span>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: "var(--sb-serif)",
                    fontWeight: 700,
                    fontSize: 13,
                    color: "var(--sb-ink)",
                    lineHeight: 1.3,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginBottom: 2,
                  }}
                >
                  {e.url ? (
                    <a
                      href={e.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "inherit", textDecoration: "none" }}
                      onMouseEnter={(el) =>
                        (el.currentTarget.style.textDecoration = "underline")
                      }
                      onMouseLeave={(el) =>
                        (el.currentTarget.style.textDecoration = "none")
                      }
                    >
                      {e.title}
                    </a>
                  ) : (
                    e.title
                  )}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--sb-muted)",
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <span>{e.venue}</span>
                  {e.time && (
                    <>
                      <span style={{ color: "var(--sb-border)" }}>·</span>
                      <span>{e.time}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── School Calendar card ──────────────────────────────────────────────────────

type SchoolCalEvent = {
  id: string;
  districtId: string;
  label: string;
  type: string;
  startDate: string;
  endDate: string;
};

type SchoolDistrict = {
  id: string;
  name: string;
  fullName: string;
  color: string;
  bg: string;
};

const TYPE_ICON: Record<string, string> = {
  break: "🏖️",
  holiday: "🗓️",
  graduation: "🎓",
  lastday: "🔔",
  testing: "📝",
  finals: "📋",
};

function SchoolCalendarCard() {
  const now = new Date();
  const todayIso = now.toISOString().split("T")[0];
  const ninetyDaysOut = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const districts = (schoolCalJson as { districts: SchoolDistrict[] }).districts;
  const allEvents = (schoolCalJson as { events: SchoolCalEvent[] }).events;
  const districtMap = Object.fromEntries(districts.map((d) => [d.id, d]));

  // Filter to upcoming events within 90 days
  const upcoming = allEvents
    .filter((e) => e.endDate >= todayIso && e.startDate <= ninetyDaysOut)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  if (!upcoming.length) return null;

  // Group events that share the same label + type + date range (e.g. Memorial Day across districts)
  type GroupedEntry = {
    key: string;
    label: string;
    type: string;
    startDate: string;
    endDate: string;
    districtIds: string[];
  };

  const grouped: GroupedEntry[] = [];
  for (const e of upcoming) {
    const key = `${e.label}|${e.startDate}|${e.endDate}`;
    const existing = grouped.find((g) => g.key === key);
    if (existing) {
      existing.districtIds.push(e.districtId);
    } else {
      grouped.push({ key, label: e.label, type: e.type, startDate: e.startDate, endDate: e.endDate, districtIds: [e.districtId] });
    }
  }

  function formatDateRange(start: string, end: string): string {
    const s = new Date(start + "T12:00:00");
    const e = new Date(end + "T12:00:00");
    const sStr = s.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (start === end) return sStr;
    const sameMonth = s.getMonth() === e.getMonth();
    const eStr = sameMonth
      ? e.toLocaleDateString("en-US", { day: "numeric" })
      : e.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${sStr}–${eStr}`;
  }

  function countdown(startDate: string, endDate: string): string | null {
    const s = new Date(startDate + "T00:00:00");
    const e = new Date(endDate + "T00:00:00");
    const today = new Date(todayIso + "T00:00:00");
    if (today > e) return null;
    if (today >= s) return "this week";
    const days = Math.round((s.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (days === 1) return "tomorrow";
    return `in ${days} days`;
  }

  const nextBreak = grouped.find((g) => g.type === "break");
  const countdown1 = nextBreak ? countdown(nextBreak.startDate, nextBreak.endDate) : null;

  return (
    <div style={{ marginBottom: 32 }}>
      <div className="sb-section-header" style={{ marginBottom: 12 }}>
        <span className="sb-section-title">School Calendars</span>
        <span style={{ fontSize: 11, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace" }}>
          {countdown1 && nextBreak ? `spring break ${countdown1}` : "2025–26"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 0, maxHeight: 220, overflowY: "auto", overflowX: "hidden" }}>
        {grouped.map((entry, i) => {
          const dateStr = formatDateRange(entry.startDate, entry.endDate);
          const icon = TYPE_ICON[entry.type] ?? "📅";
          const isOngoing = entry.startDate <= todayIso && entry.endDate >= todayIso;

          return (
            <div
              key={entry.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 0",
                borderBottom: i < grouped.length - 1 ? "1px solid var(--sb-border-light)" : "none",
              }}
            >
              {/* Icon */}
              <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>{icon}</span>

              {/* Date + label */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
                  <span style={{
                    fontSize: 11,
                    fontFamily: "'Space Mono', monospace",
                    color: isOngoing ? "var(--sb-accent)" : "var(--sb-muted)",
                    fontWeight: isOngoing ? 700 : 400,
                  }}>
                    {isOngoing ? "NOW · " : ""}{dateStr}
                  </span>
                  {entry.districtIds.map((did) => {
                    const d = districtMap[did];
                    if (!d) return null;
                    return (
                      <span
                        key={did}
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          padding: "1px 5px",
                          borderRadius: 3,
                          background: d.bg,
                          color: d.color,
                          letterSpacing: "0.05em",
                        }}
                      >
                        {d.name}
                      </span>
                    );
                  })}
                </div>
                <div style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--sb-ink)",
                  lineHeight: 1.3,
                }}>
                  {entry.label}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 8, fontSize: 11, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace" }}>
        SJUSD · PAUSD · FUHSD · MVWSD · Cupertino USD · Campbell USD · LGSUHSD · MVLA — 2025–26
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
  showBucketLabels = true,
): React.ReactNode {
  const buckets: Record<TimeBucket, AnyEvent[]> = { now: [], morning: [], afternoon: [], evening: [], none: [] };

  for (const e of statics) buckets[timeBucket(e.time)].push({ _type: "static", event: e });
  for (const e of upcoming) {
    if (e.category === "sports") continue; // sports shown in callout
    buckets[timeBucket(e.time)].push({ _type: "upcoming", event: e });
  }

  const hasMultipleBuckets =
    showBucketLabels && BUCKET_ORDER.filter((b) => buckets[b].length > 0).length > 1;

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
  const [forecast, setForecast] = useState<ForecastDay[] | null>(null);
  const [changingCity, setChangingCity] = useState(false);
  const [showAllSouthBay, setShowAllSouthBay] = useState(false);

  useEffect(() => {
    const cityParam = homeCity ? `?city=${homeCity}` : "";
    fetch(`/api/weather${cityParam}`)
      .then((r) => r.json())
      .then((d) => {
        setWeather(d.weather ?? null);
        setForecast(d.forecast ?? null);
      })
      .catch(() => {});
  }, [homeCity]);

  // ── Upcoming scraped events for today ──
  // Collapse multiple "Library Closed" notices from the same source/date into one entry
  const rawUpcoming = (upcomingJson as { events: UpcomingEvent[] }).events ?? [];
  const allUpcoming = (() => {
    const closurePattern = /\bClosed\b/i;
    const byDateSource = new Map<string, UpcomingEvent[]>();
    const nonClosure: UpcomingEvent[] = [];
    for (const e of rawUpcoming) {
      if (closurePattern.test(e.title) && e.source) {
        const key = `${e.date}::${e.source}`;
        if (!byDateSource.has(key)) byDateSource.set(key, []);
        byDateSource.get(key)!.push(e);
      } else {
        nonClosure.push(e);
      }
    }
    const collapsed: UpcomingEvent[] = [];
    for (const [, group] of byDateSource) {
      if (group.length >= 2) {
        const rep = group[0];
        collapsed.push({
          ...rep,
          id: `${rep.source.replace(/\s+/g, "-").toLowerCase()}-all-closed-${rep.date}`,
          title: `All ${rep.source} Locations Closed`,
          city: "multi",
          time: null,
          endTime: null,
        });
      } else {
        collapsed.push(...group);
      }
    }
    return [...nonClosure, ...collapsed].sort((a, b) => a.date.localeCompare(b.date));
  })();
  const todayUpcoming = allUpcoming.filter((e) => e.date === TODAY_ISO && !e.ongoing);

  // Sports events today — pulled out for hero callout (only upcoming, not started)
  const todaySportsEvents = todayUpcoming
    .filter((e) => e.category === "sports" && startMinutes(e.time) > NOW_MINUTES)
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
        .filter((e) => hasNotStarted(e.time))
        .sort((a, b) => startMinutes(a.time) - startMinutes(b.time))
    : [];

  const cityTodayCount = cityTodayStatic.length + cityTodayUpcoming.length;

  // ── Today: south bay-wide (excluding home city) ──
  const southBayTodayStatic = SOUTH_BAY_EVENTS
    .filter((e) => isActiveToday(e) && (homeCity ? e.city !== homeCity : true))
    .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));

  const southBayTodayUpcoming = todayUpcoming
    .filter((e) => (homeCity ? e.city !== homeCity : true))
    .filter((e) => hasNotStarted(e.time))
    .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));

  const southBayCount = southBayTodayStatic.length + southBayTodayUpcoming.length;

  // ── Ongoing events active today (multi-day exhibits, festivals, open houses) ──
  // These have e.ongoing === true and started on or before today
  const ongoingToday = allUpcoming
    .filter((e) => e.ongoing === true && e.date <= TODAY_ISO && e.category !== "sports")
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 6);

  const cityIsEmpty = homeCity && cityTodayCount < 5;
  const showExpandedRegional = cityIsEmpty;
  const SB_LIMIT = homeCity ? 6 : 8;

  // ── This Week: home city events for next 6 days ──
  // Shown when homeCity is set, grouped by day
  const thisWeekByDay = homeCity
    ? NEXT_DAYS.map(({ iso, label }) => {
        const events = allUpcoming
          .filter((e) => e.date === iso && !e.ongoing && e.city === homeCity && e.category !== "sports")
          .sort((a, b) => startMinutes(a.time) - startMinutes(b.time))
          .slice(0, 4);
        return { iso, label, events };
      }).filter(({ events }) => events.length > 0)
    : [];

  // ── Tomorrow's events for weekend mode ──────────────────────────────────────
  // Only populated when tomorrow is a weekend day (Fri→Sat, Sat→Sun; not Sun→Mon)
  const cityTomorrowStatic = homeCity
    ? SOUTH_BAY_EVENTS
        .filter(e => isActiveTomorrow(e) && e.city === homeCity && e.category !== "sports")
        .sort((a, b) => startMinutes(a.time) - startMinutes(b.time))
    : [];
  const cityTomorrowUpcoming = homeCity
    ? allUpcoming
        .filter(e => e.date === TOMORROW_ISO_STR && e.city === homeCity && e.category !== "sports")
        .sort((a, b) => startMinutes(a.time) - startMinutes(b.time))
    : [];
  const cityTomorrowCount = cityTomorrowStatic.length + cityTomorrowUpcoming.length;

  const southBayTomorrowStatic = SOUTH_BAY_EVENTS
    .filter(e => isActiveTomorrow(e) && (homeCity ? e.city !== homeCity : true) && e.category !== "sports")
    .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));
  const southBayTomorrowUpcoming = allUpcoming
    .filter(e => e.date === TOMORROW_ISO_STR && (homeCity ? e.city !== homeCity : true) && e.category !== "sports")
    .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));
  const southBayTomorrowCount = southBayTomorrowStatic.length + southBayTomorrowUpcoming.length;

  // When today has nothing, look ahead to tomorrow instead of showing an empty state
  const showingTomorrow = cityTodayCount === 0 && southBayCount === 0 && (cityTomorrowCount > 0 || southBayTomorrowCount > 0);

  // ── Today section title ──
  const todaySectionTitle = showingTomorrow
    ? homeCity
      ? (showExpandedRegional ? "Tomorrow in the South Bay" : `Tomorrow in ${getCityName(homeCity)}`)
      : "Tomorrow in the South Bay"
    : homeCity
    ? IS_WEEKEND_MODE
      ? (showExpandedRegional ? "This Weekend in the South Bay" : `This Weekend in ${getCityName(homeCity)}`)
      : (showExpandedRegional ? "Today in the South Bay" : `Today in ${getCityName(homeCity)}`)
    : IS_WEEKEND_MODE ? "This Weekend" : "Happening Today";

  const hasTomorrowEvents = cityTomorrowCount > 0 || southBayTomorrowCount > 0;
  const showTodaySubHeader = IS_WEEKEND_MODE && hasTomorrowEvents;

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

      {/* ── Power outage alert (only shown when active outages exist) ── */}
      <OutagesCard />

      {/* ── Weather strip ── */}
      {weather && (
        <div style={{ background: "var(--sb-primary-light)", border: "1px solid var(--sb-border-light)", borderRadius: "var(--sb-radius)", padding: "10px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, color: "var(--sb-ink)", fontWeight: 500 }}>{weather}</span>
          <span style={{ fontSize: 11, color: "var(--sb-muted)", letterSpacing: "0.04em" }}>
            · {homeCity ? getCityName(homeCity) : "South Bay"}, CA
          </span>
          {homeCity && (
            <button
              onClick={() => setChangingCity(true)}
              style={{ marginLeft: "auto", background: "none", border: "none", fontSize: 11, color: "var(--sb-muted)", cursor: "pointer", padding: 0, textDecoration: "underline", textUnderlineOffset: 3 }}
            >
              Change city
            </button>
          )}
        </div>
      )}

      {/* ── 5-day forecast ── */}
      {forecast && forecast.length > 0 && !changingCity && (
        <ForecastStrip forecast={forecast} />
      )}

      {/* ── Photo strip — right at the top so it's seen immediately ── */}
      {!changingCity && <PhotoStrip />}

      {/* ── NWS weather alerts (live, shows only when active) ── */}
      {!changingCity && <WeatherAlertBanner />}

      {/* ── Today in [City] / This Weekend in [City] ── */}
      {!changingCity && (homeCity || !homeCity) && (
        <div style={{ marginBottom: 32 }}>
          <div className="sb-section-header" style={{ marginBottom: 12 }}>
            <span className="sb-section-title">
              {(IS_WEEKEND_MODE || showingTomorrow) ? "🌅 " : ""}{todaySectionTitle}
            </span>
            {homeCity && cityTodayCount > 0 && !showExpandedRegional && !IS_WEEKEND_MODE && (
              <span style={{ fontSize: 12, fontWeight: 500, color: "var(--sb-muted)" }}>
                {cityTodayCount} {cityTodayCount === 1 ? "event" : "events"}
              </span>
            )}
          </div>

          {homeCity ? (
            showExpandedRegional ? (
              <>
                {cityTodayCount === 0 && southBayCount === 0 && cityTomorrowCount === 0 && southBayTomorrowCount === 0 ? (
                  <div style={{ padding: "16px 0", color: "var(--sb-muted)", fontSize: 13, fontStyle: "italic" }}>
                    Nothing on the calendar today ({WEEKDAY}). Check the Events tab for upcoming events.
                  </div>
                ) : showingTomorrow ? (
                  <>
                    {bucketEvents(cityTomorrowStatic, cityTomorrowUpcoming, false, true, false)}
                    {bucketEvents(
                      southBayTomorrowStatic.slice(0, SB_LIMIT),
                      southBayTomorrowUpcoming.slice(0, SB_LIMIT),
                      true, false, false,
                    )}
                  </>
                ) : (
                  <>
                    {showTodaySubHeader && (cityTodayCount > 0 || southBayCount > 0) && (
                      <div style={{
                        fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                        letterSpacing: "0.08em", textTransform: "uppercase",
                        color: "var(--sb-accent)", paddingTop: 4, paddingBottom: 2,
                        borderBottom: "1px solid var(--sb-border-light)", marginBottom: 0,
                      }}>
                        Today · {WEEKDAY}
                      </div>
                    )}
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
                    {IS_WEEKEND_MODE && (cityTomorrowCount > 0 || southBayTomorrowCount > 0) && (
                      <>
                        <div style={{
                          fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                          letterSpacing: "0.08em", textTransform: "uppercase",
                          color: "var(--sb-muted)", paddingTop: 12, paddingBottom: 2,
                          borderBottom: "1px solid var(--sb-border-light)", marginBottom: 0,
                        }}>
                          {TOMORROW_LABEL_STR}
                        </div>
                        {bucketEvents(cityTomorrowStatic, cityTomorrowUpcoming, false, true, false)}
                        {bucketEvents(
                          southBayTomorrowStatic.slice(0, SB_LIMIT),
                          southBayTomorrowUpcoming.slice(0, SB_LIMIT),
                          true, false, false,
                        )}
                      </>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                {cityTodayCount === 0 && cityTomorrowCount === 0 && southBayTomorrowCount === 0 ? (
                  <div style={{ padding: "16px 0", color: "var(--sb-muted)", fontSize: 13, fontStyle: "italic" }}>
                    Nothing scheduled in {getCityName(homeCity)} today ({WEEKDAY}). Check the Events tab for upcoming events.
                  </div>
                ) : showingTomorrow ? (
                  <>
                    {bucketEvents(cityTomorrowStatic, cityTomorrowUpcoming, false, false, false)}
                  </>
                ) : (
                  <>
                    {showTodaySubHeader && cityTodayCount > 0 && (
                      <div style={{
                        fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                        letterSpacing: "0.08em", textTransform: "uppercase",
                        color: "var(--sb-accent)", paddingTop: 4, paddingBottom: 2,
                        borderBottom: "1px solid var(--sb-border-light)", marginBottom: 0,
                      }}>
                        Today · {WEEKDAY}
                      </div>
                    )}
                    {bucketEvents(cityTodayStatic, cityTodayUpcoming, false)}
                    {cityTodayCount > 10 && (
                      <div style={{ paddingTop: 10, fontSize: 12, color: "var(--sb-muted)" }}>
                        See Events tab for all {getCityName(homeCity)} events.
                      </div>
                    )}
                    {IS_WEEKEND_MODE && cityTomorrowCount > 0 && (
                      <>
                        <div style={{
                          fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                          letterSpacing: "0.08em", textTransform: "uppercase",
                          color: "var(--sb-muted)", paddingTop: 12, paddingBottom: 2,
                          borderBottom: "1px solid var(--sb-border-light)", marginBottom: 0,
                        }}>
                          {TOMORROW_LABEL_STR}
                        </div>
                        {bucketEvents(cityTomorrowStatic, cityTomorrowUpcoming, false, false, false)}
                      </>
                    )}
                  </>
                )}
              </>
            )
          ) : (
            /* No home city — show south bay wide */
            <>
              {southBayCount === 0 && southBayTomorrowCount === 0 ? (
                <div style={{ padding: "20px 0", color: "var(--sb-muted)", fontSize: 14, fontStyle: "italic" }}>
                  {`No recurring events on ${WEEKDAY}s this time of year.`}
                </div>
              ) : showingTomorrow ? (
                <>
                  {bucketEvents(
                    southBayTomorrowStatic.slice(0, SB_LIMIT),
                    southBayTomorrowUpcoming.slice(0, SB_LIMIT),
                    true, false, false,
                  )}
                </>
              ) : (
                <>
                  {showTodaySubHeader && southBayCount > 0 && (
                    <div style={{
                      fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                      letterSpacing: "0.08em", textTransform: "uppercase",
                      color: "var(--sb-accent)", paddingTop: 4, paddingBottom: 2,
                      borderBottom: "1px solid var(--sb-border-light)", marginBottom: 0,
                    }}>
                      Today · {WEEKDAY}
                    </div>
                  )}
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
                  {IS_WEEKEND_MODE && southBayTomorrowCount > 0 && (
                    <>
                      <div style={{
                        fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                        letterSpacing: "0.08em", textTransform: "uppercase",
                        color: "var(--sb-muted)", paddingTop: 12, paddingBottom: 2,
                        borderBottom: "1px solid var(--sb-border-light)", marginBottom: 0,
                      }}>
                        {TOMORROW_LABEL_STR}
                      </div>
                      {bucketEvents(
                        southBayTomorrowStatic.slice(0, SB_LIMIT),
                        southBayTomorrowUpcoming.slice(0, SB_LIMIT),
                        true, false, false,
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Ongoing events (multi-day exhibits, festivals, open houses) ── */}
      {ongoingToday.length > 0 && !changingCity && (
        <div style={{ marginBottom: 28 }}>
          <div className="sb-section-header" style={{ marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace" }}>
              Also this week
            </span>
            <div className="sb-section-line" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "0 32px" }} className="sb-today-grid">
            {ongoingToday.map((e) => (
              <UpcomingRow key={e.id} event={e} showCity={true} />
            ))}
          </div>
        </div>
      )}

      {/* ── Sports callout ── */}
      {todaySportsEvents.length > 0 && (
        <SportsCallout events={todaySportsEvents} />
      )}

      {/* ── Our Picks (weekends only) ── */}
      {IS_WEEKEND_MODE && !changingCity && <WeekendPicksCard />}

      {/* ── On Stage this week (Ticketmaster) ── */}
      {!changingCity && <OnStageSection allUpcoming={allUpcoming} onNavigate={onNavigate} />}

      {/* ── This Week in [City] briefing ── */}
      {homeCity && !changingCity && <CityWeeklyBriefing city={homeCity} />}

      {/* ── Around the South Bay ── */}
      {!changingCity && <AroundTownSection />}

      {/* ── School Calendars ── */}
      {!changingCity && <SchoolCalendarCard />}

      {/* ── Spring Break Guide (shown Mar 28 – Apr 17) ── */}
      {!changingCity && <SpringBreakCard />}

      {/* ── Housing Market ── */}
      {!changingCity && <RealEstateCard homeCity={homeCity} />}

      {/* ── Sports scoreboard ── */}
      <SportsView />
    </>
  );
}
