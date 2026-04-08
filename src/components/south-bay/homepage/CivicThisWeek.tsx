// ---------------------------------------------------------------------------
// "This Week in Local Government" — civic intelligence rollup
// ---------------------------------------------------------------------------
// Combines upcoming meetings + recent civic actions into one compelling module.
// Shows what's happening at city hall across all 11 cities this week.

import type { City, Tab } from "../../../lib/south-bay/types";
import { getCityName } from "../../../lib/south-bay/cities";
import { TODAY_ISO, NEXT_DAYS } from "../../../lib/south-bay/timeHelpers";

import upcomingMeetingsJson from "../../../data/south-bay/upcoming-meetings.json";
import aroundTownJson from "../../../data/south-bay/around-town.json";

type MeetingEntry = {
  date: string;
  displayDate: string;
  bodyName: string;
  location?: string;
  url?: string;
};

type AroundTownItem = {
  headline: string;
  summary: string;
  cityId: string;
  cityName: string;
  source: string;
  sourceUrl?: string;
  date: string;
};

const CITY_ACCENT: Record<string, string> = {
  "san-jose": "#1e3a8a", campbell: "#7c2d12", "los-gatos": "#065f46",
  saratoga: "#6b21a8", cupertino: "#0e7490", sunnyvale: "#b45309",
  "mountain-view": "#9a3412", "palo-alto": "#166534", "santa-clara": "#1d4ed8",
  "los-altos": "#854d0e", milpitas: "#991b1b",
};

export default function CivicThisWeek({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  // Upcoming meetings this week (within 7 days)
  const data = upcomingMeetingsJson as unknown as { meetings: Record<string, MeetingEntry> };
  const weekEnd = NEXT_DAYS[5]?.iso ?? "";

  const meetings = Object.entries(data.meetings ?? {})
    .filter(([, m]) => m.date >= TODAY_ISO && m.date <= weekEnd)
    .sort(([, a], [, b]) => a.date.localeCompare(b.date))
    .map(([cityId, m]) => ({
      cityId,
      cityName: getCityName(cityId as City),
      ...m,
    }));

  // Recent civic actions (from around-town, last 3 days)
  const cutoff3d = new Date(Date.now() - 3 * 86400000).toISOString().split("T")[0];
  const recentActions = ((aroundTownJson as { items: AroundTownItem[] }).items ?? [])
    .filter((item) => item.date >= cutoff3d)
    .slice(0, 3);

  if (meetings.length === 0 && recentActions.length === 0) return null;

  // Meetings today get special treatment
  const todayMeetings = meetings.filter((m) => m.date === TODAY_ISO);
  const upcomingMeetings = meetings.filter((m) => m.date > TODAY_ISO);

  return (
    <div style={{ marginBottom: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        <h2 style={{
          fontFamily: "var(--sb-serif)", fontWeight: 800, fontSize: 18,
          color: "var(--sb-ink)", margin: 0,
        }}>
          🏛️ This Week in Local Government
        </h2>
        <button
          onClick={() => onNavigate("government")}
          style={{
            background: "none", border: "1px solid var(--sb-border)", borderRadius: 100,
            padding: "4px 14px", fontSize: 11, fontWeight: 600, cursor: "pointer",
            color: "var(--sb-ink)", fontFamily: "inherit",
          }}
        >
          Gov tab →
        </button>
      </div>

      {/* Tonight at City Hall — urgent callout when meetings are today */}
      {todayMeetings.length > 0 && (
        <div
          style={{
            background: "linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)",
            borderRadius: 6, padding: "14px 18px", marginBottom: 12,
            cursor: "pointer", color: "#e0e7ff",
          }}
          onClick={() => onNavigate("government")}
        >
          <div style={{
            fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700,
            letterSpacing: "0.12em", textTransform: "uppercase" as const,
            color: "#818cf8", marginBottom: 8,
          }}>
            Tonight at City Hall
          </div>
          {todayMeetings.map((m) => (
            <div key={m.cityId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: "#fff" }}>{m.cityName}</span>
              <span style={{ fontSize: 12, color: "#a5b4fc" }}>{m.bodyName}</span>
              {m.url && (
                <a
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{ fontSize: 11, color: "#818cf8", marginLeft: "auto", textDecoration: "none" }}
                >
                  Agenda →
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Upcoming meetings this week */}
      {upcomingMeetings.length > 0 && (
        <div style={{
          background: "var(--sb-card)", border: "1px solid var(--sb-border-light)",
          borderRadius: 6, padding: "12px 16px", marginBottom: recentActions.length > 0 ? 12 : 0,
        }}>
          <div style={{
            fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700,
            letterSpacing: "0.1em", textTransform: "uppercase" as const,
            color: "var(--sb-muted)", marginBottom: 8,
          }}>
            Coming Up
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {upcomingMeetings.map((m) => {
              const dayLabel = new Date(m.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
              const accent = CITY_ACCENT[m.cityId] ?? "var(--sb-primary)";
              return (
                <div key={m.cityId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--sb-border-light)" }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 3,
                    background: accent + "15", color: accent,
                  }}>
                    {m.cityName}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--sb-ink)", fontWeight: 500, flex: 1 }}>
                    {m.bodyName}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace" }}>
                    {dayLabel}
                  </span>
                  {m.url && (
                    <a
                      href={m.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 10, color: accent, textDecoration: "none", fontWeight: 600 }}
                    >
                      Agenda
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent civic actions */}
      {recentActions.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {recentActions.map((item, i) => {
            const accent = CITY_ACCENT[item.cityId] ?? "var(--sb-primary)";
            return (
              <div key={i} style={{
                padding: "10px 0",
                borderBottom: i < recentActions.length - 1 ? "1px solid var(--sb-border-light)" : "none",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3,
                    background: accent + "15", color: accent,
                  }}>
                    {item.cityName.toUpperCase()}
                  </span>
                  {item.source && (
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: "1px 4px", borderRadius: 2,
                      background: "#1e3a8a15", color: "#1e3a8a",
                      fontFamily: "'Space Mono', monospace", letterSpacing: "0.04em",
                    }}>
                      {item.source.toUpperCase()}
                    </span>
                  )}
                </div>
                <div style={{ fontFamily: "var(--sb-serif)", fontWeight: 600, fontSize: 13, color: "var(--sb-ink)", lineHeight: 1.35 }}>
                  {item.headline}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
