import { useState, useEffect } from "react";
import SportsView from "./SportsView";
import {
  SOUTH_BAY_EVENTS,
  type SBEvent,
  type DayOfWeek,
} from "../../../data/south-bay/events-data";
import { DEV_PROJECTS, STATUS_CONFIG } from "../../../data/south-bay/development-data";
import { CITIES, getCityName } from "../../../lib/south-bay/cities";
import type { City, Tab } from "../../../lib/south-bay/types";
import upcomingJson from "../../../data/south-bay/upcoming-events.json";
import digestsJson from "../../../data/south-bay/digests.json";
import blotterJson from "../../../data/south-bay/blotter.json";
import aroundTownJson from "../../../data/south-bay/around-town.json";

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
const _tmrow = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 1);
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
  if (e.months && !e.months.includes(MONTH)) return false;
  if (!e.days) return e.recurrence !== "seasonal";
  if (!e.days.includes(DAY_NAME as DayOfWeek)) return false;
  return hasNotStarted(e.time);
}

function isActiveTomorrow(e: SBEvent): boolean {
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
                {event.title}
              </a>
            ) : event.title}
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

// ── Blotter type (matches blotter.json) ──────────────────────────────────────

interface BlotterEntry {
  date: string;
  time: string;
  type: string;
  location: string;
  priority?: number | string;
}

