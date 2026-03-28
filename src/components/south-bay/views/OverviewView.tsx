import { useState, useEffect } from "react";
import SportsView from "./SportsView";
import {
  SOUTH_BAY_EVENTS,
  type SBEvent,
  type DayOfWeek,
} from "../../../data/south-bay/events-data";
import { CITIES, getCityName } from "../../../lib/south-bay/cities";
import type { City } from "../../../lib/south-bay/types";
import upcomingJson from "../../../data/south-bay/upcoming-events.json";

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

// Parses "9am", "9:30am", "9:00 AM", "9am – 1pm" → minutes since midnight
// useLast=true grabs the end time from a range like "9am – 1pm"
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
  if (!timeStr) return true; // no time info — keep
  const endMin = parseMinutes(timeStr, true);
  if (endMin === null) return true;
  return endMin > NOW_MINUTES;
}

// ── Static event helpers ──────────────────────────────────────────────────────

function isActiveToday(e: SBEvent): boolean {
  if (e.months && !e.months.includes(MONTH)) return false;
  // seasonal without days = "in season this month", not a specific today event
  if (!e.days) return e.recurrence !== "seasonal";
  if (!e.days.includes(DAY_NAME as DayOfWeek)) return false;
  // Filter events that have already ended today
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

// Category → emoji for scraped upcoming events
const CATEGORY_EMOJI: Record<string, string> = {
  music: "🎵", arts: "🎨", family: "👨‍👩‍👦", education: "📚", community: "🤝",
  market: "🌽", food: "🍜", outdoor: "🌿", sports: "🏟️",
};

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

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  homeCity: City | null;
  setHomeCity: (city: City | null) => void;
}

