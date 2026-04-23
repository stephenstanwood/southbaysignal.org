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

const QUICK_CHIPS = [
  { label: "🏠 Housing",   q: "housing zoning development",  topic: "Housing & Zoning" },
  { label: "💰 Budget",    q: "budget funding spending",      topic: "Budget" },
  { label: "🚗 Traffic",   q: "traffic roads infrastructure", topic: "Infrastructure" },
  { label: "🌳 Parks",     q: "parks recreation open space",  topic: "Parks & Recreation" },
  { label: "🏙️ Downtown", q: "downtown development retail",  topic: "Downtown Development" },
  { label: "🔒 Safety",    q: "public safety police crime",   topic: "Public Safety" },
];

const CONVERSATION_STARTERS = [
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

function cityIdFromName(name: string): string {
  const entry = Object.entries(CITY_NAME_MAP).find(
    ([, n]) => n.toLowerCase() === name.toLowerCase()
  );
  return entry?.[0] ?? "";
}

interface Props {
  selectedCities: Set<string>;
}

interface ChatTurn {
  question: string;
  results: CouncilRecord[] | null;
  total: number | null;
  error: string | null;
}

export default function MinutesSearchCard({ selectedCities }: Props) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const cityParam = (() => {
    const names = [...selectedCities].map((id) => CITY_NAME_MAP[id]).filter(Boolean);
    return names.length > 0 ? names.join(",") : null;
  })();

  const cityLabel = "your city";

  const doSearch = async (q: string, topic?: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2 && !topic) return;

    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (cityParam) params.set("city", cityParam);
      if (trimmed.length >= 2) params.set("q", trimmed);
      if (topic && topic !== "All Topics") params.set("topic", topic);
      const res = await fetch(`https://www.stoa.works/api/council-meetings?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const records: CouncilRecord[] = data.records ?? [];
      const total: number | null = data.total ?? data.count ?? null;
      setHistory((prev) => [...prev, { question: q, results: records, total, error: null }]);
    } catch {
      setHistory((prev) => [...prev, { question: q, results: null, total: null, error: "Search unavailable — try again" }]);
    } finally {
      setLoading(false);
      setQuery("");
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 100);
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (query.trim().length >= 2 && !loading) doSearch(query);
  };

  const handleStarter = (s: string) => {
    setQuery(s);
    doSearch(s);
    inputRef.current?.focus();
  };

  const handleChip = (chip: typeof QUICK_CHIPS[0]) => {
    doSearch(chip.label, chip.topic);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSubmit();
  };

  const hasHistory = history.length > 0;

  return (
    <div style={{ marginBottom: 28 }}>
      {/* Header */}
      <div className="sb-section-header" style={{ marginBottom: 14 }}>
        <span className="sb-section-title">Ask the Records</span>
        <div className="sb-section-line" />
      </div>

      {/* Chat window */}
      <div style={{
        border: "1px solid var(--sb-border-light)",
        borderRadius: 10,
        overflow: "hidden",
        background: "#fafaf8",
      }}>

        {/* Messages area */}
        <div style={{ padding: "16px 16px 0", minHeight: hasHistory ? 0 : undefined }}>

          {/* Greeting / idle state */}
          {!hasHistory && !loading && (
            <div style={{ paddingBottom: 16 }}>
              <div style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                marginBottom: 14,
              }}>
                <div style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: "var(--sb-ink)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  flexShrink: 0,
                  marginTop: 1,
                }}>
                  🏛️
                </div>
                <div style={{
                  background: "#fff",
                  border: "1px solid var(--sb-border-light)",
                  borderRadius: "4px 12px 12px 12px",
                  padding: "10px 14px",
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: "var(--sb-ink)",
                  maxWidth: 420,
                }}>
                  Ask me anything about {cityLabel}'s city council — housing decisions, road projects, budget votes, planning approvals. I search 5,700+ records from 11 South Bay cities.{" "}
                  <span style={{ color: "var(--sb-muted)", fontSize: 12 }}>
                    Powered by{" "}
                    <a href="https://stoa.works" target="_blank" rel="noopener noreferrer"
                      style={{ color: "var(--sb-accent)", textDecoration: "none", fontWeight: 600 }}>
                      Stoa
                    </a>.
                  </span>
                </div>
              </div>

              {/* Conversation starters */}
              <div style={{ paddingLeft: 38, display: "flex", flexDirection: "column", gap: 6, marginBottom: 4 }}>
                {CONVERSATION_STARTERS.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleStarter(s)}
                    style={{
                      textAlign: "left",
                      background: "#fff",
                      border: "1px solid var(--sb-border)",
                      borderRadius: 20,
                      padding: "7px 14px",
                      fontSize: 12,
                      color: "var(--sb-ink)",
                      cursor: "pointer",
                      transition: "border-color 0.1s, background 0.1s",
                      alignSelf: "flex-start",
                      lineHeight: 1.3,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "var(--sb-ink)";
                      e.currentTarget.style.background = "#f5f5f2";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "var(--sb-border)";
                      e.currentTarget.style.background = "#fff";
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Chat history */}
          {history.map((turn, i) => (
            <div key={i} style={{ marginBottom: 16 }}>
              {/* User bubble */}
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
                <div style={{
                  background: "var(--sb-ink)",
                  color: "#fff",
                  borderRadius: "12px 4px 12px 12px",
                  padding: "9px 14px",
                  fontSize: 13,
                  lineHeight: 1.45,
                  maxWidth: "80%",
                }}>
                  {turn.question}
                </div>
              </div>

              {/* Response bubble */}
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <div style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: "var(--sb-ink)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  flexShrink: 0,
                  marginTop: 1,
                }}>
                  🏛️
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {turn.error ? (
                    <div style={{
                      background: "#fff",
                      border: "1px solid var(--sb-border-light)",
                      borderRadius: "4px 12px 12px 12px",
                      padding: "10px 14px",
                      fontSize: 13,
                      color: "var(--sb-accent)",
                    }}>
                      {turn.error}
                    </div>
                  ) : turn.results !== null && turn.results.length === 0 ? (
                    <div style={{
                      background: "#fff",
                      border: "1px solid var(--sb-border-light)",
                      borderRadius: "4px 12px 12px 12px",
                      padding: "10px 14px",
                      fontSize: 13,
                      color: "var(--sb-muted)",
                      lineHeight: 1.5,
                    }}>
                      No records matched that query. Try different words or a broader topic.
                    </div>
                  ) : turn.results !== null ? (
                    <div>
                      <div style={{
                        background: "#fff",
                        border: "1px solid var(--sb-border-light)",
                        borderRadius: "4px 12px 12px 12px",
                        padding: "10px 14px",
                        fontSize: 13,
                        color: "var(--sb-muted)",
                        lineHeight: 1.5,
                        marginBottom: 8,
                      }}>
                        Found{" "}
                        <strong style={{ color: "var(--sb-ink)" }}>
                          {turn.total !== null && turn.total > turn.results.length
                            ? `${turn.total.toLocaleString()} records`
                            : `${turn.results.length} record${turn.results.length !== 1 ? "s" : ""}`}
                        </strong>{" "}
                        across city council minutes, agendas, and transcripts.
                        {turn.total !== null && turn.total > turn.results.length && (
                          <> Showing top {turn.results.length}.</>
                        )}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                        {turn.results.map((rec, j) => (
                          <ResultCard
                            key={`${rec.id}-${j}`}
                            record={rec}
                            isLast={j === turn.results!.length - 1}
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ))}

          {/* Loading */}
          {loading && (
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 16 }}>
              <div style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: "var(--sb-ink)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                flexShrink: 0,
              }}>
                🏛️
              </div>
              <div style={{
                background: "#fff",
                border: "1px solid var(--sb-border-light)",
                borderRadius: "4px 12px 12px 12px",
                padding: "10px 14px",
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "var(--sb-muted)",
                fontSize: 13,
              }}>
                <div className="sb-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                Searching records…
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Topic chips */}
        {!loading && (
          <div style={{
            padding: "8px 16px",
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            borderTop: "1px solid var(--sb-border-light)",
            background: "#fff",
          }}>
            {QUICK_CHIPS.map((chip) => (
              <button
                key={chip.label}
                onClick={() => handleChip(chip)}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "3px 10px",
                  borderRadius: 100,
                  border: "1.5px solid var(--sb-border)",
                  background: "transparent",
                  color: "var(--sb-muted)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  transition: "all 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--sb-ink)";
                  e.currentTarget.style.color = "var(--sb-ink)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--sb-border)";
                  e.currentTarget.style.color = "var(--sb-muted)";
                }}
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}

        {/* Input bar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          borderTop: "1px solid var(--sb-border-light)",
          background: "#fff",
        }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={`Ask about ${cityLabel}'s city council…`}
            style={{
              flex: 1,
              fontSize: 13,
              padding: "8px 10px",
              border: `1.5px solid ${focused ? "var(--sb-ink)" : "var(--sb-border-light)"}`,
              borderRadius: 20,
              outline: "none",
              fontFamily: "inherit",
              color: "var(--sb-ink)",
              background: "#fafaf8",
              transition: "border-color 0.15s",
            }}
          />
          <button
            onClick={() => handleSubmit()}
            disabled={query.trim().length < 2 || loading}
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              background: query.trim().length >= 2 && !loading ? "var(--sb-ink)" : "var(--sb-border-light)",
              border: "none",
              cursor: query.trim().length >= 2 && !loading ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 15,
              color: query.trim().length >= 2 && !loading ? "#fff" : "var(--sb-muted)",
              transition: "all 0.15s",
              flexShrink: 0,
            }}
            aria-label="Send"
          >
            ↑
          </button>
        </div>
      </div>
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
      paddingLeft: 38,
    }}>
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
      {truncExcerpt && (
        <div style={{ fontSize: 12, color: "var(--sb-muted)", lineHeight: 1.5 }}>
          {truncExcerpt}
        </div>
      )}
    </div>
  );
}
