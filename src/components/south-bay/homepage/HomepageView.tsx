// ---------------------------------------------------------------------------
// South Bay Signal — New Homepage ("State of the South Bay")
// ---------------------------------------------------------------------------
// A dynamic, editorially hierarchical front page.
// Replaces the old OverviewView with modular sections and visual punch.

import { useState } from "react";
import type { City, Tab } from "../../../lib/south-bay/types";
import { CITIES, getCityName } from "../../../lib/south-bay/cities";
import {
  IS_WEEKEND_MODE, WEEKDAY, TODAY_ISO, NOW_MINUTES,
  formatAge, startMinutes, formatTimeRange, timeBucket,
  BUCKET_ORDER, BUCKET_LABELS, type TimeBucket,
} from "../../../lib/south-bay/timeHelpers";
import { useHomepageData, type UpcomingEvent } from "./useHomepageData";
import SportsView from "../views/SportsView";
import OutagesCard from "../cards/OutagesCard";
import PhotoStrip from "./PhotoStrip";
import AroundTown from "./AroundTown";

// ── Shared styles ──

const SECTION_GAP = 28;
const CARD_RADIUS = 6;

const sectionTitle: React.CSSProperties = {
  fontFamily: "var(--sb-serif)",
  fontWeight: 800,
  fontSize: 22,
  color: "var(--sb-ink)",
  letterSpacing: "-0.01em",
  lineHeight: 1.2,
  margin: 0,
};

const sectionLabel: React.CSSProperties = {
  fontFamily: "'Space Mono', monospace",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase" as const,
  color: "var(--sb-muted)",
};

const cardBase: React.CSSProperties = {
  background: "var(--sb-card)",
  border: "1px solid var(--sb-border-light)",
  borderRadius: CARD_RADIUS,
  overflow: "hidden",
};

// ── Props ──

