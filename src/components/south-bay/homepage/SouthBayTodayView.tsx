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
  const [swapLoading, setSwapLoading] = useState(false); // loading triggered by a dismiss
  const [fadingIds, setFadingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [timeDisplay, setTimeDisplay] = useState(() => formatTime());
  const [showMoreCities, setShowMoreCities] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [activeCard, setActiveCard] = useState(0);
  const fetchRef = useRef(0);

  // Keep time display live
  useEffect(() => {
    const t = setInterval(() => setTimeDisplay(formatTime()), 30000);
    return () => clearInterval(t);
  }, []);

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
      const sorted = [...data.cards].sort((a, b) => parseTimeBlock(a.timeBlock) - parseTimeBlock(b.timeBlock));
      setCards(sorted.map((c) => ({ ...c, locked: state.locked.includes(c.id) })));
      setWeather(data.weather);
      setActiveCard(0);
    } catch (err) {
      if (id === fetchRef.current) setError(err instanceof Error ? err.message : "Failed to plan your day");
    } finally {
      if (id === fetchRef.current) {
        setLoading(false);
        setSwapLoading(false);
      }
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
  const handleNewPlan = () => fetchPlan();
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
    // Immediately start fade-out animation
    setFadingIds((prev) => new Set([...prev, cardId]));
    setSwapLoading(true);

    // After animation completes, remove card from list
    setTimeout(() => {
      setCards((prev) => prev.filter((c) => c.id !== cardId));
      setFadingIds((prev) => { const n = new Set(prev); n.delete(cardId); return n; });
    }, 320);

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
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Kids toggle */}
          <div style={{ display: "flex", borderRadius: 14, border: "2px solid #000", overflow: "hidden" }}>
            <button onClick={() => { if (state.kids) handleKidsToggle(); }} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, padding: "4px 10px", border: "none", background: !state.kids ? "#000" : "#fff", color: !state.kids ? "#fff" : "#888", cursor: "pointer", transition: "all 0.15s" }}>No Kids</button>
            <button onClick={() => { if (!state.kids) handleKidsToggle(); }} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, padding: "4px 10px", border: "none", borderLeft: "2px solid #000", background: state.kids ? "#000" : "#fff", color: state.kids ? "#fff" : "#888", cursor: "pointer", transition: "all 0.15s" }}>Kids</button>
          </div>
          {/* New Plan */}
          <button onClick={handleNewPlan} disabled={loading} style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 900, padding: "5px 16px", borderRadius: 14, border: "2.5px solid #000", background: loading ? "#eee" : "linear-gradient(135deg, #FF6B35, #E63946, #7B2FBE, #1A5AFF, #06D6A0, #FF3CAC)", color: loading ? "#999" : "#fff", cursor: loading ? "not-allowed" : "pointer", textTransform: "uppercase" as const, letterSpacing: 1, backgroundSize: "200% 200%", animation: loading ? "none" : "rainbow 3s ease infinite", whiteSpace: "nowrap" as const }}>Shuffle ↻</button>
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
          </>
        )}
        {/* More + geo grouped so they never split across lines */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {!showMoreCities && (
            <button onClick={() => setShowMoreCities(true)} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 14, border: "1.5px dashed #ccc", background: "#fff", color: "#999", cursor: "pointer" }}>More...</button>
          )}
          <button onClick={handleGeolocate} disabled={geoLoading} title="Use my location" style={{ width: 28, height: 28, borderRadius: "50%", border: "1.5px solid #ddd", background: "#fff", cursor: geoLoading ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, flexShrink: 0 }}>
            {geoLoading ? <span style={{ fontSize: 12, color: "#aaa" }}>...</span> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4A90D9" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" /></svg>}
          </button>
        </div>
      </div>

      {/* Weather strip */}
      {weather && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", marginBottom: 10, background: "#f8f8f8", borderRadius: 10, border: "1px solid #eee" }}>
          <span style={{ fontSize: 18 }}>🌤</span>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 700, color: "#333" }}>{weather}</span>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: "#bbb", marginLeft: "auto" }}>{CITY_MAP[state.city]?.name}, CA</span>
        </div>
      )}

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
          <button onClick={handleNewPlan} style={{ marginTop: 12, padding: "8px 20px", borderRadius: 20, border: "2px solid #000", background: "#fff", cursor: "pointer", fontWeight: 700 }}>Try Again</button>
        </div>
      )}

      {/* Loading — skeleton cards + cycling verb */}
      {loading && cards.length === 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "20px 0" }}>
          {Array.from({ length: 5 }).map((_, i) => {
            const accent = ACCENT_COLORS[i % ACCENT_COLORS.length];
            return (
              <div key={i} style={{ display: "flex", background: "#fff", borderRadius: 10, border: "1px solid #e8e8e8", overflow: "hidden", opacity: 0, animation: `cardAppear 0.5s ease-out ${i * 0.2}s forwards, softGlow 2.5s ease-in-out ${i * 0.2 + 0.5}s infinite` }}>
                <div style={{ width: 5, background: accent, flexShrink: 0 }} />
                <div style={{ flex: 1, padding: "14px 16px" }}>
                  <div style={{ width: "30%", height: 10, borderRadius: 4, background: "#eee", marginBottom: 8 }} />
                  <div style={{ width: "65%", height: 14, borderRadius: 4, background: "#eee", marginBottom: 6 }} />
                  <div style={{ width: "90%", height: 10, borderRadius: 4, background: "#f5f5f5" }} />
                </div>
              </div>
            );
          })}
          <LoadingVerb />
        </div>
      )}

      {/* ═══ LIST VIEW ═══ */}
      {cards.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {cards.map((card, i) => {
            const accent = ACCENT_COLORS[i % ACCENT_COLORS.length];
            const emoji = CATEGORY_EMOJI[card.category] || "📍";
            const isFading = fadingIds.has(card.id);
            const cardUrl = card.source === "event" ? (card.url || card.mapsUrl) : (card.mapsUrl || card.url);
            return (
              <div
                key={card.id}
                style={{
                  display: "flex",
                  gap: 0,
                  background: "#fff",
                  borderRadius: 10,
                  border: "1px solid #e8e8e8",
                  overflow: "hidden",
                  animation: isFading
                    ? "fadeSlideOut 0.3s ease-in forwards"
                    : `fadeSlideIn 0.3s ease-out ${i * 0.05}s both`,
                  position: "relative" as const,
                }}
              >
                {/* Accent bar */}
                <div style={{ width: 5, background: accent, flexShrink: 0 }} />
                {/* Clickable area (whole card except traffic lights) */}
                {cardUrl ? (
                  <a
                    href={cardUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: "flex", flex: 1, minWidth: 0, textDecoration: "none", color: "inherit", cursor: "pointer" }}
                  >
                    <CardInner card={card} emoji={emoji} accent={accent} />
                  </a>
                ) : (
                  <div style={{ display: "flex", flex: 1, minWidth: 0 }}>
                    <CardInner card={card} emoji={emoji} accent={accent} />
                  </div>
                )}
                {/* Traffic light actions */}
                <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "10px 10px 10px 0", flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
                  <button onClick={() => handleLock(card.id)} title={card.locked ? "Unlock" : "Lock this"} style={{ width: 28, height: 28, borderRadius: "50%", border: "none", background: card.locked ? "#22c55e" : "#dcfce7", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, padding: 0, color: card.locked ? "#fff" : "#22c55e", fontWeight: 700, transition: "all 0.15s" }}>✓</button>
                  <button onClick={() => handleDismiss(card.id, "skip")} title="Not today" style={{ width: 28, height: 28, borderRadius: "50%", border: "none", background: "#fef9c3", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, padding: 0, color: "#ca8a04", fontWeight: 700, transition: "all 0.15s" }}>→</button>
                  <button onClick={() => handleDismiss(card.id, "hide")} title="Never show this" style={{ width: 28, height: 28, borderRadius: "50%", border: "none", background: "#fee2e2", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, padding: 0, color: "#dc2626", fontWeight: 700, transition: "all 0.15s" }}>✕</button>
                </div>
              </div>
            );
          })}
          {/* Swap-loading stub — shown while fetching a replacement card */}
          {swapLoading && (
            <div style={{ display: "flex", background: "#fff", borderRadius: 10, border: "1px dashed #e8e8e8", overflow: "hidden", opacity: 0, animation: "cardAppear 0.4s ease-out 0.35s forwards" }}>
              <div style={{ width: 5, background: "#e8e8e8", flexShrink: 0 }} />
              <div style={{ flex: 1, padding: "14px 16px", display: "flex", alignItems: "center" }}>
                <LoadingVerb />
              </div>
            </div>
          )}
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
        @keyframes blink {
          50% { opacity: 0; }
        }
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeSlideOut {
          from { opacity: 1; transform: translateY(0) scale(1); max-height: 120px; }
          to { opacity: 0; transform: translateY(-8px) scale(0.97); max-height: 0; padding: 0; margin: 0; }
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

// ---------------------------------------------------------------------------
// CardInner — shared inner layout for list cards
// ---------------------------------------------------------------------------

interface UnsplashPhoto {
  url: string;
  photographer: string;
  photographerUrl: string;
  unsplashUrl: string;
}

function CardInner({ card, emoji, accent }: { card: DayCard; emoji: string; accent: string }) {
  const [unsplash, setUnsplash] = useState<UnsplashPhoto | null>(null);

  useEffect(() => {
    if (card.photoRef) return; // already have a Google photo
    fetch(`/api/unsplash-photo?query=${encodeURIComponent(card.category)}`)
      .then((r) => r.json())
      .then((d: UnsplashPhoto) => { if (d.url) setUnsplash(d); })
      .catch(() => {});
  }, [card.id, card.category, card.photoRef]);

  const hasPhoto = card.photoRef || unsplash;

  return (
    <>
      {/* Thumbnail column */}
      <div style={{ flexShrink: 0, margin: "10px 0 10px 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
        <div style={{
          width: 72, height: 72, borderRadius: 8, overflow: "hidden",
          background: card.photoRef
            ? `url(/api/place-photo?ref=${encodeURIComponent(card.photoRef)}&w=200&h=200) center/cover no-repeat, #f0f0f0`
            : unsplash
              ? "transparent"
              : "#f5f5f5",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28,
        }}>
          {unsplash && !card.photoRef
            ? <img src={unsplash.url} alt={card.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            : !hasPhoto ? emoji : null}
        </div>
        {/* Unsplash attribution — only when using Unsplash photo */}
        {unsplash && !card.photoRef && (
          <div style={{ width: 72, fontSize: 7, lineHeight: 1.3, color: "#bbb", textAlign: "center" }}>
            <span role="link" tabIndex={0} onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(unsplash.photographerUrl, "_blank", "noopener"); }} style={{ color: "#bbb", cursor: "pointer" }}>{unsplash.photographer}</span>
            {" · "}
            <span role="link" tabIndex={0} onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(unsplash.unsplashUrl, "_blank", "noopener"); }} style={{ color: "#bbb", cursor: "pointer" }}>Unsplash</span>
          </div>
        )}
      </div>
      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, padding: "10px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 800, color: "#000" }}>{card.timeBlock}</span>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 9, fontWeight: 700, color: "#999", textTransform: "uppercase" as const, letterSpacing: 1 }}>{card.category}</span>
          {card.source === "event" && <span style={{ fontSize: 9, fontWeight: 700, color: "#E63946", fontFamily: "'Inter', sans-serif" }}>EVENT</span>}
        </div>
        <h3 style={{ fontFamily: "'Inter', sans-serif", fontSize: 16, fontWeight: 900, color: "#000", margin: "0 0 3px", lineHeight: 1.2 }}>{card.name}</h3>
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: "#555", margin: "0 0 3px", lineHeight: 1.4 }}>{card.blurb}</p>
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 600, color: accent, margin: 0, lineHeight: 1.3, fontStyle: "italic" }}>{card.why}</p>
        {(card.costNote || card.cost) && (
          <span style={{ display: "inline-block", marginTop: 4, fontSize: 11, fontWeight: 600, color: "#aaa", fontFamily: "'Inter', sans-serif" }}>{card.costNote || card.cost}</span>
        )}
      </div>
    </>
  );
}

