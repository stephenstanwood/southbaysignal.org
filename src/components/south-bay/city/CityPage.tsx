// ---------------------------------------------------------------------------
// South Bay Signal — City Page
// ---------------------------------------------------------------------------
// Mini-homepage for a single city: today's events, next meeting, briefing,
// recent civic actions, and links back to the main site.

import { useState, useEffect } from "react";
import type { City } from "../../../lib/south-bay/types";
import { getCityName, CITY_MAP } from "../../../lib/south-bay/cities";
import {
  TODAY_ISO, NEXT_DAYS, NOW_MINUTES, IS_WEEKEND_MODE,
  startMinutes, formatTimeRange, isNotEnded,
  formatAge,
} from "../../../lib/south-bay/timeHelpers";

import upcomingJson from "../../../data/south-bay/upcoming-events.json";
import upcomingMeetingsJson from "../../../data/south-bay/upcoming-meetings.json";
import digestsJson from "../../../data/south-bay/digests.json";
import cityBriefingsJson from "../../../data/south-bay/city-briefings.json";
import aroundTownJson from "../../../data/south-bay/around-town.json";

// ── Types ──

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
  url?: string | null;
  source: string;
  kidFriendly: boolean;
  ongoing?: boolean;
};

type ForecastDay = {
  date: string;
  emoji: string;
  desc: string;
  high: number;
  low: number;
  rainPct: number;
};

// ── Category emoji ──

const CAT_EMOJI: Record<string, string> = {
  music: "🎵", arts: "🎨", family: "👨‍👩‍👦", education: "📚", community: "🤝",
  market: "🌽", food: "🍜", outdoor: "🌿", sports: "🏟️",
};

// ── Props ──

type Props = {
  cityId: string;
  cityName: string;
};

