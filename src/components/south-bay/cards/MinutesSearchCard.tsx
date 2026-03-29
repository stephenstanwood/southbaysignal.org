import { useState, useEffect, useRef } from "react";

interface CouncilRecord {
  id: string | number;
  city: string;
  date: string;
  meetingType: string;
  topic: string;
  title: string;
  excerpt: string;
  keywords: string[];
}

// Map SBS cityId → Stoa city name
const CITY_NAME_MAP: Record<string, string> = {
  campbell: "Campbell",
  "los-gatos": "Los Gatos",
  saratoga: "Saratoga",
  cupertino: "Cupertino",
  sunnyvale: "Sunnyvale",
  "mountain-view": "Mountain View",
  "san-jose": "San Jose",
  "santa-clara": "Santa Clara",
  "palo-alto": "Palo Alto",
  milpitas: "Milpitas",
  "los-altos": "Los Altos",
};

const TOPICS = [
  "All Topics",
  "Housing & Zoning",
  "Budget",
  "Infrastructure",
  "Parks & Recreation",
  "Downtown Development",
  "Environment & Safety",
];

const MEETING_TYPES = [
  "All Types",
  "City Council",
  "Planning Commission",
  "Parks & Recreation Commission",
  "Transportation Commission",
  "Budget Committee",
  "Public Safety Committee",
];

