// ---------------------------------------------------------------------------
// South Bay Today — Day-Planning Homepage
// ---------------------------------------------------------------------------
// "What should we do today?" — list + card views with lock/skip/hide.
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback, useRef } from "react";
import type { City, Tab } from "../../../lib/south-bay/types";
import { CITIES, CITY_MAP } from "../../../lib/south-bay/cities";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DayCard {
  id: string;
  name: string;
  category: string;
  city: string;
  address: string;
  timeBlock: string;
  blurb: string;
  why: string;
  url?: string | null;
  mapsUrl?: string | null;
  cost?: string | null;
  costNote?: string | null;
  photoRef?: string | null;
  source: "event" | "place";
  locked: boolean;
}

interface PlanResponse {
  cards: DayCard[];
  weather: string | null;
  city: string;
  kids: boolean;
  generatedAt: string;
  poolSize: number;
}

type DismissType = "skip" | "hide";

interface DismissedEntry {
  type: DismissType;
  until?: string;
  permanent?: boolean;
}

interface LocalState {
  city: City;
  kids: boolean;
  dismissed: Record<string, DismissedEntry>;
  locked: string[];
  viewMode: "list" | "cards";
}

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

const ACCENT_COLORS = [
  "#FF6B35", "#E63946", "#06D6A0", "#7B2FBE", "#1A5AFF", "#FF3CAC",
];

const CATEGORY_EMOJI: Record<string, string> = {
  food: "🍽️", outdoor: "🌿", museum: "🏛️", entertainment: "🎭",
  wellness: "💆", shopping: "🛍️", arts: "🎨", events: "📅",
  sports: "⚾", neighborhood: "🏘️",
};

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------

const STORAGE_KEY = "sbt-prefs";

function loadState(): LocalState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const now = new Date().toISOString().slice(0, 10);
    for (const [id, entry] of Object.entries(parsed.dismissed ?? {})) {
      const d = entry as DismissedEntry;
      if (d.type === "skip" && d.until && d.until < now) delete parsed.dismissed[id];
    }
    return { ...defaultState(), ...parsed };
  } catch { return defaultState(); }
}

function defaultState(): LocalState {
  return { city: "campbell", kids: false, dismissed: {}, locked: [], viewMode: "list" };
}

function saveState(state: LocalState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  homeCity: City | null;
  setHomeCity: (city: City) => void;
  onNavigate: (tab: Tab) => void;
};

