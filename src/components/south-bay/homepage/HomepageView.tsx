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
import { useHomepageData, type UpcomingEvent, type LeadStory } from "./useHomepageData";
import SportsView from "../views/SportsView";
import OutagesCard from "../cards/OutagesCard";

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
    <div style={{ display: "flex", flexDirection: "column", gap: SECTION_GAP }}>

      {/* ═══ Freshness + City bar ═══ */}
      <FreshnessBar
        homeCity={homeCity}
        changingCity={changingCity}
        setChangingCity={setChangingCity}
        setHomeCity={setHomeCity}
        freshness={data.freshness}
        weather={data.weather}
      />

      {/* ═══ City picker ═══ */}
      {changingCity && (
        <CityPicker
          homeCity={homeCity}
          onSelect={(city) => { setHomeCity(city); setChangingCity(false); }}
          onClose={() => setChangingCity(false)}
        />
      )}

      {/* ═══ Power outage alert ═══ */}
      <OutagesCard />

      {/* ═══ THE LEAD — hero story area ═══ */}
      {data.leadStories.length > 0 && !changingCity && (
        <LeadSection stories={data.leadStories} onNavigate={onNavigate} />
      )}

      {/* ═══ FORECAST STRIP ═══ */}
      {data.forecast && data.forecast.length > 0 && !changingCity && (
        <ForecastStrip forecast={data.forecast} />
      )}

      {/* ═══ TONIGHT AT CITY HALL ═══ */}
      {data.tonightMeetings.length > 0 && !changingCity && (
        <TonightAtCityHall meetings={data.tonightMeetings} onNavigate={onNavigate} />
      )}

      {/* ═══ WHAT'S HAPPENING — time-bucketed events ═══ */}
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

      {/* ═══ YOUR CITY THIS WEEK ═══ */}
      {homeCity && data.cityBriefing && !changingCity && (
        <CityBriefingSection briefing={data.cityBriefing} onNavigate={onNavigate} />
      )}

      {/* ═══ CIVIC WATCH ═══ */}
      {data.civicHighlights.length > 0 && !changingCity && (
        <CivicWatchSection highlights={data.civicHighlights} onNavigate={onNavigate} />
      )}

      {/* ═══ NEW & NOTABLE ═══ */}
      {data.newNotable.length > 0 && !changingCity && (
        <NewNotableSection items={data.newNotable} onNavigate={onNavigate} />
      )}

      {/* ═══ SPORTS ═══ */}
      {!changingCity && <SportsView />}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// FRESHNESS + CITY BAR
// ═══════════════════════════════════════════════════════════════════════════

