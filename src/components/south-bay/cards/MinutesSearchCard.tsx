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

const CITY_ACCENT: Record<string, string> = {
  campbell:        "#1d4ed8",
  "los-gatos":     "#b45309",
  saratoga:        "#065F46",
  cupertino:       "#6d28d9",
  sunnyvale:       "#0891b2",
  "mountain-view": "#0369a1",
  "san-jose":      "#be123c",
  "santa-clara":   "#b45309",
  "palo-alto":     "#1d4ed8",
  milpitas:        "#4d7c0f",
  "los-altos":     "#7c3aed",
};

// Chip = shortcut: label shown + query sent + optional topic filter
const QUICK_CHIPS = [
  { label: "🏠 Housing",     q: "housing zoning development",   topic: "Housing & Zoning" },
  { label: "💰 Budget",      q: "budget funding spending",       topic: "Budget" },
  { label: "🚗 Traffic",     q: "traffic roads infrastructure",  topic: "Infrastructure" },
  { label: "🌳 Parks",       q: "parks recreation open space",   topic: "Parks & Recreation" },
  { label: "🏙️ Downtown",   q: "downtown development retail",   topic: "Downtown Development" },
  { label: "🔒 Safety",      q: "public safety police crime",    topic: "Public Safety" },
];

const SUGGESTED_QUESTIONS = [
  "What's the city doing about affordable housing?",
  "Any new parks or trails being planned?",
  "How is the city spending its budget?",
  "What road projects are approved?",
  "Any downtown development in the works?",
];