const FEATURED_CITIES: City[] = ["campbell", "los-gatos", "mountain-view", "san-jose", "palo-alto"];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SouthBayTodayView({ homeCity, setHomeCity }: Props) {
  const [state, setState] = useState<LocalState>(() => {
    const loaded = loadState();
    if (homeCity) loaded.city = homeCity;
    return loaded;
  });
  const [cards, setCards] = useState<DayCard[]>([]);
  const [weather, setWeather] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeDisplay, setTimeDisplay] = useState(() => formatTime());
  const [showMoreCities, setShowMoreCities] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [activeCard, setActiveCard] = useState(0);
  const fetchRef = useRef(0);

  useEffect(() => { saveState(state); }, [state]);
  useEffect(() => {
    if (homeCity && homeCity !== state.city) setState((s) => ({ ...s, city: homeCity }));
  }, [homeCity]);

  const fetchPlan = useCallback(async (cityOverride?: City) => {
    const id = ++fetchRef.current;
    setLoading(true);
    setError(null);
    setTimeDisplay(formatTime());
    const city = cityOverride || state.city;

    try {
      const res = await fetch("/api/plan-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city, kids: state.kids,
          lockedIds: state.locked,
          dismissedIds: Object.keys(state.dismissed),
          currentHour: new Date().getHours(),
        }),
      });
      if (id !== fetchRef.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data: PlanResponse = await res.json();
      setCards(data.cards.map((c) => ({ ...c, locked: state.locked.includes(c.id) })));
      setWeather(data.weather);
      setActiveCard(0);
    } catch (err) {
      if (id === fetchRef.current) setError(err instanceof Error ? err.message : "Failed to plan your day");
    } finally {
      if (id === fetchRef.current) setLoading(false);
    }
  }, [state.city, state.kids, state.dismissed, state.locked]);

  useEffect(() => { fetchPlan(); }, []);

  // Actions
  const handleCityChange = (city: City) => {
    setState((s) => ({ ...s, city }));
    setHomeCity(city);
    fetchPlan(city);
  };
  const handleKidsToggle = () => {
    setState((s) => ({ ...s, kids: !s.kids }));
    setTimeout(() => fetchPlan(), 50);
  };
  const handleReshuffle = () => fetchPlan();
  const handleGeolocate = () => {
    if (!navigator.geolocation) return;
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        let nearest: City = "campbell", minDist = Infinity;
        for (const c of CITIES) {
          const d = Math.sqrt((c.lat - pos.coords.latitude) ** 2 + (c.lon - pos.coords.longitude) ** 2);
          if (d < minDist) { minDist = d; nearest = c.id; }
        }
        setGeoLoading(false);
        handleCityChange(nearest);
      },
      () => setGeoLoading(false),
      { timeout: 8000 },
    );
  };
  const handleLock = (cardId: string) => {
    setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, locked: !c.locked } : c)));
    setState((s) => ({
      ...s,
      locked: s.locked.includes(cardId) ? s.locked.filter((id) => id !== cardId) : [...s.locked, cardId],
    }));
  };
  const handleDismiss = (cardId: string, type: DismissType) => {
    const entry: DismissedEntry = type === "hide"
      ? { type: "hide", permanent: true }
      : { type: "skip", until: new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) };
    setState((s) => {
      const next = {
        ...s,
        dismissed: { ...s.dismissed, [cardId]: entry },
        locked: s.locked.filter((id) => id !== cardId),
      };
      // Refetch plan with updated dismissals so a replacement fills the slot
      setTimeout(() => fetchPlan(), 50);
      return next;
    });
  };

  // Tomorrow mode: 6pm for kids, 8pm for adults
  const ptHour = Number(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }));
  const tomorrowCutoff = state.kids ? 18 : 20;
  const isTomorrowMode = ptHour >= tomorrowCutoff;
  const headline = isTomorrowMode ? "What should we do tomorrow?" : "What should we do today?";

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "0 16px 80px" }}>
      {/* Header */}
      <div className="sbt-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 0 10px", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <div className="sbt-time-display" style={{ fontFamily: "'Inter', sans-serif", fontSize: 48, fontWeight: 900, letterSpacing: -2, color: "#000", lineHeight: 1 }}>{timeDisplay}</div>
          <div>
            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 16, fontWeight: 700, color: "#333" }}>{headline}</div>
            {weather && <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: "#999", marginTop: 1 }}>{weather}</div>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Kids toggle */}
          <div style={{ display: "flex", borderRadius: 14, border: "2px solid #000", overflow: "hidden" }}>
            <button onClick={() => { if (state.kids) handleKidsToggle(); }} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, padding: "4px 10px", border: "none", background: !state.kids ? "#000" : "#fff", color: !state.kids ? "#fff" : "#888", cursor: "pointer", transition: "all 0.15s" }}>No Kids</button>
            <button onClick={() => { if (!state.kids) handleKidsToggle(); }} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, padding: "4px 10px", border: "none", borderLeft: "2px solid #000", background: state.kids ? "#000" : "#fff", color: state.kids ? "#fff" : "#888", cursor: "pointer", transition: "all 0.15s" }}>Kids</button>
          </div>
          {/* Reshuffle */}
          <button onClick={handleReshuffle} disabled={loading} style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 900, padding: "5px 16px", borderRadius: 14, border: "2.5px solid #000", background: loading ? "#eee" : "linear-gradient(135deg, #FF6B35, #E63946, #7B2FBE, #1A5AFF, #06D6A0, #FF3CAC)", color: loading ? "#999" : "#fff", cursor: loading ? "not-allowed" : "pointer", textTransform: "uppercase" as const, letterSpacing: 1, backgroundSize: "200% 200%", animation: loading ? "none" : "rainbow 3s ease infinite", whiteSpace: "nowrap" as const }}>{loading ? "Planning..." : "Reshuffle"}</button>
        </div>
      </div>

      {/* City pills */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 0 12px", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 600, color: "#bbb", marginRight: 2 }}>Starting in</span>
        {FEATURED_CITIES.map((id) => (
          <button key={id} onClick={() => handleCityChange(id)} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: state.city === id ? 800 : 500, padding: "4px 10px", borderRadius: 14, border: state.city === id ? "2px solid #000" : "1.5px solid #ddd", background: state.city === id ? "#000" : "#fff", color: state.city === id ? "#fff" : "#777", cursor: "pointer", transition: "all 0.15s" }}>{CITY_MAP[id].name}</button>
        ))}
        {showMoreCities ? (
          CITIES.filter((c) => !FEATURED_CITIES.includes(c.id)).map((c) => (
            <button key={c.id} onClick={() => { handleCityChange(c.id); setShowMoreCities(false); }} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: state.city === c.id ? 800 : 500, padding: "4px 10px", borderRadius: 14, border: state.city === c.id ? "2px solid #000" : "1.5px solid #ddd", background: state.city === c.id ? "#000" : "#fff", color: state.city === c.id ? "#fff" : "#777", cursor: "pointer" }}>{c.name}</button>
          ))
        ) : (
          <>
            {!FEATURED_CITIES.includes(state.city) && <button style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 14, border: "2px solid #000", background: "#000", color: "#fff", cursor: "default" }}>{CITY_MAP[state.city]?.name}</button>}
            <button onClick={() => setShowMoreCities(true)} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 14, border: "1.5px dashed #ccc", background: "#fff", color: "#999", cursor: "pointer" }}>More...</button>
          </>
        )}
        <button onClick={handleGeolocate} disabled={geoLoading} title="Use my location" style={{ width: 28, height: 28, borderRadius: "50%", border: "1.5px solid #ddd", background: "#fff", cursor: geoLoading ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, flexShrink: 0 }}>
          {geoLoading ? <span style={{ fontSize: 12, color: "#aaa" }}>...</span> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4A90D9" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" /></svg>}
        </button>
      </div>

      {/* Instruction line */}
      {cards.length > 0 && (
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: "#bbb", margin: "0 0 10px" }}>
          <span style={{ color: "#22c55e" }}>✓</span> Lock what sounds great &nbsp;·&nbsp; <span style={{ color: "#ca8a04" }}>→</span> Skip what&apos;s not for today &nbsp;·&nbsp; <span style={{ color: "#dc2626" }}>✕</span> Hide what&apos;s not for you
        </p>
      )}

      {/* Error */}
      {error && (
        <div style={{ textAlign: "center", padding: 40, color: "#E63946", fontFamily: "'Inter', sans-serif" }}>
          <p style={{ fontSize: 16, fontWeight: 700 }}>Couldn&apos;t plan your day</p>
          <p style={{ fontSize: 13, color: "#888" }}>{error}</p>
          <button onClick={handleReshuffle} style={{ marginTop: 12, padding: "8px 20px", borderRadius: 20, border: "2px solid #000", background: "#fff", cursor: "pointer", fontWeight: 700 }}>Try Again</button>
        </div>
      )}

      {/* Loading — cards appear one at a time then glow */}
      {loading && cards.length === 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "20px 0" }}>
          {Array.from({ length: 6 }).map((_, i) => {
            const accent = ACCENT_COLORS[i % ACCENT_COLORS.length];
            return (
              <div
                key={i}
                style={{
                  height: 80,
                  borderRadius: 12,
                  background: `linear-gradient(135deg, ${accent}10, ${accent}22)`,
                  border: `1.5px solid ${accent}25`,
                  opacity: 0,
                  animation: `cardAppear 0.5s ease-out ${i * 0.25}s forwards, softGlow 2.5s ease-in-out ${i * 0.25 + 0.5}s infinite`,
                }}
              />
            );
          })}
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600, color: "#ccc", textAlign: "center", marginTop: 8, opacity: 0, animation: "cardAppear 0.5s ease-out 1.5s forwards" }}>Planning your day...</p>
        </div>
      )}

      {/* ═══ LIST VIEW ═══ */}
      {cards.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {cards.map((card, i) => {
            const accent = ACCENT_COLORS[i % ACCENT_COLORS.length];
            const emoji = CATEGORY_EMOJI[card.category] || "📍";
            return (
              <div key={card.id} style={{ display: "flex", gap: 0, padding: "12px 14px", borderRadius: 12, background: `linear-gradient(135deg, ${accent}08, ${accent}15)`, border: `1.5px solid ${accent}20`, animation: `fadeSlideIn 0.3s ease-out ${i * 0.05}s both` }}>
                {/* Thumbnail: photo or emoji fallback */}
                <div style={{ width: 64, height: 64, borderRadius: 10, overflow: "hidden", flexShrink: 0, marginRight: 14, background: card.photoRef ? `url(/api/place-photo?ref=${encodeURIComponent(card.photoRef)}&w=200&h=200) center/cover no-repeat, ${accent}20` : `${accent}18`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>
                  {!card.photoRef && emoji}
                </div>
                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 800, color: "#000" }}>{card.timeBlock}</span>
                    <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 9, fontWeight: 700, color: accent, textTransform: "uppercase" as const, letterSpacing: 1 }}>{card.category}</span>
                    {card.source === "event" && <span style={{ fontSize: 9, fontWeight: 700, color: "#E63946", fontFamily: "'Inter', sans-serif" }}>EVENT</span>}
                  </div>
                  <h3 style={{ fontFamily: "'Inter', sans-serif", fontSize: 16, fontWeight: 900, color: "#000", margin: "0 0 3px", lineHeight: 1.2 }}>{card.name}</h3>
                  <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: "#555", margin: "0 0 3px", lineHeight: 1.4 }}>{card.blurb}</p>
                  <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 600, color: accent, margin: 0, lineHeight: 1.3, fontStyle: "italic" }}>{card.why}</p>
                  {(card.costNote || card.cost || card.url || card.mapsUrl) && (
                    <div style={{ display: "flex", gap: 10, marginTop: 4, alignItems: "center" }}>
                      {(card.costNote || card.cost) && <span style={{ fontSize: 11, fontWeight: 600, color: "#aaa", fontFamily: "'Inter', sans-serif" }}>{card.costNote || card.cost}</span>}
                      {(card.url || card.mapsUrl) && <a href={card.url || card.mapsUrl || "#"} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, fontWeight: 700, color: accent, textDecoration: "none", fontFamily: "'Inter', sans-serif" }}>Details →</a>}
                    </div>
                  )}
                </div>
                {/* Actions — traffic light: green lock, yellow skip, red hide */}
                <div style={{ display: "flex", flexDirection: "column", gap: 3, marginLeft: 10, flexShrink: 0, alignItems: "center" }}>
                  <button onClick={() => handleLock(card.id)} title={card.locked ? "Unlock" : "Lock this"} style={{ width: 28, height: 28, borderRadius: "50%", border: "none", background: card.locked ? "#22c55e" : "#dcfce7", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, padding: 0, color: card.locked ? "#fff" : "#22c55e", fontWeight: 700, transition: "all 0.15s" }}>✓</button>
                  <button onClick={() => handleDismiss(card.id, "skip")} title="Not today (skip 30 days)" style={{ width: 28, height: 28, borderRadius: "50%", border: "none", background: "#fef9c3", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, padding: 0, color: "#ca8a04", fontWeight: 700, transition: "all 0.15s" }}>→</button>
                  <button onClick={() => handleDismiss(card.id, "hide")} title="Never show this" style={{ width: 28, height: 28, borderRadius: "50%", border: "none", background: "#fee2e2", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, padding: 0, color: "#dc2626", fontWeight: 700, transition: "all 0.15s" }}>✕</button>
                </div>
              </div>
            );
          })}
        </div>
      )}


      <style>{`
        @keyframes rainbow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes cardAppear {
          from { opacity: 0; transform: translateY(16px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes softGlow {
          0%, 100% { box-shadow: 0 0 0 rgba(0,0,0,0); }
          50% { box-shadow: 0 0 16px rgba(100,100,255,0.1); }
        }
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (max-width: 640px) {
          .sbt-header {
            flex-direction: column !important;
            align-items: flex-start !important;
            gap: 8px !important;
          }
          .sbt-time-display {
            font-size: 36px !important;
            letter-spacing: -1px !important;
          }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
