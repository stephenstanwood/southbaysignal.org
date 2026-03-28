import { useState, useCallback } from "react";
import DigestCard from "../cards/DigestCard";
import type { DigestData } from "../cards/DigestCard";
import BlotterCard from "../cards/BlotterCard";
import type { CityBlotter } from "../cards/BlotterCard";
import type { City } from "../../../lib/south-bay/types";
import digestsJson from "../../../data/south-bay/digests.json";
import blotterJson from "../../../data/south-bay/blotter.json";
import upcomingMeetingsJson from "../../../data/south-bay/upcoming-meetings.json";

interface Props {
  selectedCities: Set<City>;
  homeCity: City | null;
}

interface UpcomingMeeting {
  date: string;
  displayDate: string;
  bodyName: string;
  location: string | null;
  url: string;
}

// Load pre-generated data from static JSON
const staticDigests = digestsJson as Record<string, DigestData>;
const allBlotters = blotterJson as Record<string, CityBlotter>;
const upcomingMeetings = (upcomingMeetingsJson as { meetings: Record<string, UpcomingMeeting> }).meetings;
const configuredCities = Object.keys(staticDigests) as City[];

// If no pre-generated data, fall back to the known configured cities
const KNOWN_CITIES: City[] = [
  "campbell", "saratoga", "los-altos",
  "san-jose", "mountain-view", "sunnyvale", "cupertino", "santa-clara",
];
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

  // Blotter cities: those with data that are selected, sorted same way
  const blotterCityIds = Object.keys(allBlotters) as City[];
  const visibleBlotterCities = blotterCityIds
    .filter((c) => selectedCities.has(c))
    .sort((a, b) => {
      if (a === primary) return -1;
      if (b === primary) return 1;
      return 0;
    });

  const totalCities = 11;

  function cityLabel(city: string) {
    return city
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  }

  return (
    <>
      {/* ── Section header ── */}
      <div className="sb-section-header" style={{ marginBottom: 4 }}>
        <span className="sb-section-title">Council Digests</span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--sb-accent)",
            background: "#FEF2F2",
            padding: "2px 8px",
            borderRadius: 3,
            letterSpacing: "0.03em",
          }}
        >
          {allConfigured.length} of {totalCities} cities
        </span>
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
        return (
          <div
            key={city}
            style={{
              padding: "14px 16px",
              border: "1px dashed var(--sb-border)",
              borderRadius: "var(--sb-radius)",
              marginBottom: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              fontSize: 13,
              color: "var(--sb-muted)",
            }}
          >
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
        );
      })}

      {/* Unconfigured cities */}
      {unconfiguredSelected.length > 0 && (
        <div className="sb-gov-upcoming">
          <p>
            Digests not yet available for:{" "}
            {unconfiguredSelected.map(cityLabel).join(", ")}.
            {" "}Currently covering:{" "}
            {allConfigured.length > 0
              ? allConfigured.map(cityLabel).join(", ")
              : "—"}
          </p>
        </div>
      )}

      {/* ── Police Blotter ── */}
      {visibleBlotterCities.length > 0 && (
        <>
          <div className="sb-section-header" style={{ marginTop: 32, marginBottom: 4 }}>
            <span className="sb-section-title">Police Blotter</span>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--sb-muted)",
                background: "#F3F4F6",
                padding: "2px 8px",
                borderRadius: 3,
                letterSpacing: "0.03em",
              }}
            >
              calls for service
            </span>
          </div>
          <p
            style={{
              fontSize: 12,
              color: "var(--sb-muted)",
              marginTop: 0,
              marginBottom: 16,
              lineHeight: 1.5,
            }}
          >
            Recent police calls for service from public open data portals.
          </p>
          {visibleBlotterCities.map((city) => {
            const blotter = allBlotters[city];
            return blotter ? <BlotterCard key={city} blotter={blotter} /> : null;
          })}
        </>
      )}
    </>
  );
}