interface CityBlotter {
  city: string;
  cityName: string;
  entries: BlotterEntry[];
  source: string;
  sourceUrl: string;
  generatedAt?: string;
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

function pickTopEvent(
  todayUpcoming: UpcomingEvent[],
  todayStatic: SBEvent[],
): BriefingStory | null {
  // Prefer: free + specific venue > free > any today event
  const VENUE_PRIORITY = [
    "stanford", "sjsu", "san jose state", "computer history",
    "tech interactive", "children's discovery", "cantor",
    "bing concert", "hammer theatre", "montalvo",
  ];
  const scorable = [...todayUpcoming]
    .filter((e) => e.category !== "sports")
    .map((e) => {
      let score = 0;
      if (e.cost === "free") score += 30;
      if (e.time) score += 10;
      if (e.url) score += 5;
      const vl = (e.venue ?? "").toLowerCase();
      const tl = (e.title ?? "").toLowerCase();
      for (const kw of VENUE_PRIORITY) {
        if (vl.includes(kw) || tl.includes(kw)) { score += 20; break; }
      }
      return { e, score };
    })
    .sort((a, b) => b.score - a.score);

  const top = scorable[0];
  if (!top) {
    // Fallback to static recurring events
    const se = todayStatic.find((e) => e.category !== "sports");
    if (!se) return null;
    return {
      category: "Events",
      headline: se.title,
      lede: se.description?.slice(0, 120) ?? `${se.recurrence === "ongoing" ? "Always open" : "Happening today"} · ${se.venue}`,
      tab: "events",
      emoji: CATEGORY_EMOJI[se.category] ?? "📅",
      accentColor: "#16a34a",
      url: se.url,
    };
  }

  const e = top.e;
  const costLabel = e.cost === "free" ? "Free · " : e.cost === "low" ? "Low cost · " : "";
  const timeLabel = e.time ? `${formatTimeRange(e.time, e.endTime, e.category === "sports")} · ` : "";
  const ledeBase = `${costLabel}${timeLabel}${e.venue ?? e.city}`.replace(/^· /, "").trim();
  const lede = ledeBase || (e.description?.slice(0, 100) ?? "");

  return {
    category: "Events",
    headline: e.title,
    lede,
    tab: "events",
    emoji: CATEGORY_EMOJI[e.category] ?? "📅",
    accentColor: "#16a34a",
    url: e.url ?? undefined,
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
  const lede = `${statusLabel} · ${p.city}${p.scale ? ` · ${p.scale}` : ""}${p.timeline ? ` · ${p.timeline}` : ""}`;
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
    pickTopEvent(todayUpcoming, todayStatic),
    pickCityHallStory(homeCity, digests),
    pickDevelopmentStory(),
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
              {story.url ? "Read more" : `Go to ${story.category} →`}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Blotter strip ─────────────────────────────────────────────────────────────

const BLOTTER_PRIORITY_LABELS: Record<number, { label: string; bg: string; color: string }> = {
  1: { label: "Priority 1", bg: "#FEF2F2", color: "#991B1B" },
  2: { label: "Priority 2", bg: "#FFF7ED", color: "#92400E" },
  3: { label: "Priority 3", bg: "#FEF9C3", color: "#854D0E" },
};

function BlotterStrip({
  homeCity,
  onNavigate,
}: {
  homeCity: City | null;
  onNavigate: (tab: Tab) => void;
}) {
  const blotters = blotterJson as Record<string, CityBlotter>;
  const city = homeCity;
  if (!city) return null;
  const blotter = blotters[city];
  if (!blotter || !blotter.entries?.length) return null;

  // Show most recent 5 entries
  const entries = blotter.entries.slice(0, 5);

  const callDate = entries[0]?.date ?? "";

  return (
    <div style={{ marginBottom: 32 }}>
      <div className="sb-section-header" style={{ marginBottom: 10 }}>
        <span className="sb-section-title" style={{ fontSize: 13 }}>
          🚨 Police Blotter
        </span>
        <span style={{ fontSize: 11, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace" }}>
          {callDate} · {getCityName(city)}
        </span>
        <a
          href={blotter.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ marginLeft: "auto", fontSize: 11, color: "var(--sb-accent)", textDecoration: "none" }}
        >
          {blotter.source} →
        </a>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {entries.map((entry, i) => {
          const pri = typeof entry.priority === "number" ? entry.priority : parseInt(entry.priority as string ?? "9", 10);
          const priStyle = BLOTTER_PRIORITY_LABELS[pri] ?? { label: "", bg: "#F3F4F6", color: "#374151" };
          return (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "8px 0",
              borderBottom: i < entries.length - 1 ? "1px solid var(--sb-border-light)" : "none",
            }}>
              <span style={{
                fontFamily: "'Space Mono', monospace", fontSize: 10,
                color: "var(--sb-muted)", flexShrink: 0, minWidth: 38,
              }}>
                {entry.time}
              </span>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
                background: priStyle.bg, color: priStyle.color,
                whiteSpace: "nowrap", flexShrink: 0, letterSpacing: "0.02em",
                maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis",
              }}>
                {entry.type}
              </span>
              <span style={{
                fontSize: 11, color: "var(--sb-muted)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                fontFamily: "'Space Mono', monospace",
              }}>
                {entry.location}
              </span>
            </div>
          );
        })}
      </div>

      <button
        onClick={() => onNavigate("government")}
        style={{
          marginTop: 8, background: "none", border: "none", padding: 0,
          fontSize: 12, color: "var(--sb-muted)", cursor: "pointer",
          textDecoration: "underline", textUnderlineOffset: 3,
        }}
      >
        Full blotter in Gov tab →
      </button>
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
          return (
            <div key={item.id} style={{
              padding: "14px 0",
              borderBottom: i < items.length - 1 ? "1px solid var(--sb-border-light)" : "none",
            }}>
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
          );
        })}
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
    .filter((e) => isNotEnded(e.time))
    .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));

  const southBayCount = southBayTodayStatic.length + southBayTodayUpcoming.length;

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
  const cityTomorrowStatic = IS_WEEKEND_MODE && homeCity
    ? SOUTH_BAY_EVENTS
        .filter(e => isActiveTomorrow(e) && e.city === homeCity && e.category !== "sports")
        .sort((a, b) => startMinutes(a.time) - startMinutes(b.time))
    : [];
  const cityTomorrowUpcoming = IS_WEEKEND_MODE && homeCity
    ? allUpcoming
        .filter(e => e.date === TOMORROW_ISO_STR && e.city === homeCity && !e.ongoing && e.category !== "sports")
        .sort((a, b) => startMinutes(a.time) - startMinutes(b.time))
    : [];
  const cityTomorrowCount = cityTomorrowStatic.length + cityTomorrowUpcoming.length;

  const southBayTomorrowStatic = IS_WEEKEND_MODE
    ? SOUTH_BAY_EVENTS
        .filter(e => isActiveTomorrow(e) && (homeCity ? e.city !== homeCity : true) && e.category !== "sports")
        .sort((a, b) => startMinutes(a.time) - startMinutes(b.time))
    : [];
  const southBayTomorrowUpcoming = IS_WEEKEND_MODE
    ? allUpcoming
        .filter(e => e.date === TOMORROW_ISO_STR && (homeCity ? e.city !== homeCity : true) && !e.ongoing && e.category !== "sports")
        .sort((a, b) => startMinutes(a.time) - startMinutes(b.time))
    : [];
  const southBayTomorrowCount = southBayTomorrowStatic.length + southBayTomorrowUpcoming.length;

  // ── Today section title ──
  const todaySectionTitle = homeCity
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

      {/* ── Weather strip ── */}
      {weather && (
        <div style={{ background: "var(--sb-primary-light)", border: "1px solid var(--sb-border-light)", borderRadius: "var(--sb-radius)", padding: "10px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 14, color: "var(--sb-ink)", fontWeight: 500 }}>{weather}</span>
          <span style={{ fontSize: 11, color: "var(--sb-muted)", letterSpacing: "0.04em" }}>
            · {homeCity ? getCityName(homeCity) : "South Bay"}, CA
          </span>
        </div>
      )}

      {/* ── Today in [City] / This Weekend in [City] ── */}
      {!changingCity && (homeCity || !homeCity) && (
        <div style={{ marginBottom: 32 }}>
          <div className="sb-section-header" style={{ marginBottom: 12 }}>
            <span className="sb-section-title">
              {IS_WEEKEND_MODE ? "🌅 " : ""}{todaySectionTitle}
            </span>
            {homeCity && cityTodayCount > 0 && !showExpandedRegional && !IS_WEEKEND_MODE && (
              <span style={{ fontSize: 12, fontWeight: 500, color: "var(--sb-muted)" }}>
                {cityTodayCount} {cityTodayCount === 1 ? "event" : "events"}
              </span>
            )}
            {homeCity && (
              <button
                onClick={() => setChangingCity(true)}
                style={{ marginLeft: "auto", background: "none", border: "none", fontSize: 12, color: "var(--sb-muted)", cursor: "pointer", padding: 0, textDecoration: "underline", textUnderlineOffset: 3 }}
              >
                Change city
              </button>
            )}
          </div>

          {homeCity ? (
            showExpandedRegional ? (
              <>
                {cityTodayCount === 0 && southBayCount === 0 && (!IS_WEEKEND_MODE || (southBayTomorrowCount === 0 && cityTomorrowCount === 0)) ? (
                  <div style={{ padding: "16px 0", color: "var(--sb-muted)", fontSize: 13, fontStyle: "italic" }}>
                    Nothing on the calendar today ({WEEKDAY}). Check the Events tab for upcoming events.
                  </div>
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
                        {bucketEvents(cityTomorrowStatic, cityTomorrowUpcoming, false, true)}
                        {bucketEvents(
                          southBayTomorrowStatic.slice(0, SB_LIMIT),
                          southBayTomorrowUpcoming.slice(0, SB_LIMIT),
                          true,
                        )}
                      </>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                {cityTodayCount === 0 && (!IS_WEEKEND_MODE || cityTomorrowCount === 0) ? (
                  <div style={{ padding: "16px 0", color: "var(--sb-muted)", fontSize: 13, fontStyle: "italic" }}>
                    Nothing scheduled in {getCityName(homeCity)} today ({WEEKDAY}). Check the Events tab for upcoming events.
                  </div>
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
                        {bucketEvents(cityTomorrowStatic, cityTomorrowUpcoming, false)}
                      </>
                    )}
                  </>
                )}
              </>
            )
          ) : (
            /* No home city — show south bay wide */
            <>
              {southBayCount === 0 && (!IS_WEEKEND_MODE || southBayTomorrowCount === 0) ? (
                <div style={{ padding: "20px 0", color: "var(--sb-muted)", fontSize: 14, fontStyle: "italic" }}>
                  {`No recurring events on ${WEEKDAY}s this time of year.`}
                </div>
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
                        true,
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Signal Briefing (newspaper front page hero) ── */}
      {!changingCity && (
        <SignalBriefing
          homeCity={homeCity}
          todayUpcoming={todayUpcoming.filter((e) => e.category !== "sports")}
          todayStatic={SOUTH_BAY_EVENTS.filter((e) => isActiveToday(e) && e.category !== "sports")}
          onNavigate={onNavigate}
        />
      )}

      {/* ── City at a glance ── */}
      {homeCity && !changingCity && (
        <CityGlance city={homeCity} onNavigate={onNavigate} />
      )}

      {/* ── Sports callout ── */}
      {todaySportsEvents.length > 0 && (
        <SportsCallout events={todaySportsEvents} />
      )}

      {/* ── Police blotter for home city ── */}
      {homeCity && !changingCity && (
        <BlotterStrip homeCity={homeCity} onNavigate={onNavigate} />
      )}

      {/* ── Around the South Bay ── */}
      {!changingCity && <AroundTownSection />}

      {/* ── This Week: home city upcoming ── */}
      {homeCity && thisWeekByDay.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="sb-section-header" style={{ marginBottom: 12 }}>
            <span className="sb-section-title">This Week in {getCityName(homeCity)}</span>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--sb-muted)" }}>
              {(() => { const n = thisWeekByDay.reduce((acc, d) => acc + d.events.length, 0); return `${n} ${n === 1 ? "event" : "events"}`; })()}
            </span>
          </div>
          {thisWeekByDay.map(({ iso, label, events }) => (
            <div key={iso} style={{ marginBottom: 12 }}>
              <div style={{
                fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                letterSpacing: "0.08em", textTransform: "uppercase",
                color: "var(--sb-muted)", paddingTop: 8, paddingBottom: 2,
                borderBottom: "1px solid var(--sb-border-light)", marginBottom: 0,
              }}>
                {label}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "0 32px" }}
                className="sb-today-grid">
                {events.map((e) => (
                  <UpcomingRow key={e.id} event={e} showCity={false} />
                ))}
              </div>
            </div>
          ))}
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

      {/* ── Sports scoreboard ── */}
      <SportsView />
    </>
  );
}