type Props = {
  homeCity: City | null;
  setHomeCity: (city: City) => void;
  onNavigate: (tab: Tab) => void;
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export default function HomepageView({ homeCity, setHomeCity, onNavigate }: Props) {
  const [changingCity, setChangingCity] = useState(false);
  const [showAllEvents, setShowAllEvents] = useState(false);

  const data = useHomepageData(homeCity);

  return (
    <>
      {/* ═══ City prompt / picker ═══ */}
      {!homeCity && !changingCity ? (
        <div style={{ background: "var(--sb-primary-light)", border: "1px solid var(--sb-border-light)", borderRadius: "var(--sb-radius)", padding: "12px 16px", marginBottom: 24, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "var(--sb-muted)", lineHeight: 1.4 }}>
            Personalize for your city — see your local events, council meetings, and active projects.
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

      {/* ═══ Power outage alert ═══ */}
      <OutagesCard />

      {/* ═══ Weather strip ═══ */}
      {data.weather && (
        <div style={{ background: "var(--sb-primary-light)", border: "1px solid var(--sb-border-light)", borderRadius: "var(--sb-radius)", padding: "10px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, color: "var(--sb-ink)", fontWeight: 500 }}>{data.weather}</span>
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
          {/* Freshness indicator */}
          {data.freshness.events && (
            <span style={{
              marginLeft: homeCity ? 0 : "auto",
              ...sectionLabel, fontSize: 9, color: "var(--sb-light)",
              display: "flex", alignItems: "center", gap: 4,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10B981", display: "inline-block" }} />
              Updated {formatAge(data.freshness.events)}
            </span>
          )}
        </div>
      )}

      {/* ═══ 5-day forecast ═══ */}
      {data.forecast && data.forecast.length > 0 && !changingCity && (
        <ForecastStrip forecast={data.forecast} />
      )}

      {/* ═══ Photo strip ═══ */}
      {!changingCity && <PhotoStrip />}

      {/* ═══ Today in [City] / This Weekend — THE MAIN EVENT SECTION ═══ */}
      {!changingCity && data.bucketedEvents.length > 0 && (
        <EventsSection
          buckets={data.bucketedEvents}
          title={data.eventsSectionTitle}
          homeCity={homeCity}
          todayCount={data.todayCount}
          sportsToday={data.sportsToday}
          showAll={showAllEvents}
          setShowAll={setShowAllEvents}
          onNavigate={onNavigate}
        />
      )}

      {/* ═══ City briefing ═══ */}
      {homeCity && data.cityBriefing && !changingCity && (
        <CityBriefingSection briefing={data.cityBriefing} onNavigate={onNavigate} />
      )}

      {/* ═══ Around the South Bay ═══ */}
      {!changingCity && <AroundTown />}

      {/* ═══ Civic Watch ═══ */}
      {data.civicHighlights.length > 0 && !changingCity && (
        <CivicWatchSection highlights={data.civicHighlights} onNavigate={onNavigate} />
      )}

      {/* ═══ New & Notable ═══ */}
      {data.newNotable.length > 0 && !changingCity && (
        <NewNotableSection items={data.newNotable} onNavigate={onNavigate} />
      )}

      {/* ═══ Sports ═══ */}
      {!changingCity && <SportsView />}
    </>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// FORECAST STRIP
// ═══════════════════════════════════════════════════════════════════════════

function ForecastStrip({ forecast }: { forecast: Array<{ date: string; emoji: string; desc: string; high: number; low: number; rainPct: number }> }) {
  const dayLabel = (dateStr: string) => {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-US", { weekday: "short" });
  };

  return (
    <div style={{
      display: "flex", gap: 0,
      borderRadius: CARD_RADIUS,
      overflow: "hidden",
      border: "1px solid var(--sb-border-light)",
    }}>
      {forecast.slice(0, 5).map((day, i) => {
        const isToday = i === 0;
        return (
          <div
            key={day.date}
            style={{
              flex: 1,
              padding: "12px 8px",
              textAlign: "center",
              background: isToday ? "var(--sb-ink)" : "var(--sb-card)",
              color: isToday ? "#fff" : "var(--sb-ink)",
              borderRight: i < 4 ? "1px solid var(--sb-border-light)" : undefined,
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.6, marginBottom: 4 }}>
              {isToday ? "Today" : dayLabel(day.date)}
            </div>
            <div style={{ fontSize: 28, lineHeight: 1, marginBottom: 4, fontFamily: "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif" }}>{day.emoji}</div>
            <div style={{ fontSize: 16, fontWeight: 800, lineHeight: 1 }}>{Math.round(day.high)}°</div>
            <div style={{ fontSize: 11, opacity: 0.5 }}>{Math.round(day.low)}°</div>
            {day.rainPct > 20 && (
              <div style={{ fontSize: 9, marginTop: 2, color: isToday ? "#93C5FD" : "#3B82F6", fontWeight: 600 }}>
                💧 {Math.round(day.rainPct)}%
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// TONIGHT AT CITY HALL


// ═══════════════════════════════════════════════════════════════════════════
// EVENTS SECTION — time-bucketed
// ═══════════════════════════════════════════════════════════════════════════

function EventsSection({ buckets, title, homeCity, todayCount, sportsToday, showAll, setShowAll, onNavigate }: {
  buckets: Array<{ bucket: TimeBucket; label: string; events: UpcomingEvent[] }>;
  title: string;
  homeCity: City | null;
  todayCount: number;
  sportsToday: UpcomingEvent[];
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  onNavigate: (tab: Tab) => void;
}) {

  const INITIAL_PER_BUCKET = 4;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ ...sectionTitle, fontSize: 20 }}>{title}</h2>
        <button
          onClick={() => onNavigate("events")}
          style={{
            background: "none", border: "1px solid var(--sb-border)", borderRadius: 100,
            padding: "4px 14px", fontSize: 11, fontWeight: 600, cursor: "pointer",
            color: "var(--sb-ink)", fontFamily: "inherit", letterSpacing: "0.02em",
          }}
        >
          All {todayCount} events →
        </button>
      </div>

      {/* Sports callout */}
      {sportsToday.length > 0 && (
        <div style={{
          background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
          borderRadius: CARD_RADIUS,
          padding: "12px 16px",
          marginBottom: 16,
          border: "1px solid #334155",
        }}>
          <div style={{ ...sectionLabel, color: "#94a3b8", marginBottom: 8 }}>🏟️ Game Day</div>
          {sportsToday.slice(0, 3).map((e) => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>
                  {e.url ? <a href={e.url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>{e.title}</a> : e.title}
                </span>
                <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: 8 }}>
                  {e.time && <span style={{ color: "#38bdf8", fontWeight: 600 }}>{e.time}</span>}
                  {e.venue && <span> · {e.venue}</span>}
                </span>
              </div>
              {e.cost === "free" && (
                <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: "#D1FAE5", color: "#065F46" }}>FREE</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Time-bucketed events */}
      {buckets.map(({ bucket, label, events }) => {
        const display = showAll ? events : events.slice(0, INITIAL_PER_BUCKET);
        const isNow = bucket === "now";
        return (
          <div key={bucket} style={{ marginBottom: 20 }}>
            <div style={{
              ...sectionLabel,
              color: isNow ? "var(--sb-accent)" : "var(--sb-muted)",
              paddingBottom: 6,
              borderBottom: "1px solid var(--sb-border-light)",
              marginBottom: 8,
              display: "flex", alignItems: "center", gap: 6,
            }}>
              {isNow && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--sb-accent)", animation: "pulse 2s infinite" }} />}
              {label}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {display.map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </div>
            {!showAll && events.length > INITIAL_PER_BUCKET && (
              <button
                onClick={() => setShowAll(true)}
                style={{
                  background: "none", border: "none", padding: "6px 0",
                  fontSize: 12, fontWeight: 600, color: "var(--sb-accent)",
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                +{events.length - INITIAL_PER_BUCKET} more →
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Event Row ──

const CATEGORY_EMOJI: Record<string, string> = {
  music: "🎵", arts: "🎨", family: "👨‍👩‍👦", education: "📚", community: "🤝",
  market: "🌽", food: "🍜", outdoor: "🌿", sports: "🏟️",
};

function EventRow({ event }: { event: UpcomingEvent }) {
  const time = formatTimeRange(event.time, event.endTime);
  const emoji = CATEGORY_EMOJI[event.category] ?? "📅";
  const isFree = event.cost === "free";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 0",
      borderBottom: "1px solid var(--sb-border-light)",
    }}>
      <span style={{ fontSize: 18, width: 26, textAlign: "center", flexShrink: 0 }}>{emoji}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{
            fontFamily: "var(--sb-serif)", fontWeight: 600, fontSize: 14,
            color: "var(--sb-ink)", lineHeight: 1.3,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {event.url ? (
              <a href={event.url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                {event.title}
              </a>
            ) : event.title}
          </span>
          {isFree && (
            <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "#D1FAE5", color: "#065F46" }}>FREE</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: "var(--sb-muted)", display: "flex", gap: 6, marginTop: 2 }}>
          {time && <span style={{ fontWeight: 600 }}>{time}</span>}
          {event.venue && <span>· {event.venue}</span>}
          <span>· {event.city === "multi" ? "South Bay" : getCityName(event.city as City)}</span>
        </div>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// CITY BRIEFING
// ═══════════════════════════════════════════════════════════════════════════

function CityBriefingSection({ briefing, onNavigate }: {
  briefing: { cityName: string; summary: string; highlights: Array<{ title: string; when: string | null; category: string; url: string | null }>; weekLabel: string };
  onNavigate: (tab: Tab) => void;
}) {
  const HIGHLIGHT_EMOJI: Record<string, string> = {
    music: "🎵", arts: "🎨", family: "👨‍👩‍👦", education: "📚",
    community: "🤝", market: "🌽", food: "🍜", outdoor: "🌿",
    sports: "🏟️", government: "🏛️",
  };

  return (
    <div style={{
      background: "#FEFCE8",
      border: "1.5px solid #FDE68A",
      borderRadius: CARD_RADIUS,
      padding: "18px 20px",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <h2 style={{ ...sectionTitle, fontSize: 18 }}>📍 This Week in {briefing.cityName}</h2>
        <span style={{ ...sectionLabel, fontSize: 9, color: "#A16207" }}>{briefing.weekLabel}</span>
      </div>

      {briefing.highlights.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
          {briefing.highlights.slice(0, 5).map((h, i) => {
            const emoji = HIGHLIGHT_EMOJI[h.category] ?? "📅";
            return (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <span style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }}>{emoji}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 600,
                    color: h.url ? "#b45309" : "var(--sb-ink)",
                    lineHeight: 1.35,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {h.url ? (
                      <a href={h.url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>{h.title}</a>
                    ) : h.title}
                  </div>
                  {h.when && <div style={{ fontSize: 11, color: "#92400E" }}>{h.when}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p style={{ fontSize: 13, lineHeight: 1.55, color: "#713f12", margin: 0 }}>
        {briefing.summary.slice(0, 200)}{briefing.summary.length > 200 ? "…" : ""}
      </p>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// CIVIC WATCH
// ═══════════════════════════════════════════════════════════════════════════

function CivicWatchSection({ highlights, onNavigate }: {
  highlights: Array<{ cityId: string; cityName: string; headline: string; summary: string; meetingDate?: string; sourceUrl?: string }>;
  onNavigate: (tab: Tab) => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        <h2 style={{ ...sectionTitle, fontSize: 18 }}>🏛️ Civic Watch</h2>
        <button
          onClick={() => onNavigate("government")}
          style={{
            background: "none", border: "1px solid var(--sb-border)", borderRadius: 100,
            padding: "4px 14px", fontSize: 11, fontWeight: 600, cursor: "pointer",
            color: "var(--sb-ink)", fontFamily: "inherit",
          }}
        >
          All government →
        </button>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, 1fr)",
        gap: 12,
      }}
      className="sb-civic-grid"
      >
        {highlights.map((h, i) => (
          <div
            key={i}
            style={{
              ...cardBase,
              padding: "14px 16px",
              cursor: h.sourceUrl ? "pointer" : undefined,
              transition: "box-shadow 0.15s",
            }}
            onClick={() => h.sourceUrl ? window.open(h.sourceUrl, "_blank") : onNavigate("government")}
            onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.boxShadow = "var(--sb-shadow-hover)"}
            onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.boxShadow = "none"}
          >
            <div style={{ ...sectionLabel, color: "#6366f1", marginBottom: 6 }}>
              {h.cityName} {h.meetingDate ? `· ${h.meetingDate}` : ""}
            </div>
            <div style={{
              fontFamily: "var(--sb-serif)", fontWeight: 700, fontSize: 14,
              lineHeight: 1.3, color: "var(--sb-ink)", marginBottom: 6,
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const, overflow: "hidden",
            }}>
              {h.headline}
            </div>
            <div style={{ fontSize: 12, color: "var(--sb-muted)", lineHeight: 1.4 }}>
              {h.summary.slice(0, 100)}{h.summary.length > 100 ? "…" : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// NEW & NOTABLE
// ═══════════════════════════════════════════════════════════════════════════

function NewNotableSection({ items, onNavigate }: {
  items: Array<{ type: string; title: string; subtitle: string; emoji: string; url?: string }>;
  onNavigate: (tab: Tab) => void;
}) {
  return (
    <div>
      <h2 style={{ ...sectionTitle, fontSize: 18, marginBottom: 14 }}>✨ New & Notable</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {items.map((item, i) => (
          <div
            key={i}
            style={{
              display: "flex", alignItems: "center", gap: 12, padding: "10px 0",
              borderBottom: "1px solid var(--sb-border-light)",
              cursor: "pointer",
            }}
            onClick={() => onNavigate(item.type === "restaurant" ? "food" : "government")}
          >
            <span style={{ fontSize: 20, width: 28, textAlign: "center" }}>{item.emoji}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--sb-serif)", fontWeight: 600, fontSize: 14, color: "var(--sb-ink)" }}>
                {item.title}
              </div>
              <div style={{ fontSize: 12, color: "var(--sb-muted)" }}>{item.subtitle}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// CITY PICKER
// ═══════════════════════════════════════════════════════════════════════════

function CityPicker({ homeCity, onSelect, onClose }: {
  homeCity: City | null;
  onSelect: (city: City) => void;
  onClose?: () => void;
}) {
  return (
    <div style={{
      ...cardBase,
      padding: "20px 24px",
      marginBottom: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h3 style={{ ...sectionTitle, fontSize: 16, margin: 0 }}>Choose your city</h3>
        {onClose && (
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "var(--sb-muted)", padding: 0 }}>
            ×
          </button>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }} className="sb-city-grid">
        {CITIES.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            style={{
              padding: "10px 12px",
              borderRadius: CARD_RADIUS,
              border: c.id === homeCity ? "2px solid var(--sb-ink)" : "1px solid var(--sb-border-light)",
              background: c.id === homeCity ? "var(--sb-ink)" : "var(--sb-card)",
              color: c.id === homeCity ? "#fff" : "var(--sb-ink)",
              fontSize: 13,
              fontWeight: c.id === homeCity ? 700 : 500,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "all 0.1s",
            }}
          >
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}
