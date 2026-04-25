import { useState, useRef } from "react";

interface Citation {
  city: string;
  date: string;
  meetingType: string;
  topic: string;
  excerpt: string;
}

interface AskResponse {
  answer: string;
  followups: string[];
  citations: Citation[];
  totalRecords: number;
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

// Display in a friendly geographic-ish order so the dropdown reads naturally.
const CITY_ORDER = [
  "san-jose", "santa-clara", "sunnyvale", "mountain-view", "palo-alto",
  "los-altos", "cupertino", "campbell", "saratoga", "los-gatos", "milpitas",
];

const STARTERS: { label: string; q: string }[] = [
  { label: "What's happening with housing?",       q: "affordable housing units" },
  { label: "Any new parks or trails?",             q: "parks recreation" },
  { label: "Where's the budget going?",            q: "budget appropriation" },
  { label: "What road projects are approved?",     q: "traffic roads" },
  { label: "Any downtown development in the works?", q: "downtown development" },
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
  return t;
}

interface ChatTurn {
  question: string;
  city: string; // city id at time of question
  answer: string | null;
  followups: string[];
  citations: Citation[];
  totalRecords: number;
  error: string | null;
  showSources: boolean;
}

interface Props {
  selectedCities: Set<string>;
}

export default function MinutesSearchCard({ selectedCities }: Props) {
  // Default the picker to whichever city is most useful: if exactly one is in
  // the global filter, use it; otherwise leave empty so the user must choose.
  const initialCity = (() => {
    const ids = [...selectedCities].filter((id) => id in CITY_NAME_MAP);
    if (ids.length === 1) return ids[0];
    return "";
  })();

  const [city, setCity] = useState<string>(initialCity);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const cityName = city ? CITY_NAME_MAP[city] : "";
  const cityAccent = city ? CITY_ACCENT[city] : "var(--sb-ink)";
  const canSubmit = !!city && query.trim().length >= 2 && !loading;

  const ask = async (display: string, searchQuery: string) => {
    if (!city) return;
    const turn: ChatTurn = {
      question: display,
      city,
      answer: null,
      followups: [],
      citations: [],
      totalRecords: 0,
      error: null,
      showSources: false,
    };
    setHistory((h) => [...h, turn]);
    setLoading(true);
    setQuery("");

    try {
      const res = await fetch("/api/south-bay/ask-records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city, query: searchQuery }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data: AskResponse = await res.json();
      setHistory((h) => {
        const next = [...h];
        const last = next[next.length - 1];
        last.answer = data.answer;
        last.followups = data.followups ?? [];
        last.citations = data.citations ?? [];
        last.totalRecords = data.totalRecords ?? 0;
        return next;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setHistory((h) => {
        const next = [...h];
        next[next.length - 1].error = msg;
        return next;
      });
    } finally {
      setLoading(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 80);
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    const q = query.trim();
    ask(q, q);
  };

  const handleStarter = (s: { label: string; q: string }) => {
    if (!city) {
      inputRef.current?.focus();
      return;
    }
    ask(s.label, s.q);
  };

  // Toggle the "show sources" panel for a given turn.
  const toggleSources = (i: number) => {
    setHistory((h) => h.map((t, j) => (j === i ? { ...t, showSources: !t.showSources } : t)));
  };

  // Reset chat when city changes — keeps the model from confusing scopes.
  const onCityChange = (newCity: string) => {
    setCity(newCity);
    setHistory([]);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const hasHistory = history.length > 0;

  return (
    <div style={{ marginBottom: 28 }}>
      {/* Header */}
      <div className="sb-section-header" style={{ marginBottom: 14 }}>
        <span className="sb-section-title">Ask the Records</span>
        <div className="sb-section-line" />
      </div>

      <div style={{
        border: "1px solid var(--sb-border-light)",
        borderRadius: 10,
        overflow: "hidden",
        background: "#fafaf8",
      }}>

        {/* City picker — always visible at the top of the card */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          background: "#fff",
          borderBottom: "1px solid var(--sb-border-light)",
          flexWrap: "wrap",
        }}>
          <span style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--sb-muted)",
            fontFamily: "'Space Mono', monospace",
          }}>
            City
          </span>
          <div style={{
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            border: `1.5px solid ${city ? cityAccent : "var(--sb-accent)"}`,
            borderRadius: 6,
            background: city ? cityAccent + "10" : "#fff",
            padding: "0 28px 0 10px",
          }}>
            <select
              value={city}
              onChange={(e) => onCityChange(e.target.value)}
              style={{
                appearance: "none",
                background: "transparent",
                border: "none",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 700,
                color: city ? cityAccent : "var(--sb-accent)",
                padding: "6px 0",
                cursor: "pointer",
                outline: "none",
              }}
            >
              <option value="">Pick one…</option>
              {CITY_ORDER.map((id) => (
                <option key={id} value={id}>{CITY_NAME_MAP[id]}</option>
              ))}
            </select>
            <span style={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              fontSize: 10,
              color: city ? cityAccent : "var(--sb-accent)",
              pointerEvents: "none",
            }}>▾</span>
          </div>
          {!city && (
            <span style={{ fontSize: 11, color: "var(--sb-accent)", fontWeight: 600 }}>
              ← pick one to start
            </span>
          )}
          {city && hasHistory && (
            <button
              onClick={() => { setHistory([]); inputRef.current?.focus(); }}
              style={{
                marginLeft: "auto",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--sb-muted)",
                background: "transparent",
                border: "1px solid var(--sb-border)",
                borderRadius: 100,
                padding: "3px 10px",
                cursor: "pointer",
              }}
            >
              clear
            </button>
          )}
        </div>

        {/* Messages area */}
        <div style={{ padding: "16px 16px 0" }}>

          {/* Greeting — shown until the first question lands */}
          {!hasHistory && !loading && (
            <BotBubble city={city}>
              {city ? (
                <>
                  Hi! I read every recent <strong>{cityName}</strong> council meeting,
                  agenda, and transcript so you don't have to. Ask me anything —
                  budget moves, housing votes, what's getting built, who showed up
                  to public comment. I'll answer in plain English and link the meetings
                  I'm pulling from.
                </>
              ) : (
                <>
                  Hi! 👋 I dig through council meetings, agendas, and transcripts
                  for the South Bay's 11 cities and answer in plain English. Pick a
                  city up top and ask me anything — budgets, housing, parks, who
                  voted what, what's being built.
                </>
              )}
            </BotBubble>
          )}

          {/* Starter chips (always under greeting before first ask) */}
          {!hasHistory && !loading && (
            <div style={{ paddingLeft: 38, display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {STARTERS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => handleStarter(s)}
                  disabled={!city}
                  style={{
                    textAlign: "left",
                    background: city ? "#fff" : "#f5f5f2",
                    border: "1px solid var(--sb-border)",
                    borderRadius: 20,
                    padding: "7px 14px",
                    fontSize: 12,
                    color: city ? "var(--sb-ink)" : "var(--sb-light)",
                    cursor: city ? "pointer" : "not-allowed",
                    transition: "border-color 0.1s, background 0.1s",
                    alignSelf: "flex-start",
                    lineHeight: 1.3,
                  }}
                  onMouseEnter={(e) => {
                    if (!city) return;
                    e.currentTarget.style.borderColor = "var(--sb-ink)";
                    e.currentTarget.style.background = "#f5f5f2";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--sb-border)";
                    e.currentTarget.style.background = city ? "#fff" : "#f5f5f2";
                  }}
                >
                  {s.label}
                </button>
              ))}
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

              {/* Bot response */}
              <BotBubble city={turn.city}>
                {turn.error ? (
                  <span style={{ color: "var(--sb-accent)" }}>{turn.error}</span>
                ) : turn.answer === null ? (
                  <span style={{ color: "var(--sb-muted)", fontStyle: "italic" }}>
                    Reading {CITY_NAME_MAP[turn.city]} meetings…
                  </span>
                ) : (
                  <>
                    <div style={{ whiteSpace: "pre-wrap" }}>{turn.answer}</div>

                    {turn.citations.length > 0 && (
                      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <button
                          onClick={() => toggleSources(i)}
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: "var(--sb-muted)",
                            background: "transparent",
                            border: "1px solid var(--sb-border)",
                            borderRadius: 100,
                            padding: "3px 10px",
                            cursor: "pointer",
                            fontFamily: "'Space Mono', monospace",
                          }}
                        >
                          {turn.showSources ? "▴ hide sources" : `▾ ${turn.totalRecords > turn.citations.length ? `top ${turn.citations.length} of ${turn.totalRecords}` : `${turn.citations.length}`} source${turn.citations.length === 1 ? "" : "s"}`}
                        </button>
                      </div>
                    )}

                    {turn.showSources && turn.citations.length > 0 && (
                      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 0 }}>
                        {turn.citations.map((c, j) => (
                          <SourceRow key={j} citation={c} isLast={j === turn.citations.length - 1} />
                        ))}
                      </div>
                    )}

                    {turn.followups.length > 0 && i === history.length - 1 && !loading && (
                      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 5 }}>
                        <div style={{
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: "0.12em",
                          textTransform: "uppercase",
                          color: "var(--sb-muted)",
                          fontFamily: "'Space Mono', monospace",
                          marginBottom: 2,
                        }}>
                          Try next
                        </div>
                        {turn.followups.map((f) => (
                          <button
                            key={f}
                            onClick={() => ask(f, f)}
                            style={{
                              textAlign: "left",
                              background: "transparent",
                              border: "1px solid var(--sb-border)",
                              borderRadius: 20,
                              padding: "5px 12px",
                              fontSize: 12,
                              color: "var(--sb-ink)",
                              cursor: "pointer",
                              alignSelf: "flex-start",
                              lineHeight: 1.3,
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.borderColor = "var(--sb-ink)";
                              e.currentTarget.style.background = "#f5f5f2";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.borderColor = "var(--sb-border)";
                              e.currentTarget.style.background = "transparent";
                            }}
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </BotBubble>
            </div>
          ))}

          {/* Loading shimmer (only if no in-flight turn already shows it) */}
          {loading && history[history.length - 1]?.answer !== null && (
            <BotBubble city={city}>
              <span style={{ color: "var(--sb-muted)", display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span className="sb-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                Reading {cityName} meetings…
              </span>
            </BotBubble>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <form
          onSubmit={handleSubmit}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderTop: "1px solid var(--sb-border-light)",
            background: "#fff",
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={city ? `Ask about ${cityName}…` : "Pick a city first ↑"}
            disabled={!city || loading}
            style={{
              flex: 1,
              fontSize: 13,
              padding: "8px 10px",
              border: `1.5px solid var(--sb-border-light)`,
              borderRadius: 20,
              outline: "none",
              fontFamily: "inherit",
              color: "var(--sb-ink)",
              background: city ? "#fafaf8" : "#f0efec",
              transition: "border-color 0.15s",
            }}
          />
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              background: canSubmit ? "var(--sb-ink)" : "var(--sb-border-light)",
              border: "none",
              cursor: canSubmit ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 15,
              color: canSubmit ? "#fff" : "var(--sb-muted)",
              transition: "all 0.15s",
              flexShrink: 0,
            }}
            aria-label="Send"
          >
            ↑
          </button>
        </form>
      </div>

      <p style={{ fontSize: 10, color: "var(--sb-muted)", marginTop: 8, marginBottom: 0, lineHeight: 1.5 }}>
        Answers generated from real council records via{" "}
        <a href="https://stoa.works" target="_blank" rel="noopener noreferrer"
          style={{ color: "var(--sb-accent)", textDecoration: "none", fontWeight: 600 }}>
          Stoa
        </a>. Always double-check before quoting.
      </p>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function BotBubble({ city, children }: { city: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 14 }}>
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
        flex: 1,
        minWidth: 0,
      }}>
        {children}
      </div>
    </div>
  );
}