function FreshnessBar({ homeCity, changingCity, setChangingCity, setHomeCity, freshness, weather }: {
  homeCity: City | null;
  changingCity: boolean;
  setChangingCity: (v: boolean) => void;
  setHomeCity: (city: City) => void;
  freshness: { events?: string; meetings?: string; briefings?: string };
  weather: string | null;
}) {
  const age = formatAge(freshness.events);

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      padding: "10px 0",
      borderBottom: "2px solid var(--sb-ink)",
    }}>
      {/* Weather + city */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 200 }}>
        {weather && (
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--sb-ink)" }}>
            {weather}
          </span>
        )}
        <button
          onClick={() => setChangingCity(true)}
          style={{
            background: "none", border: "1px solid var(--sb-border)", borderRadius: 100,
            padding: "3px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer",
            color: "var(--sb-ink)", fontFamily: "inherit",
          }}
        >
          {homeCity ? getCityName(homeCity) : "Set your city"} ▾
        </button>
      </div>

      {/* Freshness */}
      {age && (
        <span style={{
          ...sectionLabel,
          fontSize: 9,
          color: "var(--sb-light)",
          display: "flex", alignItems: "center", gap: 4,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10B981", display: "inline-block" }} />
          Updated {age}
        </span>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// THE LEAD — Hero stories
// ═══════════════════════════════════════════════════════════════════════════

function LeadSection({ stories, onNavigate }: { stories: LeadStory[]; onNavigate: (tab: Tab) => void }) {
  const lead = stories[0];
  const secondary = stories.slice(1, 4);

  return (
    <div>
      {/* Lead story — large, bold */}
      <div
        style={{
          ...cardBase,
          borderLeft: `4px solid ${lead.accentColor}`,
          padding: "20px 24px",
          cursor: lead.tab ? "pointer" : undefined,
          transition: "box-shadow 0.15s",
        }}
        onClick={() => lead.tab && onNavigate(lead.tab)}
        onMouseEnter={(e) => { if (lead.tab) (e.currentTarget as HTMLElement).style.boxShadow = "var(--sb-shadow-hover)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = "none"; }}
      >
        <div style={{ ...sectionLabel, color: lead.accentColor, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          <span>{lead.emoji}</span>
          <span>{lead.type === "civic" ? "Civic Watch" : lead.type === "health" ? "Alert" : lead.type === "development" ? "Development" : lead.type === "opening" ? "New & Notable" : "Signal"}</span>
        </div>
        <h2 style={{
          fontFamily: "var(--sb-serif)",
          fontWeight: 800,
          fontSize: 26,
          lineHeight: 1.15,
          color: "var(--sb-ink)",
          margin: "0 0 8px 0",
          letterSpacing: "-0.02em",
        }}>
          {lead.headline}
        </h2>
        <p style={{
          fontSize: 14,
          lineHeight: 1.5,
          color: "var(--sb-muted)",
          margin: 0,
        }}>
          {lead.lede}
        </p>
      </div>

      {/* Secondary stories — compact row */}
      {secondary.length > 0 && (
        <div style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(secondary.length, 3)}, 1fr)`,
          gap: 12,
          marginTop: 12,
        }}
        className="sb-lead-grid"
        >
          {secondary.map((story, i) => (
            <div
              key={i}
              style={{
                ...cardBase,
                borderTop: `3px solid ${story.accentColor}`,
                padding: "14px 16px",
                cursor: story.tab ? "pointer" : undefined,
                transition: "box-shadow 0.15s",
              }}
              onClick={() => story.tab && onNavigate(story.tab)}
              onMouseEnter={(e) => { if (story.tab) (e.currentTarget as HTMLElement).style.boxShadow = "var(--sb-shadow-hover)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = "none"; }}
            >
              <div style={{ ...sectionLabel, color: story.accentColor, marginBottom: 6 }}>
                {story.emoji} {story.type === "development" ? "Development" : story.type === "opening" ? "New Opening" : story.type === "health" ? "Alert" : "Signal"}
              </div>
              <div style={{
                fontFamily: "var(--sb-serif)",
                fontWeight: 700,
                fontSize: 15,
                lineHeight: 1.25,
                color: "var(--sb-ink)",
                marginBottom: 4,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical" as const,
                overflow: "hidden",
              }}>
                {story.headline}
              </div>
              <div style={{ fontSize: 12, color: "var(--sb-muted)", lineHeight: 1.4 }}>
                {story.lede.slice(0, 80)}{story.lede.length > 80 ? "…" : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
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
            <div style={{ fontSize: 22, lineHeight: 1, marginBottom: 4 }}>{day.emoji}</div>
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

function TonightAtCityHall({ meetings, onNavigate }: {
  meetings: Array<{ cityName: string; bodyName: string; date: string; url?: string }>;
  onNavigate: (tab: Tab) => void;
}) {
  return (
    <div
      style={{
        background: "linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e1b4b 100%)",
        borderRadius: CARD_RADIUS,
        padding: "16px 20px",
        color: "#e0e7ff",
        cursor: "pointer",
      }}
      onClick={() => onNavigate("government")}
    >
      <div style={{ ...sectionLabel, color: "#818cf8", marginBottom: 10 }}>
        🏛️ Tonight at City Hall
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {meetings.map((m, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: "#fff" }}>{m.cityName}</span>
            <span style={{ fontSize: 12, color: "#a5b4fc" }}>{m.bodyName}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


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
