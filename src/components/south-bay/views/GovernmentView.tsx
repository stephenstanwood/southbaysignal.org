import { useState, useCallback } from "react";
import DigestCard from "../cards/DigestCard";
import type { DigestData } from "../cards/DigestCard";
import HealthScoresCard from "../cards/HealthScoresCard";
import BudgetCard from "../cards/BudgetCard";
import MinutesSearchCard from "../cards/MinutesSearchCard";
import ElectionsCard from "../cards/ElectionsCard";
import type { City } from "../../../lib/south-bay/types";
import digestsJson from "../../../data/south-bay/digests.json";
import upcomingMeetingsJson from "../../../data/south-bay/upcoming-meetings.json";

interface Props {
  selectedCities: Set<City>;
  homeCity: City | null;
}

interface AgendaItem {
  title: string;
  sequence: number;
}

interface UpcomingMeeting {
  date: string;
  displayDate: string;
  bodyName: string;
  location: string | null;
  url: string;
  agendaItems?: AgendaItem[];
}

// Load pre-generated data from static JSON
const staticDigests = digestsJson as Record<string, DigestData>;
const upcomingMeetings = (upcomingMeetingsJson as { meetings: Record<string, UpcomingMeeting> }).meetings;
const configuredCities = Object.keys(staticDigests) as City[];

// If no pre-generated data, fall back to the known configured cities
const KNOWN_CITIES: City[] = [
  "campbell", "saratoga", "los-altos", "los-gatos",
  "san-jose", "mountain-view", "sunnyvale", "cupertino", "santa-clara",
  "milpitas", "palo-alto",
];

// Agenda page URLs — fallback link when no digest is available
const AGENDA_URLS: Record<string, string> = {
  "campbell": "https://www.campbellca.gov/AgendaCenter/City-Council-10",
  "saratoga": "https://saratoga-ca.municodemeetings.com/",
  "los-altos": "https://losaltos-ca.municodemeetings.com/",
  "los-gatos": "https://losgatos-ca.municodemeetings.com/",
  "san-jose": "https://sanjose.legistar.com/Calendar.aspx",
  "mountain-view": "https://mountainview.legistar.com/Calendar.aspx",
  "sunnyvale": "https://sunnyvale.legistar.com/Calendar.aspx",
  "cupertino": "https://cupertino.legistar.com/Calendar.aspx",
  "santa-clara": "https://santaclara.legistar.com/Calendar.aspx",
  "milpitas": "https://www.ci.milpitas.ca.gov/government/council/",
  "palo-alto": "https://www.cityofpaloalto.org/Government/City-Clerk/Meetings-Agendas-Minutes",
};
const allConfigured = configuredCities.length > 0 ? configuredCities : KNOWN_CITIES;

