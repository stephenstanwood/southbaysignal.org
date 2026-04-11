// ---------------------------------------------------------------------------
// South Bay Today — Day-Planning Homepage
// ---------------------------------------------------------------------------
// "What should we do today?" — list + card views with lock/skip/hide.
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback, useRef } from "react";
import type { City, Tab } from "../../../lib/south-bay/types";
import { CITIES, CITY_MAP } from "../../../lib/south-bay/cities";
import PhotoStrip from "./PhotoStrip";
import ForecastCard from "../cards/ForecastCard";

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
  venue?: string | null;
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
// User preference learning (persisted separately so prefs survive state resets)
// ---------------------------------------------------------------------------

const PREFS_KEY = "sbt-user-prefs";
const EMA_ALPHA = 0.3; // exponential moving average weight for new signals

interface UserPreferences {
  categoryScores: Record<string, number>; // positive = likes, negative = dislikes
  costBias: number;       // -1 (budget) to +1 (splurge)
  outdoorBias: number;    // -1 (indoor) to +1 (outdoor)
  totalInteractions: number;
}

function defaultPrefs(): UserPreferences {
  return { categoryScores: {}, costBias: 0, outdoorBias: 0, totalInteractions: 0 };
}

function loadPrefs(): UserPreferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return defaultPrefs();
    return { ...defaultPrefs(), ...JSON.parse(raw) };
  } catch { return defaultPrefs(); }
}

function savePrefs(prefs: UserPreferences) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

/** EMA update: blends new signal into existing value */
function ema(current: number, signal: number): number {
  return current * (1 - EMA_ALPHA) + signal * EMA_ALPHA;
}