function formatDate(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function abbreviateMeetingType(t: string): string {
  if (t.toLowerCase().includes("city council")) return "City Council";
  if (t.toLowerCase().includes("planning")) return "Planning";
  if (t.toLowerCase().includes("parks")) return "Parks & Rec";
  if (t.toLowerCase().includes("transportation")) return "Transportation";
  if (t.toLowerCase().includes("budget")) return "Budget";
  if (t.toLowerCase().includes("public safety")) return "Public Safety";
  return t;
}

interface Props {
  homeCity: string | null;
  selectedCities: Set<string>;
}

export default function MinutesSearchCard({ homeCity, selectedCities }: Props) {
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("All Topics");
  const [meetingType, setMeetingType] = useState("All Types");
  const [results, setResults] = useState<CouncilRecord[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derive city param from homeCity or selectedCities
  const cityParam = (() => {
    if (homeCity) {
      return CITY_NAME_MAP[homeCity] ?? null;
    }
    const names = [...selectedCities]
      .map((id) => CITY_NAME_MAP[id])
      .filter(Boolean);
    return names.length > 0 ? names.join(",") : null;
  })();

  // City badge label
  const cityBadgeLabel = (() => {
    if (homeCity && CITY_NAME_MAP[homeCity]) return CITY_NAME_MAP[homeCity];
    if (selectedCities.size > 0) return "All Selected Cities";
    return "All Cities";
  })();

  const doSearch = async (q: string, t: string, mt: string) => {
    const hasQuery = q.trim().length >= 2;
    const hasFilter = t !== "All Topics" || mt !== "All Types";
    if (!hasQuery && !hasFilter) {
      setResults(null);
      setTotal(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ limit: "20" });
      if (cityParam) params.set("city", cityParam);
      if (q.trim().length >= 2) params.set("q", q.trim());
      if (t !== "All Topics") params.set("topic", t);
      if (mt !== "All Types") params.set("type", mt);

      const res = await fetch(`https://stoa.works/api/council-meetings?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResults(data.records ?? []);
      setTotal(data.total ?? data.count ?? null);
    } catch {
      setError("Search unavailable — try again");
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  // Debounce query changes
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doSearch(query, topic, meetingType);
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, topic, meetingType]);

  const showEmpty = results === null && !loading && !error;

  return (
    <div style={{ marginBottom: 28 }}>
      {/* Section header */}
      <div className="sb-section-header" style={{ marginBottom: 12 }}>
        <span className="sb-section-title">Search Council Records</span>
        <div className="sb-section-line" />
      </div>

      {/* Search controls */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {/* Row 1: text input + city badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search topics, projects, decisions…"
            style={{
              flex: 1,
              fontSize: 13,
              padding: "7px 10px",
              border: "1px solid var(--sb-border)",
              borderRadius: 4,
              outline: "none",
              fontFamily: "inherit",
              color: "var(--sb-ink)",
              background: "#fff",
            }}
          />
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--sb-muted)",
              background: "var(--sb-light, #f8f8f5)",
              border: "1px solid var(--sb-border)",
              borderRadius: 4,
              padding: "5px 9px",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {cityBadgeLabel}
          </span>
        </div>

        {/* Row 2: topic + type selects */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            style={{
              flex: 1,
              minWidth: 140,
              fontSize: 12,
              padding: "6px 8px",
              border: "1px solid var(--sb-border)",
              borderRadius: 4,
              background: "#fff",
              color: "var(--sb-ink)",
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {TOPICS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={meetingType}
            onChange={(e) => setMeetingType(e.target.value)}
            style={{
              flex: 1,
              minWidth: 140,
              fontSize: 12,
              padding: "6px 8px",
              border: "1px solid var(--sb-border)",
              borderRadius: 4,
              background: "#fff",
              color: "var(--sb-ink)",
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {MEETING_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--sb-muted)",
            fontSize: 13,
            padding: "8px 0",
          }}
        >
          <div className="sb-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
          Searching…
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div style={{ fontSize: 13, color: "var(--sb-accent)", padding: "8px 0" }}>
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && showEmpty && (
        <p style={{ fontSize: 12, color: "var(--sb-muted)", margin: 0, lineHeight: 1.5 }}>
          Search 6,404 records from 11 cities spanning 2021–present. Powered by{" "}
          <a
            href="https://stoa.works"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--sb-accent)", textDecoration: "none" }}
          >
            Stoa
          </a>
          .
        </p>
      )}

      {/* Results */}
      {!loading && !error && results !== null && (
        <>
          <div
            style={{
              fontSize: 11,
              color: "var(--sb-muted)",
              marginBottom: 10,
              fontFamily: "'Space Mono', monospace",
            }}
          >
            {results.length} result{results.length !== 1 ? "s" : ""}
            {total !== null && total > results.length && ` of ${total}`}
          </div>

          {results.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--sb-muted)", margin: 0 }}>
              No records matched your search.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {results.map((rec, i) => (
                <ResultRow key={`${rec.id}-${i}`} record={rec} isLast={i === results.length - 1} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ResultRow({ record, isLast }: { record: CouncilRecord; isLast: boolean }) {
  const truncTitle =
    record.title.length > 80 ? record.title.slice(0, 77) + "…" : record.title;
  const truncExcerpt =
    record.excerpt && record.excerpt.length > 150
      ? record.excerpt.slice(0, 147) + "…"
      : record.excerpt;

  return (
    <div
      style={{
        padding: "10px 0",
        borderBottom: isLast ? "none" : "1px solid var(--sb-border-light, #e5e7eb)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 3,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: "var(--sb-muted)",
            fontFamily: "'Space Mono', monospace",
          }}
        >
          {formatDate(record.date)}
        </span>
        <span style={{ fontSize: 10, color: "var(--sb-muted)" }}>·</span>
        <span
          style={{
            fontSize: 10,
            color: "var(--sb-muted)",
            fontFamily: "'Space Mono', monospace",
          }}
        >
          {abbreviateMeetingType(record.meetingType)}
        </span>
        {record.topic && (
          <>
            <span style={{ fontSize: 10, color: "var(--sb-muted)" }}>·</span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: "var(--sb-accent)",
                background: "#FEF2F2",
                padding: "1px 5px",
                borderRadius: 3,
              }}
            >
              {record.topic}
            </span>
          </>
        )}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--sb-ink)", marginBottom: 2 }}>
        {truncTitle}
      </div>
      {truncExcerpt && (
        <div style={{ fontSize: 12, color: "var(--sb-muted)", lineHeight: 1.45 }}>
          {truncExcerpt}
        </div>
      )}
    </div>
  );
}