export default function GovernmentView({ selectedCities, homeCity }: Props) {
  const [digests, setDigests] = useState<Map<string, DigestData>>(() => {
    const map = new Map<string, DigestData>();
    for (const [city, digest] of Object.entries(staticDigests)) {
      map.set(city, digest);
    }
    return map;
  });
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());

  // On-demand refresh for a single city
  const refreshDigest = useCallback(async (city: City) => {
    setLoading((prev) => new Set(prev).add(city));
    setErrors((prev) => {
      const next = new Map(prev);
      next.delete(city);
      return next;
    });

    try {
      const res = await fetch(`/api/south-bay/digest?city=${city}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? `Failed (${res.status})`);
      }
      const digest: DigestData = await res.json();
      setDigests((prev) => new Map(prev).set(city, digest));
    } catch (e) {
      setErrors((prev) =>
        new Map(prev).set(
          city,
          e instanceof Error ? e.message : "Failed to load",
        ),
      );
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(city);
        return next;
      });
    }
  }, []);

  // Sort: home city first (fallback san-jose)
  const primary = homeCity ?? "san-jose";
  const visibleCities = allConfigured
    .filter((c) => selectedCities.has(c))
    .sort((a, b) => {
      if (a === primary) return -1;
      if (b === primary) return 1;
      return 0;
    });
  const unconfiguredSelected = [...selectedCities].filter(
    (c) => !allConfigured.includes(c),
  );

  const totalCities = 11;

  function cityLabel(city: string) {
    return city
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  }

  return (
    <>
      {/* ── 2026 Elections ── */}
      <ElectionsCard />

      {/* ── Budget Snapshot ── */}
      <BudgetCard cityId={homeCity} />

      {/* ── Section header ── */}
      <div className="sb-section-header" style={{ marginBottom: 4 }}>
        <span className="sb-section-title">Council Digests</span>
      </div>

      {/* ── Explainer ── */}
      <p
        style={{
          fontSize: 12,
          color: "var(--sb-muted)",
          marginTop: 0,
          marginBottom: 20,
          lineHeight: 1.5,
        }}
      >
        AI-generated plain-English summaries of city council meeting agendas —
        what was discussed, what was decided, and why it matters.
      </p>

      {visibleCities.length === 0 && unconfiguredSelected.length === 0 && (
        <div className="sb-empty">
          <div className="sb-empty-title">No cities selected</div>
          <div className="sb-empty-sub">
            Select cities above to see council meeting digests
          </div>
        </div>
      )}

      {/* Configured cities with digests */}
      {visibleCities.map((city) => {
        const digest = digests.get(city);
        const isLoading = loading.has(city);
        const error = errors.get(city);

        if (isLoading) {
          return (
            <div
              key={city}
              style={{
                padding: "14px 16px",
                border: "1px solid var(--sb-border-light)",
                borderRadius: "var(--sb-radius)",
                marginBottom: 12,
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "var(--sb-muted)",
                fontSize: 13,
              }}
            >
              <div className="sb-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
              Refreshing {cityLabel(city)}…
            </div>
          );
        }

        if (error) {
          return (
            <div key={city} className="sb-digest-error">
              <span>
                <strong>{cityLabel(city)}:</strong> {error}
              </span>
              <button onClick={() => refreshDigest(city)}>Retry</button>
            </div>
          );
        }

        const nextMeeting = upcomingMeetings[city as keyof typeof upcomingMeetings] ?? null;

        if (digest) {
          return (
            <DigestCard
              key={city}
              digest={digest}
              onRefresh={() => refreshDigest(city)}
              upcomingMeeting={nextMeeting}
            />
          );
        }

        // No pre-generated data for this city — show prompt to generate
        const hasAgenda = nextMeeting?.agendaItems && nextMeeting.agendaItems.length > 0;
        return (
          <div
            key={city}
            style={{
              padding: "14px 16px",
              border: "1px dashed var(--sb-border)",
              borderRadius: "var(--sb-radius)",
              marginBottom: 12,
              fontSize: 13,
              color: "var(--sb-muted)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontWeight: 600, color: "var(--sb-text)" }}>{cityLabel(city)}</span>
                {nextMeeting ? (
                  <span style={{ fontSize: 11 }}>
                    Next meeting:{" "}
                    <a
                      href={nextMeeting.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "var(--sb-accent)", textDecoration: "none" }}
                    >
                      {nextMeeting.displayDate} →
                    </a>
                  </span>
                ) : AGENDA_URLS[city] ? (
                  <span style={{ fontSize: 11 }}>
                    <a
                      href={AGENDA_URLS[city]}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "var(--sb-accent)", textDecoration: "none" }}
                    >
                      View agendas →
                    </a>
                  </span>
                ) : (
                  <span style={{ fontSize: 11 }}>No digest generated yet</span>
                )}
              </span>
              <button
                onClick={() => refreshDigest(city)}
                style={{
                  padding: "4px 10px",
                  fontSize: 11,
                  border: "1px solid var(--sb-border)",
                  borderRadius: 4,
                  background: "#fff",
                  cursor: "pointer",
                  fontFamily: "'Space Mono', monospace",
                  flexShrink: 0,
                }}
              >
                Generate
              </button>
            </div>
            {hasAgenda && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--sb-muted)", marginBottom: 6 }}>
                  On the agenda · {nextMeeting!.displayDate}
                </div>
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                  {nextMeeting!.agendaItems!.map((item, i) => (
                    <li
                      key={i}
                      style={{
                        fontSize: 12,
                        color: "var(--sb-text)",
                        lineHeight: 1.4,
                        paddingLeft: 10,
                        borderLeft: "2px solid var(--sb-border-light)",
                      }}
                    >
                      {item.title}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}


      {/* ── Council Records Search ── */}
      <MinutesSearchCard homeCity={homeCity} selectedCities={selectedCities} />

      {/* ── Food Safety Watch ── */}
      {/* Health scores moved to Food tab */}
    </>
  );
}