function formatDate(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function abbrevType(t: string): string {
  if (/city council/i.test(t)) return "City Council";
  if (/planning/i.test(t)) return "Planning";
  if (/parks/i.test(t)) return "Parks & Rec";
  if (/transportation/i.test(t)) return "Transportation";
  if (/budget/i.test(t)) return "Budget";
  if (/public safety/i.test(t)) return "Public Safety";
  return t;
}

// City name lookup from Stoa city string (e.g. "Campbell" → "campbell" key)
function cityIdFromName(name: string): string {
  const entry = Object.entries(CITY_NAME_MAP).find(
    ([, n]) => n.toLowerCase() === name.toLowerCase()
  );
  return entry?.[0] ?? "";
}

interface Props {
  homeCity: string | null;
  selectedCities: Set<string>;
}

export default function MinutesSearchCard({ homeCity, selectedCities }: Props) {
  const [query, setQuery] = useState("");
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const [results, setResults] = useState<CouncilRecord[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const cityParam = (() => {
    if (homeCity) return CITY_NAME_MAP[homeCity] ?? null;
    const names = [...selectedCities].map((id) => CITY_NAME_MAP[id]).filter(Boolean);
    return names.length > 0 ? names.join(",") : null;
  })();

  const cityLabel = homeCity ? (CITY_NAME_MAP[homeCity] ?? "All Cities") : "All Cities";

  const doSearch = async (q: string, topic?: string) => {
    const hasQuery = q.trim().length >= 2;
    const hasTopic = !!topic;
    if (!hasQuery && !hasTopic) {
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
      if (topic && topic !== "All Topics") params.set("topic", topic);
      const res = await fetch(`https://www.stoa.works/api/council-meetings?${params.toString()}`);
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

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (activeChip) return; // chip search already fired directly
    debounceRef.current = setTimeout(() => {
      doSearch(query);
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const handleChip = (chip: typeof QUICK_CHIPS[0]) => {
    if (activeChip === chip.label) {
      // deselect
      setActiveChip(null);
      setQuery("");
      setResults(null);
      setTotal(null);
    } else {
      setActiveChip(chip.label);
      setQuery("");
      doSearch(chip.q, chip.topic);
    }
  };

  const handleSuggestion = (s: string) => {
    setActiveChip(null);
    setQuery(s);
    inputRef.current?.focus();
    doSearch(s);
  };

  const showEmpty = results === null && !loading && !error;
  const showSuggestions = showEmpty && !focused && query === "";

  return (
    <div style={{ marginBottom: 28 }}>
      {/* Header */}
      <div className="sb-section-header" style={{ marginBottom: 14 }}>
        <span className="sb-section-title">Ask the Records</span>
        <div className="sb-section-line" />
      </div>

      {/* Subhead */}
      <p style={{
        margin: "0 0 14px",
        fontSize: 13,
        color: "var(--sb-muted)",
        lineHeight: 1.5,
      }}>
        Search 6,400+ city council records from 11 South Bay cities — agendas, decisions, meeting minutes, and YouTube transcripts. Powered by{" "}
        <a href="https://stoa.works" target="_blank" rel="noopener noreferrer"
          style={{ color: "var(--sb-accent)", textDecoration: "none", fontWeight: 600 }}>
          Stoa
        </a>.
      </p>

      {/* Search input */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 10,
        background: "#fff",
        border: `1.5px solid ${focused ? "var(--sb-ink)" : "var(--sb-border)"}`,
        borderRadius: 8,
        padding: "2px 4px 2px 12px",
        transition: "border-color 0.15s",
      }}>
        <span style={{ fontSize: 16, flexShrink: 0 }}>🔍</span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveChip(null); }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={`What's ${cityLabel} doing about…`}
          style={{
            flex: 1,
            fontSize: 14,
            padding: "8px 4px",
            border: "none",
            outline: "none",
            fontFamily: "inherit",
            color: "var(--sb-ink)",
            background: "transparent",
          }}
        />
        {(query || activeChip) && (
          <button
            onClick={() => { setQuery(""); setActiveChip(null); setResults(null); setTotal(null); }}
            style={{
              background: "none", border: "none", cursor: "pointer",
              fontSize: 16, color: "var(--sb-muted)", padding: "4px 8px",
              lineHeight: 1,
            }}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {/* Quick topic chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {QUICK_CHIPS.map((chip) => {
          const isActive = activeChip === chip.label;
          return (
            <button
              key={chip.label}
              onClick={() => handleChip(chip)}
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "4px 10px",
                borderRadius: 100,
                border: `1.5px solid ${isActive ? "var(--sb-ink)" : "var(--sb-border)"}`,
                background: isActive ? "var(--sb-ink)" : "transparent",
                color: isActive ? "#fff" : "var(--sb-muted)",
                cursor: "pointer",
                transition: "all 0.15s",
                whiteSpace: "nowrap",
              }}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {/* Suggested questions (idle state) */}
      {showSuggestions && (
        <div style={{
          border: "1px solid var(--sb-border-light)",
          borderRadius: 8,
          overflow: "hidden",
          marginBottom: 4,
        }}>
          <div style={{
            padding: "6px 12px",
            background: "var(--sb-light, #f8f8f5)",
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            color: "var(--sb-muted)",
            fontFamily: "'Space Mono', monospace",
          }}>
            Try asking
          </div>
          {SUGGESTED_QUESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => handleSuggestion(s)}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "9px 12px",
                background: "none", border: "none", borderTop: "1px solid var(--sb-border-light)",
                fontSize: 13, color: "var(--sb-ink)", cursor: "pointer",
                fontFamily: "inherit",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--sb-light, #f8f8f5)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--sb-muted)", fontSize: 13, padding: "8px 0" }}>
          <div className="sb-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
          Searching records…
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div style={{ fontSize: 13, color: "var(--sb-accent)", padding: "8px 0" }}>{error}</div>
      )}

      {/* Results */}
      {!loading && !error && results !== null && (
        <>
          <div style={{
            fontSize: 11, color: "var(--sb-muted)", marginBottom: 10,
            fontFamily: "'Space Mono', monospace",
          }}>
            {results.length} record{results.length !== 1 ? "s" : ""}
            {total !== null && total > results.length ? ` of ${total}` : ""}
          </div>

          {results.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--sb-muted)", margin: 0 }}>
              No records matched — try different terms or remove a filter.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {results.map((rec, i) => (
                <ResultCard
                  key={`${rec.id}-${i}`}
                  record={rec}
                  isLast={i === results.length - 1}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ResultCard({ record, isLast }: { record: CouncilRecord; isLast: boolean }) {
  const cityId = cityIdFromName(record.city);
  const accent = CITY_ACCENT[cityId] ?? "var(--sb-primary)";
  const truncExcerpt =
    record.excerpt && record.excerpt.length > 160
      ? record.excerpt.slice(0, 157) + "…"
      : record.excerpt;

  return (
    <div style={{
      padding: "12px 0",
      borderBottom: isLast ? "none" : "1px solid var(--sb-border-light)",
    }}>
      {/* Meta row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5, flexWrap: "wrap" }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 3,
          background: accent + "18", color: accent,
          letterSpacing: "0.04em",
        }}>
          {record.city.toUpperCase()}
        </span>
        <span style={{ fontSize: 10, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace" }}>
          {formatDate(record.date)}
        </span>
        <span style={{ fontSize: 10, color: "var(--sb-border)" }}>·</span>
        <span style={{ fontSize: 10, color: "var(--sb-muted)" }}>
          {abbrevType(record.meetingType)}
        </span>
        {record.topic && record.topic !== "General" && (
          <>
            <span style={{ fontSize: 10, color: "var(--sb-border)" }}>·</span>
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: "0.04em",
              color: accent, background: accent + "12",
              padding: "1px 5px", borderRadius: 3,
            }}>
              {record.topic}
            </span>
          </>
        )}
      </div>

      {/* Excerpt */}
      {truncExcerpt && (
        <div style={{ fontSize: 12, color: "var(--sb-muted)", lineHeight: 1.5 }}>
          {truncExcerpt}
        </div>
      )}
    </div>
  );
}