/** Parse "2:30 PM - 4:00 PM" → minutes since midnight for sorting */
function parseTimeBlock(tb: string): number {
  const m = tb.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const pm = m[3].toUpperCase() === "PM";
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return h * 60 + min;
}

const LOADING_VERBS = [
  "Planning", "Scheming", "Mapping out", "Dreaming up", "Cooking up",
  "Piecing together", "Scouting", "Curating", "Lining up", "Sketching out",
  "Assembling", "Rounding up", "Whipping up", "Plotting", "Mixing up",
  "Brainstorming", "Crafting", "Shuffling", "Dialing in", "Sorting out",
];

function LoadingVerb() {
  const [verbIdx, setVerbIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const verb = LOADING_VERBS[verbIdx % LOADING_VERBS.length];
    const full = `${verb} your day...`;

    if (!deleting && charIdx < full.length) {
      const t = setTimeout(() => setCharIdx((c) => c + 1), 40 + Math.random() * 30);
      return () => clearTimeout(t);
    }
    if (!deleting && charIdx >= full.length) {
      const t = setTimeout(() => setDeleting(true), 1200);
      return () => clearTimeout(t);
    }
    if (deleting && charIdx > 0) {
      const t = setTimeout(() => setCharIdx((c) => c - 1), 20);
      return () => clearTimeout(t);
    }
    if (deleting && charIdx === 0) {
      setDeleting(false);
      setVerbIdx((v) => v + 1);
    }
  }, [charIdx, deleting, verbIdx]);

  const verb = LOADING_VERBS[verbIdx % LOADING_VERBS.length];
  const full = `${verb} your day...`;
  const display = full.slice(0, charIdx);

  return (
    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, fontWeight: 600, color: "#bbb", textAlign: "center", marginTop: 8, minHeight: 20 }}>
      {display}<span style={{ opacity: 0.4, animation: "blink 0.8s step-end infinite" }}>|</span>
    </p>
  );
}

function formatTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
