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
      : { type: "skip", until: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) };
    setState((s) => ({
      ...s,
      dismissed: { ...s.dismissed, [cardId]: entry },
      locked: s.locked.filter((id) => id !== cardId),
    }));
    setCards((prev) => prev.filter((c) => c.id !== cardId));
  };
  const setViewMode = (mode: "list" | "cards") => setState((s) => ({ ...s, viewMode: mode }));

  // After 6pm, show "tomorrow" framing
  const ptHour = Number(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }));
  const headline = ptHour >= 18 ? "What should we do tomorrow?" : "What should we do today?";

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
          {/* View toggle */}
          <div style={{ display: "flex", borderRadius: 14, border: "1.5px solid #ddd", overflow: "hidden" }}>
            <button onClick={() => setViewMode("list")} style={{ fontFamily: "'Inter', sans-serif", fontSize: 10, fontWeight: 600, padding: "4px 8px", border: "none", background: state.viewMode === "list" ? "#000" : "#fff", color: state.viewMode === "list" ? "#fff" : "#aaa", cursor: "pointer" }}>List</button>
            <button onClick={() => setViewMode("cards")} style={{ fontFamily: "'Inter', sans-serif", fontSize: 10, fontWeight: 600, padding: "4px 8px", border: "none", borderLeft: "1.5px solid #ddd", background: state.viewMode === "cards" ? "#000" : "#fff", color: state.viewMode === "cards" ? "#fff" : "#aaa", cursor: "pointer" }}>Cards</button>
          </div>
          {/* Reshuffle */}
          <button onClick={handleReshuffle} disabled={loading} style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 900, padding: "5px 16px", borderRadius: 14, border: "2.5px solid #000", background: loading ? "#eee" : "linear-gradient(135deg, #FF6B35, #E63946, #7B2FBE, #1A5AFF, #06D6A0, #FF3CAC)", color: loading ? "#999" : "#fff", cursor: loading ? "not-allowed" : "pointer", textTransform: "uppercase" as const, letterSpacing: 1, backgroundSize: "200% 200%", animation: loading ? "none" : "rainbow 3s ease infinite", whiteSpace: "nowrap" as const }}>{loading ? "Planning..." : "Reshuffle"}</button>
        </div>
      </div>

      {/* City pills */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 0 12px", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 600, color: "#bbb", marginRight: 2 }}>Near</span>
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
          ✓ Lock what sounds great &nbsp;·&nbsp; Skip what&apos;s not for today &nbsp;·&nbsp; Hide what&apos;s not for you
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

      {/* Loading */}
      {loading && cards.length === 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "20px 0" }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} style={{ height: 80, borderRadius: 12, border: "1.5px solid transparent", background: `linear-gradient(#fff, #fff) padding-box, linear-gradient(135deg, ${ACCENT_COLORS[i % ACCENT_COLORS.length]}40, ${ACCENT_COLORS[(i + 2) % ACCENT_COLORS.length]}40) border-box`, animation: `fadeSlideIn 0.4s ease-out ${i * 0.1}s both, glow 2s ease-in-out ${i * 0.2}s infinite`, boxShadow: `0 0 12px ${ACCENT_COLORS[i % ACCENT_COLORS.length]}15` }} />
          ))}
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600, color: "#ccc", textAlign: "center", marginTop: 8 }}>Planning your day...</p>
        </div>
      )}

      {/* ═══ LIST VIEW ═══ */}
      {cards.length > 0 && state.viewMode === "list" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {cards.map((card, i) => {
            const accent = ACCENT_COLORS[i % ACCENT_COLORS.length];
            return (
              <div key={card.id} style={{ display: "flex", gap: 0, borderBottom: i < cards.length - 1 ? "1px solid #eee" : "none", padding: "14px 0", animation: `fadeSlideIn 0.3s ease-out ${i * 0.05}s both` }}>
                {/* Color accent bar */}
                <div style={{ width: 4, borderRadius: 2, background: accent, flexShrink: 0, marginRight: 14 }} />
                {/* Photo thumbnail */}
                {card.photoRef && (
                  <div style={{ width: 72, height: 72, borderRadius: 10, overflow: "hidden", flexShrink: 0, marginRight: 14, background: `url(/api/place-photo?ref=${encodeURIComponent(card.photoRef)}&w=200&h=200) center/cover no-repeat, ${accent}15` }} />
                )}
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
                {/* Actions */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginLeft: 12, flexShrink: 0, alignItems: "center" }}>
                  <button onClick={() => handleLock(card.id)} title={card.locked ? "Unlock" : "Lock this"} style={{ width: 32, height: 32, borderRadius: 8, border: card.locked ? "2px solid #06D6A0" : "1.5px solid #ddd", background: card.locked ? "#06D6A0" : "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, padding: 0 }}>{card.locked ? "🔒" : "✓"}</button>
                  <button onClick={() => handleDismiss(card.id, "skip")} title="Not today (skip 30 days)" style={{ padding: "3px 8px", borderRadius: 6, border: "1.5px solid #ddd", background: "#fff", cursor: "pointer", fontSize: 9, fontWeight: 700, color: "#aaa", fontFamily: "'Inter', sans-serif" }}>Skip</button>
                  <button onClick={() => handleDismiss(card.id, "hide")} title="Never show this" style={{ padding: "3px 8px", borderRadius: 6, border: "1.5px solid #000", background: "#000", cursor: "pointer", fontSize: 9, fontWeight: 700, color: "#fff", fontFamily: "'Inter', sans-serif" }}>Hide</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ═══ CARD VIEW (carousel) ═══ */}
      {cards.length > 0 && state.viewMode === "cards" && (
        <div>
          {/* Carousel navigation */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 16 }}>
            <button onClick={() => setActiveCard(Math.max(0, activeCard - 1))} disabled={activeCard === 0} style={{ width: 36, height: 36, borderRadius: "50%", border: "2px solid #000", background: "#fff", cursor: activeCard === 0 ? "default" : "pointer", opacity: activeCard === 0 ? 0.3 : 1, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>←</button>
            <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 700, color: "#555" }}>{activeCard + 1} / {cards.length}</span>
            <button onClick={() => setActiveCard(Math.min(cards.length - 1, activeCard + 1))} disabled={activeCard === cards.length - 1} style={{ width: 36, height: 36, borderRadius: "50%", border: "2px solid #000", background: "#fff", cursor: activeCard === cards.length - 1 ? "default" : "pointer", opacity: activeCard === cards.length - 1 ? 0.3 : 1, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>→</button>
          </div>
          {/* Active card */}
          {(() => {
            const card = cards[activeCard];
            if (!card) return null;
            const accent = ACCENT_COLORS[activeCard % ACCENT_COLORS.length];
            return (
              <div style={{ maxWidth: 440, margin: "0 auto", borderRadius: 16, border: "3px solid #000", background: "#fff", overflow: "hidden", boxShadow: `6px 6px 0 ${accent}20` }}>
                {/* Photo header */}
                <div style={{ height: 160, background: card.photoRef ? `url(/api/place-photo?ref=${encodeURIComponent(card.photoRef)}&w=500&h=300) center/cover no-repeat` : `linear-gradient(135deg, ${accent}15, ${accent}35)`, borderBottom: "3px solid #000", position: "relative" }}>
                  <div style={{ position: "absolute", top: 10, left: 10, display: "flex", gap: 6 }}>
                    <button onClick={() => handleLock(card.id)} style={{ width: 32, height: 32, borderRadius: 8, border: card.locked ? "2px solid #000" : "2px solid rgba(0,0,0,0.2)", background: card.locked ? "#06D6A0" : "rgba(255,255,255,0.9)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, padding: 0 }}>{card.locked ? "🔒" : "✓"}</button>
                  </div>
                  <div style={{ position: "absolute", top: 10, right: 10, display: "flex", gap: 4 }}>
                    <button onClick={() => handleDismiss(card.id, "skip")} style={{ padding: "4px 12px", borderRadius: 10, border: "1.5px solid rgba(0,0,0,0.2)", background: "rgba(255,255,255,0.9)", fontSize: 11, fontWeight: 700, color: "#888", cursor: "pointer", fontFamily: "'Inter', sans-serif" }}>Skip</button>
                    <button onClick={() => handleDismiss(card.id, "hide")} style={{ padding: "4px 12px", borderRadius: 10, border: "2px solid #000", background: "#000", fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: "'Inter', sans-serif" }}>Hide</button>
                  </div>
                </div>
                {/* Body */}
                <div style={{ padding: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, fontWeight: 800, color: "#000" }}>{card.timeBlock}</span>
                    <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 10, fontWeight: 700, color: accent, textTransform: "uppercase" as const, letterSpacing: 1 }}>{card.category}</span>
                    {card.source === "event" && <span style={{ fontSize: 10, fontWeight: 700, color: "#E63946" }}>EVENT</span>}
                  </div>
                  <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: 24, fontWeight: 900, color: "#000", margin: "0 0 8px", lineHeight: 1.15, letterSpacing: -0.5 }}>{card.name}</h2>
                  <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 15, color: "#555", margin: "0 0 8px", lineHeight: 1.5 }}>{card.blurb}</p>
                  <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, fontWeight: 600, color: accent, margin: 0, lineHeight: 1.4, fontStyle: "italic" }}>{card.why}</p>
                  {(card.costNote || card.cost || card.url || card.mapsUrl) && (
                    <div style={{ display: "flex", gap: 12, marginTop: 12, paddingTop: 10, borderTop: "1px solid #eee", alignItems: "center" }}>
                      {(card.costNote || card.cost) && <span style={{ fontSize: 12, fontWeight: 700, color: "#aaa", fontFamily: "'Inter', sans-serif" }}>{card.costNote || card.cost}</span>}
                      {(card.url || card.mapsUrl) && <a href={card.url || card.mapsUrl || "#"} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 700, color: accent, textDecoration: "none", fontFamily: "'Inter', sans-serif" }}>Details →</a>}
                    </div>
                  )}
                </div>
                {card.locked && <div style={{ height: 4, background: "#06D6A0" }} />}
              </div>
            );
          })()}
          {/* Card dots */}
          <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 16 }}>
            {cards.map((_, i) => (
              <button key={i} onClick={() => setActiveCard(i)} style={{ width: i === activeCard ? 20 : 8, height: 8, borderRadius: 4, border: "none", background: i === activeCard ? "#000" : "#ddd", cursor: "pointer", transition: "all 0.2s", padding: 0 }} />
            ))}
          </div>
        </div>
      )}

      <style>{`
        @keyframes rainbow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes glow {
          0%, 100% { box-shadow: 0 0 8px rgba(0,0,0,0.03); opacity: 0.7; }
          50% { box-shadow: 0 0 20px rgba(100,100,255,0.12); opacity: 1; }
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