/** Update preferences based on a user action on a card */
function recordInteraction(
  prefs: UserPreferences,
  card: DayCard,
  action: "lock" | "skip" | "hide",
): UserPreferences {
  const next = { ...prefs, categoryScores: { ...prefs.categoryScores } };
  next.totalInteractions++;

  // Category signal: lock = +1, skip = -0.3, hide = -1
  const catSignal = action === "lock" ? 1 : action === "skip" ? -0.3 : -1;
  const prev = next.categoryScores[card.category] ?? 0;
  next.categoryScores[card.category] = ema(prev, catSignal);

  // Cost signal: lock expensive = +, lock cheap = -, skip expensive = -, skip cheap = +
  const isExpensive = card.costNote && /\$\$|\$3|\$4|\$5|\$6/.test(card.costNote);
  const isCheap = card.cost === "free" || (card.costNote && /under|\$1|\$[5-9]\b/.test(card.costNote));
  if (action === "lock") {
    if (isExpensive) next.costBias = ema(next.costBias, 0.5);
    else if (isCheap) next.costBias = ema(next.costBias, -0.3);
  } else if (action === "skip" || action === "hide") {
    if (isExpensive) next.costBias = ema(next.costBias, -0.3);
  }

  // Outdoor signal from card category
  const isOutdoor = card.category === "outdoor" || card.category === "sports";
  const isIndoor = card.category === "museum" || card.category === "entertainment";
  if (action === "lock") {
    if (isOutdoor) next.outdoorBias = ema(next.outdoorBias, 0.5);
    else if (isIndoor) next.outdoorBias = ema(next.outdoorBias, -0.3);
  } else if (action === "hide") {
    if (isOutdoor) next.outdoorBias = ema(next.outdoorBias, -0.5);
    else if (isIndoor) next.outdoorBias = ema(next.outdoorBias, 0.3);
  }

  // Clamp biases to [-1, 1]
  next.costBias = Math.max(-1, Math.min(1, next.costBias));
  next.outdoorBias = Math.max(-1, Math.min(1, next.outdoorBias));

  return next;
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
  const [replacedIds, setReplacedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [timeDisplay, setTimeDisplay] = useState(() => formatTime());
  const [showMoreCities, setShowMoreCities] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoActive, setGeoActive] = useState(false);
  const [activeCard, setActiveCard] = useState(0);
  const fetchRef = useRef(0);
  const fetchPlanRef = useRef<(cityOverride?: City, extraLockedIds?: string[]) => void>(() => {});
  const [prefs, setPrefs] = useState<UserPreferences>(loadPrefs);

  // Keep time display live
  useEffect(() => {
    const t = setInterval(() => setTimeDisplay(formatTime()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { saveState(state); }, [state]);
  useEffect(() => {
    if (homeCity && homeCity !== state.city) setState((s) => ({ ...s, city: homeCity }));
  }, [homeCity]);

  const fetchPlan = useCallback(async (cityOverride?: City, extraLockedIds?: string[]) => {
    const id = ++fetchRef.current;
    setLoading(true);
    setError(null);
    setTimeDisplay(formatTime());
    const city = cityOverride || state.city;
    const allLocked = extraLockedIds
      ? [...new Set([...state.locked, ...extraLockedIds])]
      : state.locked;

    try {
      const res = await fetch("/api/plan-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city, kids: state.kids,
          lockedIds: allLocked,
          dismissedIds: Object.keys(state.dismissed),
          currentHour: new Date().getHours(),
          preferences: prefs.totalInteractions >= 5 ? prefs : undefined,
        }),
      });
      if (id !== fetchRef.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data: PlanResponse = await res.json();
      const sorted = [...data.cards].sort((a, b) => parseTimeBlock(a.timeBlock) - parseTimeBlock(b.timeBlock));
      // Only show green lock icon for user-explicitly-locked cards, not auto-kept ones
      setCards(sorted.map((c) => ({ ...c, locked: state.locked.includes(c.id) })));
      setReplacedIds(new Set());
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

  // Keep fetchPlanRef current so callers always invoke the latest version
  useEffect(() => { fetchPlanRef.current = fetchPlan; }, [fetchPlan]);

  // Actions
  const handleCityChange = (city: City) => {
    setState((s) => ({ ...s, city }));
    setHomeCity(city);
    fetchPlan(city);
  };
  const handleKidsToggle = () => {
    setState((s) => ({ ...s, kids: !s.kids }));
    // Use fetchPlanRef so we invoke the latest fetchPlan after the state
    // update lands, not a stale closure bound to the previous `kids` value.
    setTimeout(() => fetchPlanRef.current?.(), 50);
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
        setGeoActive(true);
        handleCityChange(nearest);
      },
      () => setGeoLoading(false),
      { timeout: 8000 },
    );
  };
  const handleLock = (cardId: string) => {
    const card = cards.find((c) => c.id === cardId);
    if (card && !card.locked) {
      // Only record preference when locking (not unlocking)
      const updated = recordInteraction(prefs, card, "lock");
      setPrefs(updated);
      savePrefs(updated);
    }
    setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, locked: !c.locked } : c)));
    setState((s) => ({
      ...s,
      locked: s.locked.includes(cardId) ? s.locked.filter((id) => id !== cardId) : [...s.locked, cardId],
    }));
  };
  const handleDismiss = (cardId: string, type: DismissType) => {
    const card = cards.find((c) => c.id === cardId);
    if (card) {
      const updated = recordInteraction(prefs, card, type === "skip" ? "skip" : "hide");
      setPrefs(updated);
      savePrefs(updated);
    }
    // Immediately replace card content with in-place swap skeleton — no fade-out
    // so the rectangle stays put and just swaps its inner content.
    setSwapLoading(true);
    setReplacedIds((prev) => new Set([...prev, cardId]));

    // Keep all OTHER cards by passing them as extra locked IDs (not stored in state)
    const keepIds = cards.filter((c) => c.id !== cardId).map((c) => c.id);

    const entry: DismissedEntry = type === "hide"
      ? { type: "hide", permanent: true }
      : { type: "skip", until: new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) };
    setState((s) => ({
      ...s,
      dismissed: { ...s.dismissed, [cardId]: entry },
      locked: s.locked.filter((id) => id !== cardId),
    }));
    // Refetch with other cards auto-locked so only the dismissed slot changes
    setTimeout(() => fetchPlanRef.current(undefined, keepIds), 100);
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
            {weather && <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: "#888", marginTop: 2 }}>🌤 {weather} · {CITY_MAP[state.city]?.name}</div>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Kids toggle */}
          <div style={{ display: "flex", borderRadius: 14, border: "2px solid #000", overflow: "hidden" }}>
            <button onClick={() => { if (state.kids) handleKidsToggle(); }} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, padding: "4px 10px", border: "none", background: !state.kids ? "#000" : "#fff", color: !state.kids ? "#fff" : "#888", cursor: "pointer", transition: "all 0.15s" }}>No Kids</button>
            <button onClick={() => { if (!state.kids) handleKidsToggle(); }} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, padding: "4px 10px", border: "none", borderLeft: "2px solid #000", background: state.kids ? "#000" : "#fff", color: state.kids ? "#fff" : "#888", cursor: "pointer", transition: "all 0.15s" }}>Kids</button>
          </div>
          {/* New Plan */}
          <button onClick={handleNewPlan} disabled={loading && !swapLoading} className={(loading && !swapLoading) ? "sbt-shuffle sbt-shuffle--loading" : "sbt-shuffle"}>Shuffle ↻</button>
        </div>
      </div>

      {/* City pills */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 0 12px", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 600, color: "#bbb", marginRight: 2 }}>Starting in</span>
        {/* Geolocation — first option, to the left of CAMPBELL */}
        <button
          onClick={handleGeolocate}
          disabled={geoLoading}
          title="Use my location"
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            border: geoActive ? "2px solid #1A5AFF" : "1.5px solid #ddd",
            background: geoActive ? "#1A5AFF" : "#fff",
            cursor: geoLoading ? "wait" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            flexShrink: 0,
          }}
        >
          {geoLoading ? (
            <span style={{ fontSize: 12, color: "#aaa" }}>...</span>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={geoActive ? "#fff" : "#4A90D9"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <line x1="12" y1="2" x2="12" y2="6" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="2" y1="12" x2="6" y2="12" />
              <line x1="18" y1="12" x2="22" y2="12" />
            </svg>
          )}
        </button>
        {FEATURED_CITIES.map((id) => (
          <button key={id} onClick={() => { setGeoActive(false); handleCityChange(id); }} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: state.city === id ? 800 : 500, padding: "4px 10px", borderRadius: 14, border: state.city === id ? "2px solid #000" : "1.5px solid #ddd", background: state.city === id ? "#000" : "#fff", color: state.city === id ? "#fff" : "#777", cursor: "pointer", transition: "all 0.15s" }}>{CITY_MAP[id].name}</button>
        ))}
        {showMoreCities ? (
          CITIES.filter((c) => !FEATURED_CITIES.includes(c.id)).map((c) => (
            <button key={c.id} onClick={() => { setGeoActive(false); handleCityChange(c.id); setShowMoreCities(false); }} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: state.city === c.id ? 800 : 500, padding: "4px 10px", borderRadius: 14, border: state.city === c.id ? "2px solid #000" : "1.5px solid #ddd", background: state.city === c.id ? "#000" : "#fff", color: state.city === c.id ? "#fff" : "#777", cursor: "pointer" }}>{c.name}</button>
          ))
        ) : (
          <>
            {!FEATURED_CITIES.includes(state.city) && <button style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 14, border: "2px solid #000", background: "#000", color: "#fff", cursor: "default" }}>{CITY_MAP[state.city]?.name}</button>}
          </>
        )}
        {!showMoreCities && (
          <button onClick={() => setShowMoreCities(true)} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 14, border: "1.5px dashed #ccc", background: "#fff", color: "#999", cursor: "pointer", flexShrink: 0 }}>More...</button>
        )}
      </div>

      {/* Weekly forecast banner */}
      <div style={{ marginBottom: 14 }}>
        <ForecastCard homeCity={state.city} />
      </div>

      {/* Photo scroll */}
      <div style={{ margin: "0 -16px 14px" }}>
        <PhotoStrip />
      </div>

      {/* Instruction line */}
      {cards.length > 0 && (
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600, color: "#999", margin: "0 0 10px", textAlign: "right", letterSpacing: 0.2 }}>
          <span style={{ color: "#22c55e" }}>✓</span> Sounds great &nbsp;·&nbsp; <span style={{ color: "#ca8a04" }}>→</span> Not today &nbsp;·&nbsp; <span style={{ color: "#dc2626" }}>✕</span> Never
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

      {/* Loading — single card with verb inside */}
      {loading && cards.length === 0 && (
        <div style={{ padding: "8px 0 20px", margin: "0 -16px" }}>
          <div style={{ display: "flex", background: "#fff", borderRadius: 10, border: "1px solid #f0f0f0", overflow: "hidden", opacity: 0, animation: "cardAppear 0.4s ease-out 0.1s forwards" }}>
            <div style={{ width: 20, backgroundImage: "linear-gradient(180deg, #FF6B35, #E63946, #7B2FBE, #1A5AFF, #06D6A0, #FF3CAC)", backgroundSize: "100% 200%", animation: "rainbow 3s ease infinite", flexShrink: 0 }} />
            <div style={{ flex: 1, padding: "28px 20px", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <LoadingVerb />
            </div>
          </div>
        </div>
      )}

      {/* ═══ LIST VIEW ═══ */}
      {cards.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "0 -16px" }}>
          {cards.map((card, i) => {
            const accent = ACCENT_COLORS[i % ACCENT_COLORS.length];
            const emoji = CATEGORY_EMOJI[card.category] || "📍";
            const isReplaced = replacedIds.has(card.id);
            const cardUrl = card.source === "event" ? (card.url || card.mapsUrl) : (card.mapsUrl || card.url);

            // In-place swap skeleton — same outer wrapper as a normal card so
            // dimensions don't jump; just swaps the inner content for SwapVerb.
            if (isReplaced) {
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
                    position: "relative" as const,
                  }}
                >
                  <div style={{ width: 6, background: accent, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0, padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 96 }}>
                    <SwapVerb />
                  </div>
                </div>
              );
            }

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
                  animation: `fadeSlideIn 0.3s ease-out ${i * 0.05}s both`,
                  position: "relative" as const,
                }}
              >
                {/* Accent bar */}
                <div style={{ width: 6, background: accent, flexShrink: 0 }} />
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
                <div className="tl-group">
                  <button onClick={() => handleLock(card.id)} title={card.locked ? "Unlock" : "Lock this"} className={`tl-btn tl-lock${card.locked ? " tl-lock--active" : ""}`}>✓</button>
                  <button onClick={() => handleDismiss(card.id, "skip")} title="Not today" className="tl-btn tl-skip">→</button>
                  <button onClick={() => handleDismiss(card.id, "hide")} title="Never show this" className="tl-btn tl-hide">✕</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Share button */}
      {cards.length > 1 && !loading && (
        <div style={{ textAlign: "center", padding: "16px 0 0" }}>
          <ShareButton cards={cards} city={state.city} kids={state.kids} weather={weather} />
        </div>
      )}


      <style>{`
        .sbt-shuffle {
          font-family: 'Inter', sans-serif;
          font-size: 12px;
          font-weight: 900;
          padding: 5px 16px;
          border-radius: 14px;
          border: 2.5px solid #000;
          background: linear-gradient(135deg, #FF6B35, #E63946, #7B2FBE, #1A5AFF, #06D6A0, #FF3CAC);
          background-size: 200% 200%;
          animation: rainbow 3s ease infinite;
          color: #fff;
          cursor: pointer;
          text-transform: uppercase;
          letter-spacing: 1px;
          white-space: nowrap;
          position: relative;
          overflow: hidden;
          z-index: 0;
        }
        .sbt-shuffle--loading {
          background: #ddd;
          color: #fff;
          cursor: not-allowed;
          animation: none;
        }
        .sbt-shuffle--loading::after {
          content: '';
          position: absolute;
          top: 0; left: 0; bottom: 0;
          width: 0%;
          background: linear-gradient(90deg, #FF6B35, #E63946, #7B2FBE, #1A5AFF, #06D6A0, #FF3CAC);
          animation: fillRight 4s ease-out forwards;
          z-index: -1;
        }
        @keyframes fillRight {
          0%   { width: 0%; }
          100% { width: 100%; }
        }
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
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
        /* ── Traffic light buttons ── */
        .tl-group {
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 10px 12px 10px 0;
          flex-shrink: 0;
          align-items: center;
          justify-content: center;
        }
        .tl-btn {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 15px;
          font-weight: 700;
          padding: 0;
          transition: all 0.2s ease;
          animation: tlPulse 0.6s ease-out 0.5s 3;
        }
        .tl-lock {
          border: 1.5px solid #bbf7d0;
          background: #dcfce7;
          color: #22c55e;
        }
        .tl-lock--active {
          border: 2px solid #16a34a;
          background: #22c55e;
          color: #fff;
        }
        .tl-skip {
          border: 1.5px solid #fde68a;
          background: #fef9c3;
          color: #ca8a04;
        }
        .tl-hide {
          border: 1.5px solid #fecaca;
          background: #fee2e2;
          color: #dc2626;
        }
        .tl-lock:hover { box-shadow: 0 0 12px rgba(34, 197, 94, 0.5); transform: scale(1.12); }
        .tl-skip:hover { box-shadow: 0 0 12px rgba(202, 138, 4, 0.4); transform: scale(1.12); }
        .tl-hide:hover { box-shadow: 0 0 12px rgba(220, 38, 38, 0.4); transform: scale(1.12); }
        .tl-lock--active:hover { box-shadow: 0 0 14px rgba(34, 197, 94, 0.6); }
        @keyframes tlPulse {
          0% { box-shadow: 0 0 0 0 rgba(150, 150, 150, 0.3); }
          70% { box-shadow: 0 0 0 8px rgba(150, 150, 150, 0); }
          100% { box-shadow: 0 0 0 0 rgba(150, 150, 150, 0); }
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
          .sbt-card-thumb {
            width: 64px !important;
            height: 64px !important;
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
          width: 80, height: 80, borderRadius: 8, overflow: "hidden",
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
          <div style={{ width: 80, fontSize: 7, lineHeight: 1.3, color: "#bbb", textAlign: "center" }}>
            <span role="link" tabIndex={0} onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(unsplash.photographerUrl, "_blank", "noopener"); }} style={{ color: "#bbb", cursor: "pointer" }}>{unsplash.photographer}</span>
            {" · "}
            <span role="link" tabIndex={0} onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(unsplash.unsplashUrl, "_blank", "noopener"); }} style={{ color: "#bbb", cursor: "pointer" }}>Unsplash</span>
          </div>
        )}
      </div>
      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, padding: "10px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 800, color: "#000", letterSpacing: -0.2 }}>{card.timeBlock}</span>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 9, fontWeight: 700, color: "#bbb", textTransform: "uppercase" as const, letterSpacing: 1 }}>{card.category}</span>
          {card.source === "event" && <span style={{ fontSize: 8, fontWeight: 800, color: "#fff", background: "#E63946", padding: "1px 5px", borderRadius: 3, fontFamily: "'Inter', sans-serif", letterSpacing: 0.5 }}>EVENT</span>}
        </div>
        <h3 style={{ fontFamily: "'Inter', sans-serif", fontSize: 17, fontWeight: 900, color: "#111", margin: "0 0 4px", lineHeight: 1.25 }}>{card.name}</h3>
        {card.source === "event" && card.venue && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: "#999" }}>{card.venue}</span>
          </div>
        )}
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: "#555", margin: "0 0 4px", lineHeight: 1.45 }}>{card.blurb}</p>
        {(card.costNote || card.cost) && (
          <span style={{ display: "inline-block", marginTop: 5, fontSize: 10, fontWeight: 700, color: "#999", fontFamily: "'Inter', sans-serif", background: "#f5f5f5", padding: "2px 8px", borderRadius: 4 }}>{card.costNote || card.cost}</span>
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
  "Planning", "Mapping out", "Dreaming up", "Cooking up",
  "Piecing together", "Scouting", "Curating", "Lining up", "Sketching out",
  "Assembling", "Rounding up", "Whipping up", "Mixing up", "Building",
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
    <p className="loading-verb" style={{ fontSize: 28, fontWeight: 900, textAlign: "center", margin: 0, minHeight: 36, background: "linear-gradient(90deg, #FF6B35, #E63946, #7B2FBE, #1A5AFF, #06D6A0, #FF3CAC, #FF6B35)", backgroundSize: "200% 100%", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text", animation: "rainbow 3s ease infinite", fontFamily: "'Inter', sans-serif", letterSpacing: -0.5 }}>
      {display}<span style={{ WebkitTextFillColor: "#ccc", animation: "blink 0.8s step-end infinite" }}>|</span>
    </p>
  );
}

const SWAP_PHRASES = [
  "Looking for something else",
  "Finding an alternative",
  "Checking what's around",
  "Digging up options",
  "Scouting a replacement",
  "How about this?",
];

function SwapVerb() {
  const [idx, setIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const phrase = SWAP_PHRASES[idx % SWAP_PHRASES.length];
    const full = `${phrase}...`;

    if (!deleting && charIdx < full.length) {
      const t = setTimeout(() => setCharIdx((c) => c + 1), 35 + Math.random() * 25);
      return () => clearTimeout(t);
    }
    if (!deleting && charIdx >= full.length) {
      const t = setTimeout(() => setDeleting(true), 900);
      return () => clearTimeout(t);
    }
    if (deleting && charIdx > 0) {
      const t = setTimeout(() => setCharIdx((c) => c - 1), 18);
      return () => clearTimeout(t);
    }
    if (deleting && charIdx === 0) {
      setDeleting(false);
      setIdx((v) => v + 1);
    }
  }, [charIdx, deleting, idx]);

  const phrase = SWAP_PHRASES[idx % SWAP_PHRASES.length];
  const full = `${phrase}...`;
  const display = full.slice(0, charIdx);

  return (
    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 18, fontWeight: 700, color: "#ccc", textAlign: "center", margin: 0, minHeight: 24, width: "100%" }}>
      {display}<span style={{ opacity: 0.4, animation: "blink 0.8s step-end infinite" }}>|</span>
    </p>
  );
}

function ShareButton({ cards, city, kids, weather }: { cards: DayCard[]; city: string; kids: boolean; weather: string | null }) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    if (shareUrl) {
      // Already have a URL — just copy/share it
      await doShare(shareUrl);
      return;
    }
    setSharing(true);
    try {
      const res = await fetch("/api/share-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards, city, kids, weather }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setShareUrl(data.url);
      await doShare(data.url);
    } catch {
      // Silently fail
    } finally {
      setSharing(false);
    }
  };

  const doShare = async (url: string) => {
    if (navigator.share) {
      try {
        await navigator.share({ title: "My day plan — South Bay Today", url });
        return;
      } catch {}
    }
    // Fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <button
      onClick={handleShare}
      disabled={sharing}
      style={{
        fontFamily: "'Inter', sans-serif",
        fontSize: 12,
        fontWeight: 700,
        padding: "8px 20px",
        borderRadius: 20,
        border: "1.5px solid #ddd",
        background: "#fff",
        color: copied ? "#16a34a" : "#888",
        cursor: sharing ? "wait" : "pointer",
        transition: "all 0.2s",
      }}
    >
      {copied ? "Link copied!" : sharing ? "Creating link..." : "Share this plan ↗"}
    </button>
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