export default function CityPage({ cityId, cityName }: Props) {
  const [weather, setWeather] = useState<string | null>(null);
  const [forecast, setForecast] = useState<ForecastDay[] | null>(null);

  useEffect(() => {
    fetch(`/api/weather?city=${cityId}`)
      .then((r) => r.json())
      .then((d) => {
        setWeather(d.weather ?? null);
        setForecast(d.forecast ?? null);
      })
      .catch(() => {});
  }, [cityId]);

  // ── Events ──
  const allEvents = (upcomingJson as { events: UpcomingEvent[]; generatedAt?: string }).events ?? [];
  const eventsGenAt = (upcomingJson as any).generatedAt;
  const todayEvents = allEvents
    .filter((e) => e.date === TODAY_ISO && e.city === cityId && !e.ongoing && isNotEnded(e.time))
    .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));

  const tomorrowEvents = allEvents
    .filter((e) => e.date === NEXT_DAYS[0]?.iso && e.city === cityId && !e.ongoing)
    .sort((a, b) => startMinutes(a.time) - startMinutes(b.time));

  const thisWeekEvents = NEXT_DAYS.slice(1, 6).flatMap(({ iso }) =>
    allEvents
      .filter((e) => e.date === iso && e.city === cityId && !e.ongoing)
      .sort((a, b) => startMinutes(a.time) - startMinutes(b.time))
      .slice(0, 3)
  );

  // ── Meeting ──
  const meetings = (upcomingMeetingsJson as unknown as { meetings: Record<string, any> }).meetings ?? {};
  const nextMeeting = meetings[cityId];
  const meetingIsToday = nextMeeting?.date === TODAY_ISO;

  // ── Digest ──
  const digest = (digestsJson as Record<string, any>)[cityId];
  const digestAge = digest?.meetingDateIso
    ? (Date.now() - new Date(digest.meetingDateIso).getTime()) / 86400000
    : 999;

  // ── Briefing ──
  const briefings = (cityBriefingsJson as any).cities ?? {};
  const briefing = briefings[cityId];

  // ── Around town ──
  const aroundItems = ((aroundTownJson as any).items ?? [])
    .filter((item: any) => item.cityId === cityId)
    .slice(0, 4);

  // ── City config ──
  const city = CITY_MAP[cityId as City];

  const TODAY_LABEL = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
    timeZone: "America/Los_Angeles",
  });

  return (
    <div>
      {/* ═══ HEADER ═══ */}
      <div style={{ marginBottom: 24 }}>
        <a href="/" style={{ fontSize: 11, color: "var(--sb-muted)", textDecoration: "none", fontFamily: "'Space Mono', monospace", letterSpacing: "0.06em" }}>
          ← SOUTH BAY TODAY
        </a>
        <h1 style={{
          fontFamily: "var(--sb-serif)", fontWeight: 900, fontSize: 42,
          color: "var(--sb-ink)", margin: "8px 0 4px", lineHeight: 1.05,
          letterSpacing: "-0.02em",
        }}>
          {cityName}
        </h1>
        <div style={{ fontSize: 13, color: "var(--sb-muted)" }}>
          {TODAY_LABEL}
          {weather && <span> · {weather}</span>}
          {eventsGenAt && (
            <span style={{ marginLeft: 8, fontSize: 11, color: "var(--sb-light)" }}>
              · Updated {formatAge(eventsGenAt)}
            </span>
          )}
        </div>
      </div>

      {/* ═══ YOUR DAY ═══ */}
      <CityDayPlan cityId={cityId as City} cityName={cityName} />

      {/* ═══ TONIGHT AT CITY HALL ═══ */}
      {meetingIsToday && nextMeeting && (
        <div style={{
          background: "linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)",
          borderRadius: 6, padding: "16px 20px", marginBottom: 20, color: "#e0e7ff",
        }}>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" as const, color: "#818cf8", marginBottom: 6 }}>
            Tonight at City Hall
          </div>
          <div style={{ fontWeight: 700, fontSize: 16, color: "#fff" }}>
            {cityName} {nextMeeting.bodyName}
          </div>
          <div style={{ fontSize: 12, color: "#a5b4fc", marginTop: 4 }}>
            {nextMeeting.displayDate}
            {nextMeeting.location && <span> · {nextMeeting.location}</span>}
          </div>
          {nextMeeting.url && (
            <a href={nextMeeting.url} target="_blank" rel="noopener noreferrer"
              style={{ display: "inline-block", marginTop: 8, fontSize: 12, color: "#818cf8", textDecoration: "none", fontWeight: 600 }}>
              View agenda →
            </a>
          )}
        </div>
      )}

      {/* ═══ TODAY'S EVENTS ═══ */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ fontFamily: "var(--sb-serif)", fontWeight: 800, fontSize: 20, margin: 0, color: "var(--sb-ink)" }}>
            {IS_WEEKEND_MODE ? "This Weekend" : "Today"} in {cityName}
          </h2>
          <a href="/#events" style={{ fontSize: 11, fontWeight: 600, color: "var(--sb-ink)", textDecoration: "none", border: "1px solid var(--sb-border)", borderRadius: 100, padding: "4px 12px" }}>
            All events →
          </a>
        </div>

        {todayEvents.length === 0 ? (
          <div style={{ padding: "16px 0", color: "var(--sb-muted)", fontSize: 13, fontStyle: "italic" }}>
            Nothing on the calendar today. {tomorrowEvents.length > 0 ? "See tomorrow's events below." : "Check the events tab for upcoming events."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {todayEvents.slice(0, 8).map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
            {todayEvents.length > 8 && (
              <a href="/#events" style={{ fontSize: 12, fontWeight: 600, color: "var(--sb-accent)", padding: "8px 0", textDecoration: "none" }}>
                +{todayEvents.length - 8} more events →
              </a>
            )}
          </div>
        )}
      </div>

      {/* ═══ TOMORROW ═══ */}
      {tomorrowEvents.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <h2 style={{ fontFamily: "var(--sb-serif)", fontWeight: 700, fontSize: 16, margin: "0 0 10px", color: "var(--sb-ink)" }}>
            Tomorrow
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {tomorrowEvents.slice(0, 5).map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </div>
        </div>
      )}

      {/* ═══ CITY BRIEFING ═══ */}
      {briefing?.summary && (
        <div style={{
          background: "#FEFCE8", border: "1.5px solid #FDE68A", borderRadius: 6,
          padding: "16px 18px", marginBottom: 28,
        }}>
          <h2 style={{ fontFamily: "var(--sb-serif)", fontWeight: 700, fontSize: 16, margin: "0 0 8px", color: "var(--sb-ink)" }}>
            📍 This Week in {cityName}
          </h2>
          {briefing.highlights?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {briefing.highlights.slice(0, 4).map((h: any, i: number) => (
                <div key={i} style={{ fontSize: 12, color: "#713f12", padding: "3px 0", display: "flex", gap: 6 }}>
                  <span>•</span>
                  <span>{h.title}{h.when ? ` — ${h.when}` : ""}</span>
                </div>
              ))}
            </div>
          )}
          <p style={{ fontSize: 13, lineHeight: 1.55, color: "#713f12", margin: 0 }}>
            {briefing.summary.slice(0, 250)}{briefing.summary.length > 250 ? "…" : ""}
          </p>
        </div>
      )}

      {/* ═══ NEXT COUNCIL MEETING ═══ */}
      {nextMeeting && !meetingIsToday && (
        <div style={{
          background: "var(--sb-card)", border: "1px solid var(--sb-border-light)", borderRadius: 6,
          padding: "14px 18px", marginBottom: 28,
        }}>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "var(--sb-muted)", marginBottom: 6 }}>
            Next Council Meeting
          </div>
          <div style={{ fontWeight: 700, fontSize: 15, color: "var(--sb-ink)" }}>
            {nextMeeting.bodyName} · {nextMeeting.displayDate}
          </div>
          {nextMeeting.url && (
            <a href={nextMeeting.url} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 12, color: "var(--sb-accent)", textDecoration: "none", fontWeight: 600, marginTop: 4, display: "inline-block" }}>
              View agenda →
            </a>
          )}
        </div>
      )}

      {/* ═══ RECENT CIVIC ACTIONS ═══ */}
      {aroundItems.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <h2 style={{ fontFamily: "var(--sb-serif)", fontWeight: 700, fontSize: 16, margin: "0 0 10px", color: "var(--sb-ink)" }}>
            Recent at City Hall
          </h2>
          {aroundItems.map((item: any, i: number) => (
            <div key={i} style={{ padding: "10px 0", borderBottom: i < aroundItems.length - 1 ? "1px solid var(--sb-border-light)" : "none" }}>
              <div style={{ fontFamily: "var(--sb-serif)", fontWeight: 600, fontSize: 14, color: "var(--sb-ink)", lineHeight: 1.35, marginBottom: 3 }}>
                {item.headline}
              </div>
              <div style={{ fontSize: 12, color: "var(--sb-muted)", lineHeight: 1.5 }}>
                {item.summary}
                {item.sourceUrl && (
                  <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--sb-accent)", textDecoration: "none", fontWeight: 600, marginLeft: 4 }}>
                    Source →
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ═══ LAST COUNCIL DIGEST ═══ */}
      {digest?.summary && digestAge < 30 && (
        <div style={{ marginBottom: 28 }}>
          <h2 style={{ fontFamily: "var(--sb-serif)", fontWeight: 700, fontSize: 16, margin: "0 0 10px", color: "var(--sb-ink)" }}>
            Latest Council Meeting Summary
          </h2>
          <div style={{ fontSize: 11, color: "var(--sb-muted)", marginBottom: 6, fontFamily: "'Space Mono', monospace" }}>
            {digest.meetingDate}
          </div>
          {digest.keyTopics?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {digest.keyTopics.filter((t: string) => t.length > 5).slice(0, 5).map((topic: string, i: number) => (
                <span key={i} style={{
                  display: "inline-block", fontSize: 11, fontWeight: 600, padding: "2px 8px",
                  borderRadius: 3, background: "#1e3a8a15", color: "#1e3a8a",
                  marginRight: 6, marginBottom: 4,
                }}>
                  {topic}
                </span>
              ))}
            </div>
          )}
          <p style={{ fontSize: 13, lineHeight: 1.55, color: "var(--sb-muted)", margin: 0 }}>
            {digest.summary}
          </p>
        </div>
      )}

      {/* ═══ THIS WEEK ═══ */}
      {thisWeekEvents.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <h2 style={{ fontFamily: "var(--sb-serif)", fontWeight: 700, fontSize: 16, margin: "0 0 10px", color: "var(--sb-ink)" }}>
            This Week in {cityName}
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {thisWeekEvents.slice(0, 8).map((e) => {
              const dayLabel = new Date(e.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
              return (
                <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--sb-border-light)" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace", minWidth: 65 }}>
                    {dayLabel}
                  </span>
                  <span style={{ fontSize: 15, width: 22, textAlign: "center" }}>{CAT_EMOJI[e.category] ?? "📅"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontFamily: "var(--sb-serif)", fontWeight: 600, fontSize: 13, color: "var(--sb-ink)" }}>
                      {e.url ? <a href={e.url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>{e.title}</a> : e.title}
                    </span>
                  </div>
                  {e.cost === "free" && (
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "#D1FAE5", color: "#065F46" }}>FREE</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ FOOTER ═══ */}
      <div style={{ borderTop: "2px solid var(--sb-ink)", paddingTop: 16, marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <a href="/" style={{ fontFamily: "var(--sb-serif)", fontWeight: 700, fontSize: 14, color: "var(--sb-ink)", textDecoration: "none" }}>
          ← South Bay Today
        </a>
        {city?.website && (
          <a href={city.website} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--sb-muted)", textDecoration: "none" }}>
            {cityName} official site →
          </a>
        )}
      </div>
    </div>
  );
}

// ── Event Row ──

function EventRow({ event }: { event: UpcomingEvent }) {
  const time = formatTimeRange(event.time, event.endTime);
  const emoji = CAT_EMOJI[event.category] ?? "📅";

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
          {event.cost === "free" && (
            <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "#D1FAE5", color: "#065F46" }}>FREE</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: "var(--sb-muted)", display: "flex", gap: 6, marginTop: 2 }}>
          {time && <span style={{ fontWeight: 600 }}>{time}</span>}
          {event.venue && <span>· {event.venue}</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// City Day Plan — compact plan-day integration for city pages
// ---------------------------------------------------------------------------

const PLAN_ACCENTS = ["#FF6B35", "#E63946", "#06D6A0", "#7B2FBE", "#1A5AFF", "#FF3CAC"];
const PLAN_EMOJI: Record<string, string> = {
  food: "🍽️", outdoor: "🌿", museum: "🏛️", entertainment: "🎭",
  wellness: "💆", shopping: "🛍️", arts: "🎨", events: "📅", sports: "⚾",
};

type DayCard = {
  id: string; name: string; category: string; timeBlock: string;
  blurb: string; why: string; photoRef?: string | null;
  url?: string | null; mapsUrl?: string | null;
  cost?: string | null; costNote?: string | null;
  source: "event" | "place";
};

function CityDayPlan({ cityId, cityName }: { cityId: City; cityName: string }) {
  const [cards, setCards] = useState<DayCard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/plan-day", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ city: cityId, kids: false, currentHour: new Date().getHours() }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.cards) setCards(d.cards); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [cityId]);

  if (loading) {
    return (
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" as const, color: "var(--sb-muted)", marginBottom: 10 }}>
          Your day in {cityName}
        </div>
        {[0,1,2].map((i) => (
          <div key={i} style={{ height: 48, borderRadius: 8, background: `${PLAN_ACCENTS[i]}10`, border: `1px solid ${PLAN_ACCENTS[i]}15`, marginBottom: 6, opacity: 0, animation: `cityPlanFadeIn 0.4s ease ${i * 0.15}s forwards` }} />
        ))}
        <style>{`@keyframes cityPlanFadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }`}</style>
      </div>
    );
  }

  if (!cards.length) return null;

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" as const, color: "var(--sb-muted)", marginBottom: 10 }}>
        Your day in {cityName}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {cards.map((card, i) => {
          const accent = PLAN_ACCENTS[i % PLAN_ACCENTS.length];
          const emoji = PLAN_EMOJI[card.category] || "📍";
          return (
            <div key={card.id} style={{ display: "flex", gap: 10, padding: "10px 12px", borderRadius: 8, background: `${accent}08`, border: `1px solid ${accent}18` }}>
              <div style={{ width: 48, height: 48, borderRadius: 8, overflow: "hidden", flexShrink: 0, background: card.photoRef ? `url(/api/place-photo?ref=${encodeURIComponent(card.photoRef || "")}&w=120&h=120) center/cover no-repeat, ${accent}15` : `${accent}15`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>
                {!card.photoRef && emoji}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 1 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: "var(--sb-ink)" }}>{card.timeBlock}</span>
                  <span style={{ fontSize: 8, fontWeight: 700, color: accent, textTransform: "uppercase" as const, letterSpacing: 1 }}>{card.category}</span>
                </div>
                <div style={{ fontSize: 14, fontWeight: 800, color: "var(--sb-ink)", lineHeight: 1.2, marginBottom: 2 }}>{card.name}</div>
                <div style={{ fontSize: 12, color: "var(--sb-muted)", lineHeight: 1.35 }}>{card.blurb}</div>
              </div>
            </div>
          );
        })}
      </div>
      <a href="/#overview" style={{ display: "inline-block", marginTop: 10, fontSize: 12, fontWeight: 700, color: "var(--sb-accent)", textDecoration: "none" }}>
        Customize your plan →
      </a>
    </div>
  );
}