export default function OverviewView({ homeCity, setHomeCity }: Props) {
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

  // ── Seasonal events for "This Month" section ──
  const thisMonthEvents = SOUTH_BAY_EVENTS
    .filter((e) => e.recurrence === "seasonal" && e.months?.includes(MONTH))
    .sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0))
    .slice(0, 6);

  const nextMonthPreview = SOUTH_BAY_EVENTS
    .filter((e) => e.recurrence === "seasonal" && e.months?.includes(NEXT_MONTH) && !e.months?.includes(MONTH))
    .sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0))
    .slice(0, 4);

  const showThisMonth = thisMonthEvents.length > 0 || nextMonthPreview.length > 0;

  // ── Today: home city (static recurring) ──
  const cityTodayStatic = homeCity
    ? SOUTH_BAY_EVENTS
        .filter((e) => e.city === homeCity && isActiveToday(e))
        .sort((a, b) => startMinutes(a.time) - startMinutes(b.time))
    : [];

  // ── Today: home city (scraped upcoming) ──
  const cityTodayUpcoming = homeCity
    ? todayUpcoming
        .filter((e) => e.city === homeCity)
        .filter((e) => isNotEnded(e.time))
        .sort((a, b) => startMinutes(a.time) - startMinutes(b.time))
    : [];

  const cityTodayCount = cityTodayStatic.length + cityTodayUpcoming.length;

  // ── Today: south bay-wide (static recurring, excluding home city) ──
  const southBayTodayStatic = SOUTH_BAY_EVENTS
    .filter((e) => isActiveToday(e) && (homeCity ? e.city !== homeCity : true))
    .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));

  // ── Today: south bay-wide (scraped upcoming, excluding home city) ──
  const southBayTodayUpcoming = todayUpcoming
    .filter((e) => (homeCity ? e.city !== homeCity : true))
    .filter((e) => isNotEnded(e.time))
    .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));

  const southBayCount = southBayTodayStatic.length + southBayTodayUpcoming.length;

  // When home city has <5 events, collapse to "Today in the South Bay" with home city events highlighted
  const cityIsEmpty = homeCity && cityTodayCount < 5;
  const showExpandedRegional = cityIsEmpty;

  const SB_LIMIT = homeCity ? 6 : 8;
  const totalSouthBay = southBayCount;

  return (
    <>
      {/* ── City prompt / picker ── */}
      {!homeCity && !changingCity ? (
        <div style={{ background: "var(--sb-primary-light)", border: "1px solid var(--sb-border-light)", borderRadius: "var(--sb-radius)", padding: "12px 16px", marginBottom: 24, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "var(--sb-muted)", lineHeight: 1.4 }}>
            Personalize for your city — get a daily brief filtered to where you live.
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
        <div style={{ background: "var(--sb-primary-light)", border: "1px solid var(--sb-border-light)", borderRadius: "var(--sb-radius)", padding: "10px 16px", marginBottom: 24, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 14, color: "var(--sb-ink)", fontWeight: 500 }}>{weather}</span>
          <span style={{ fontSize: 11, color: "var(--sb-muted)", letterSpacing: "0.04em" }}>
            · {homeCity ? getCityName(homeCity) : "South Bay"}, CA
          </span>
        </div>
      )}

      {/* ── Your City Today (or expanded regional if sparse) ── */}
      {homeCity && (
        <div style={{ marginBottom: 32 }}>
          <div className="sb-section-header" style={{ marginBottom: 16 }}>
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
            // Expanded view: all South Bay events, home city events highlighted
            <>
              {cityTodayCount === 0 && southBayCount === 0 ? (
                <div style={{ padding: "16px 0", color: "var(--sb-muted)", fontSize: 13, fontStyle: "italic" }}>
                  Nothing on the calendar today ({WEEKDAY}). Check the Events tab for upcoming events.
                </div>
              ) : (
                <>
                  {/* Home city events first, highlighted */}
                  {cityTodayStatic.map((e) => <EventRow key={e.id} event={e} showCity={false} />)}
                  {cityTodayUpcoming.map((e) => <UpcomingRow key={e.id} event={e} showCity={false} highlight />)}
                  {/* Rest of South Bay */}
                  {southBayTodayStatic.slice(0, SB_LIMIT).map((e) => <EventRow key={e.id} event={e} />)}
                  {southBayTodayUpcoming.slice(0, Math.max(0, SB_LIMIT - southBayTodayStatic.length)).map((e) => <UpcomingRow key={e.id} event={e} />)}
                  {totalSouthBay > SB_LIMIT && !showAllSouthBay && (
                    <button onClick={() => setShowAllSouthBay(true)} style={{ display: "block", marginTop: 12, padding: "8px 0", background: "none", border: "none", color: "var(--sb-primary)", fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}>
                      Show {totalSouthBay - SB_LIMIT} more →
                    </button>
                  )}
                  {showAllSouthBay && (
                    <>
                      {southBayTodayStatic.slice(SB_LIMIT).map((e) => <EventRow key={e.id} event={e} />)}
                      {southBayTodayUpcoming.slice(Math.max(0, SB_LIMIT - southBayTodayStatic.length)).map((e) => <UpcomingRow key={e.id} event={e} />)}
                    </>
                  )}
                </>
              )}
            </>
          ) : (
            // Normal city-specific view
            <>
              {cityTodayStatic.slice(0, 5).map((e) => <EventRow key={e.id} event={e} showCity={false} />)}
              {cityTodayUpcoming.slice(0, Math.max(0, 5 - cityTodayStatic.length)).map((e) => <UpcomingRow key={e.id} event={e} showCity={false} />)}
              {cityTodayCount > 5 && (
                <div style={{ paddingTop: 10, fontSize: 12, color: "var(--sb-muted)" }}>
                  +{cityTodayCount - 5} more in <span style={{ fontWeight: 600, color: "var(--sb-ink)" }}>{getCityName(homeCity)}</span> — see the Events tab.
                </div>
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
            {nextMonthPreview.map((e) => <MonthCard key={e.id} event={e} isUpcoming />)}
          </div>
        </div>
      )}

      {/* ── Happening Today, South Bay (only shown when no home city, or home city is set and city view is not expanded) ── */}
      {!showExpandedRegional && (
        <div style={{ marginBottom: 32 }}>
          <div className="sb-section-header" style={{ marginBottom: 0 }}>
            <span className="sb-section-title">
              {homeCity ? "Across the South Bay" : "Happening Today"}
            </span>
            {(southBayCount) > 0 && (
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
              {(showAllSouthBay ? southBayTodayStatic : southBayTodayStatic.slice(0, SB_LIMIT)).map((e) => <EventRow key={e.id} event={e} />)}
              {(showAllSouthBay ? southBayTodayUpcoming : southBayTodayUpcoming.slice(0, Math.max(0, SB_LIMIT - southBayTodayStatic.length))).map((e) => <UpcomingRow key={e.id} event={e} />)}
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