function SourceRow({ citation, isLast }: { citation: Citation; isLast: boolean }) {
  // Resolve city name back to id for the accent color.
  const cityEntry = Object.entries(CITY_NAME_MAP).find(
    ([, n]) => n.toLowerCase() === citation.city.toLowerCase(),
  );
  const accent = cityEntry ? CITY_ACCENT[cityEntry[0]] ?? "var(--sb-primary)" : "var(--sb-primary)";

  return (
    <div style={{
      padding: "10px 0",
      borderBottom: isLast ? "none" : "1px dashed var(--sb-border-light)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3,
          background: accent + "18", color: accent,
          letterSpacing: "0.04em",
        }}>
          {citation.city.toUpperCase()}
        </span>
        <span style={{ fontSize: 9, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace" }}>
          {formatDate(citation.date)}
        </span>
        <span style={{ fontSize: 9, color: "var(--sb-border)" }}>·</span>
        <span style={{ fontSize: 9, color: "var(--sb-muted)" }}>
          {abbrevType(citation.meetingType)}
        </span>
        {citation.topic && citation.topic !== "General" && (
          <>
            <span style={{ fontSize: 9, color: "var(--sb-border)" }}>·</span>
            <span style={{ fontSize: 9, fontWeight: 600, color: accent }}>{citation.topic}</span>
          </>
        )}
      </div>
      {citation.excerpt && (
        <div style={{ fontSize: 11, color: "var(--sb-muted)", lineHeight: 1.5 }}>
          {citation.excerpt}
        </div>
      )}
    </div>
  );
}
