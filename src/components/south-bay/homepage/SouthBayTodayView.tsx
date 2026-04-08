// ---------------------------------------------------------------------------
// South Bay Today — Day-Planning Homepage
// ---------------------------------------------------------------------------
// "What should we do today?" card-deck interface.
// Calls /api/plan-day, displays 5-6 cards in a dealt-hand layout.
// Supports lock, skip, hide, and reshuffle interactions.
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback, useRef } from "react";
import type { City, Tab } from "../../../lib/south-bay/types";
import { CITIES } from "../../../lib/south-bay/cities";

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
  until?: string; // ISO date for skip expiry
  permanent?: boolean;
}

interface LocalState {
  city: City;
  kids: boolean;
  dismissed: Record<string, DismissedEntry>;
  locked: string[];
}

// ---------------------------------------------------------------------------
// Design tokens (Variant 6 — High Contrast Pop)
// ---------------------------------------------------------------------------

const ACCENT_COLORS = [
  "#FF6B35", // orange
  "#E63946", // red
  "#06D6A0", // teal
  "#7B2FBE", // purple
  "#1A5AFF", // blue
  "#FF3CAC", // hot pink
];

const CARD_ROTATIONS = [
  { rotate: -3.5, translateY: 8, z: 2 },
  { rotate: 1.8, translateY: -6, z: 3 },
  { rotate: -2.2, translateY: 12, z: 1 },
  { rotate: 3, translateY: -4, z: 2 },
  { rotate: -1.5, translateY: 10, z: 4 },
  { rotate: 2.8, translateY: -8, z: 1 },
];

const CATEGORY_EMOJI: Record<string, string> = {
  food: "🍽️",
  outdoor: "🌿",
  museum: "🏛️",
  entertainment: "🎭",
  wellness: "💆",
  shopping: "🛍️",
  arts: "🎨",
  events: "📅",
  neighborhood: "🏘️",
  sports: "⚾",
};

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "sbt-prefs";

function loadState(): LocalState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    // Clean expired skips
    const now = new Date().toISOString().slice(0, 10);
    for (const [id, entry] of Object.entries(parsed.dismissed ?? {})) {
      const d = entry as DismissedEntry;
      if (d.type === "skip" && d.until && d.until < now) {
        delete parsed.dismissed[id];
      }
    }
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

function defaultState(): LocalState {
  return { city: "campbell", kids: false, dismissed: {}, locked: [] };
}

function saveState(state: LocalState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* quota exceeded, ignore */ }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  homeCity: City | null;
  setHomeCity: (city: City) => void;
  onNavigate: (tab: Tab) => void;
};

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
  const [animatingOut, setAnimatingOut] = useState<Set<string>>(new Set());
  const fetchRef = useRef(0);

  // Persist state changes
  useEffect(() => {
    saveState(state);
  }, [state]);

  // Sync homeCity
  useEffect(() => {
    if (homeCity && homeCity !== state.city) {
      setState((s) => ({ ...s, city: homeCity }));
    }
  }, [homeCity]);

  // Fetch plan
  const fetchPlan = useCallback(async (cityOverride?: City) => {
    const id = ++fetchRef.current;
    setLoading(true);
    setError(null);
    setTimeDisplay(formatTime());

    const city = cityOverride || state.city;
    const dismissedIds = Object.keys(state.dismissed);
    const lockedIds = state.locked;

    try {
      const res = await fetch("/api/plan-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city,
          kids: state.kids,
          lockedIds,
          dismissedIds,
          currentHour: new Date().getHours(),
        }),
      });

      if (id !== fetchRef.current) return; // stale

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data: PlanResponse = await res.json();
      // Restore locked state from previous session
      const cardsWithLocks = data.cards.map((c) => ({
        ...c,
        locked: lockedIds.includes(c.id),
      }));
      setCards(cardsWithLocks);
      setWeather(data.weather);
    } catch (err) {
      if (id === fetchRef.current) {
        setError(err instanceof Error ? err.message : "Failed to plan your day");
      }
    } finally {
      if (id === fetchRef.current) setLoading(false);
    }
  }, [state.city, state.kids, state.dismissed, state.locked]);

  // Initial fetch
  useEffect(() => {
    fetchPlan();
  }, []);

  // ── Actions ──

  const handleCityChange = (city: City) => {
    setState((s) => ({ ...s, city }));
    setHomeCity(city);
    fetchPlan(city);
  };

  const handleKidsToggle = () => {
    setState((s) => {
      const next = { ...s, kids: !s.kids };
      return next;
    });
    // Refetch after state update
    setTimeout(() => fetchPlan(), 50);
  };

  const handleReshuffle = () => {
    fetchPlan();
  };

  const handleLock = (cardId: string) => {
    setCards((prev) =>
      prev.map((c) => (c.id === cardId ? { ...c, locked: !c.locked } : c))
    );
    setState((s) => {
      const locked = s.locked.includes(cardId)
        ? s.locked.filter((id) => id !== cardId)
        : [...s.locked, cardId];
      return { ...s, locked };
    });
  };

  const handleDismiss = (cardId: string, type: DismissType) => {
    // Animate out
    setAnimatingOut((prev) => new Set([...prev, cardId]));

    setTimeout(() => {
      setAnimatingOut((prev) => {
        const next = new Set(prev);
        next.delete(cardId);
        return next;
      });

      // Add to dismissed
      const entry: DismissedEntry =
        type === "hide"
          ? { type: "hide", permanent: true }
          : {
              type: "skip",
              until: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
            };

      setState((s) => ({
        ...s,
        dismissed: { ...s.dismissed, [cardId]: entry },
        locked: s.locked.filter((id) => id !== cardId),
      }));

      // Remove card from display
      setCards((prev) => prev.filter((c) => c.id !== cardId));
    }, 300);
  };

  // ── Render ──

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 20px 80px" }}>
      {/* Compact header: time + headline left, controls right */}
      <div
        className="sbt-header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 0 12px",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        {/* Left: time + headline */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexShrink: 0 }}>
          <div
            className="sbt-time-display"
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 48,
              fontWeight: 900,
              letterSpacing: -2,
              color: "#000",
              lineHeight: 1,
            }}
          >
            {timeDisplay}
          </div>
          <div>
            <div
              style={{
                fontFamily: "'Inter', sans-serif",
                fontSize: 16,
                fontWeight: 700,
                color: "#333",
                lineHeight: 1.2,
              }}
            >
              What should we do today?
            </div>
            {weather && (
              <div
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 12,
                  color: "#999",
                  marginTop: 2,
                }}
              >
                {weather}
              </div>
            )}
          </div>
        </div>

        {/* Right: controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {/* Kids segmented toggle */}
          <div
            style={{
              display: "flex",
              borderRadius: 16,
              border: "2px solid #000",
              overflow: "hidden",
            }}
          >
            <button
              onClick={() => { if (state.kids) handleKidsToggle(); }}
              style={{
                fontFamily: "'Inter', sans-serif",
                fontSize: 12,
                fontWeight: 700,
                padding: "5px 12px",
                border: "none",
                background: !state.kids ? "#000" : "#fff",
                color: !state.kids ? "#fff" : "#888",
                cursor: "pointer",
                transition: "all 0.15s",
                whiteSpace: "nowrap",
              }}
            >
              No Kids
            </button>
            <button
              onClick={() => { if (!state.kids) handleKidsToggle(); }}
              style={{
                fontFamily: "'Inter', sans-serif",
                fontSize: 12,
                fontWeight: 700,
                padding: "5px 12px",
                border: "none",
                borderLeft: "2px solid #000",
                background: state.kids ? "#000" : "#fff",
                color: state.kids ? "#fff" : "#888",
                cursor: "pointer",
                transition: "all 0.15s",
                whiteSpace: "nowrap",
              }}
            >
              Kids
            </button>
          </div>
          <button
            onClick={handleReshuffle}
            disabled={loading}
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 13,
              fontWeight: 900,
              padding: "6px 20px",
              borderRadius: 16,
              border: "3px solid #000",
              background: loading
                ? "#eee"
                : "linear-gradient(135deg, #FF6B35, #E63946, #7B2FBE, #1A5AFF, #06D6A0, #FF3CAC)",
              color: loading ? "#999" : "#fff",
              cursor: loading ? "not-allowed" : "pointer",
              textTransform: "uppercase" as const,
              letterSpacing: 1.5,
              transition: "all 0.2s",
              backgroundSize: "200% 200%",
              animation: loading ? "none" : "rainbow 3s ease infinite",
              whiteSpace: "nowrap",
            }}
          >
            {loading ? "Planning..." : "Reshuffle"}
          </button>
        </div>
      </div>

      {/* City pills — single compact row */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          padding: "0 0 12px",
        }}
      >
        {CITIES.map((c) => (
          <button
            key={c.id}
            onClick={() => handleCityChange(c.id)}
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 11,
              fontWeight: state.city === c.id ? 800 : 500,
              padding: "4px 10px",
              borderRadius: 14,
              border: state.city === c.id ? "2px solid #000" : "1.5px solid #ddd",
              background: state.city === c.id ? "#000" : "#fff",
              color: state.city === c.id ? "#fff" : "#777",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {c.name}
          </button>
        ))}
      </div>

      {/* Error state */}
      {error && (
        <div
          style={{
            textAlign: "center",
            padding: 40,
            color: "#E63946",
            fontFamily: "'Inter', sans-serif",
          }}
        >
          <p style={{ fontSize: 16, fontWeight: 700 }}>Couldn&apos;t plan your day</p>
          <p style={{ fontSize: 13, color: "#888" }}>{error}</p>
          <button
            onClick={handleReshuffle}
            style={{
              marginTop: 12,
              padding: "8px 20px",
              borderRadius: 20,
              border: "2px solid #000",
              background: "#fff",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            Try Again
          </button>
        </div>
      )}

      {/* Loading animation — dealing cards */}
      {loading && cards.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <div
            className="sbt-card-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "16px 16px",
              maxWidth: 1100,
            }}
          >
            {ACCENT_COLORS.map((color, i) => (
              <div
                key={i}
                className="sbt-card"
                style={{
                  height: 240,
                  borderRadius: 16,
                  border: "3px solid #000",
                  background: `linear-gradient(135deg, ${color}15, ${color}35)`,
                  animation: `dealIn 0.4s ease-out ${i * 0.12}s both`,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                }}
              >
                <div style={{ fontSize: 36, animation: `float 2s ease-in-out ${i * 0.2}s infinite` }}>
                  {["🗺️", "🍽️", "🌿", "🎭", "🏛️", "🎸"][i]}
                </div>
                <div
                  style={{
                    width: "60%",
                    height: 8,
                    borderRadius: 4,
                    background: `${color}33`,
                    animation: `shimmer 1.5s ease-in-out ${i * 0.15}s infinite`,
                  }}
                />
                <div
                  style={{
                    width: "40%",
                    height: 8,
                    borderRadius: 4,
                    background: `${color}22`,
                    animation: `shimmer 1.5s ease-in-out ${i * 0.15 + 0.2}s infinite`,
                  }}
                />
              </div>
            ))}
          </div>
          <p
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 14,
              fontWeight: 600,
              color: "#aaa",
              marginTop: 24,
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          >
            Shuffling the deck...
          </p>
        </div>
      )}

      {/* Card deck */}
      {cards.length > 0 && (
        <div
          className="sbt-card-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "20px 16px",
          }}
        >
          {cards.map((card, i) => (
            <DayCardComponent
              key={card.id}
              card={card}
              index={i}
              accent={ACCENT_COLORS[i % ACCENT_COLORS.length]}
              rotation={CARD_ROTATIONS[i % CARD_ROTATIONS.length]}
              animatingOut={animatingOut.has(card.id)}
              onLock={() => handleLock(card.id)}
              onSkip={() => handleDismiss(card.id, "skip")}
              onHide={() => handleDismiss(card.id, "hide")}
            />
          ))}
        </div>
      )}

      {/* Rainbow keyframes + pulse animation */}
      <style>{`
        @keyframes rainbow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.8; }
        }
        @keyframes dealIn {
          from {
            opacity: 0;
            transform: translateY(40px) rotate(8deg) scale(0.8);
          }
          to {
            opacity: 1;
            transform: translateY(0) rotate(0deg) scale(1);
          }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }
        @keyframes shimmer {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 0.6; }
        }
        @keyframes slideOut {
          to {
            opacity: 0;
            transform: translateX(80px) rotate(8deg) scale(0.9);
          }
        }
        @media (max-width: 768px) {
          .sbt-card-grid {
            grid-template-columns: 1fr !important;
          }
          .sbt-card {
            transform: none !important;
            margin-top: 0 !important;
          }
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
// Card component
// ---------------------------------------------------------------------------

function DayCardComponent({
  card,
  index,
  accent,
  rotation,
  animatingOut,
  onLock,
  onSkip,
  onHide,
}: {
  card: DayCard;
  index: number;
  accent: string;
  rotation: { rotate: number; translateY: number; z: number };
  animatingOut: boolean;
  onLock: () => void;
  onSkip: () => void;
  onHide: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  const isRow2 = index >= 3;
  const emoji = CATEGORY_EMOJI[card.category] || "📍";

  const transform = hovered
    ? `rotate(0deg) translateY(-8px) scale(1.03)`
    : `rotate(${rotation.rotate}deg) translateY(${rotation.translateY}px)`;

  const shadow = hovered ? `10px 10px 0 ${accent}33` : `6px 6px 0 ${accent}22`;

  return (
    <div
      className="sbt-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        borderRadius: 16,
        border: `3px solid #000`,
        background: "#fff",
        overflow: "hidden",
        cursor: "default",
        zIndex: hovered ? 10 : rotation.z,
        transform,
        boxShadow: shadow,
        marginTop: isRow2 ? -24 : 0,
        transition: "all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)",
        animation: animatingOut ? "slideOut 0.3s ease forwards" : "none",
      }}
    >
      {/* Gradient header with accent color */}
      <div
        style={{
          height: 120,
          background: `linear-gradient(135deg, ${accent}22, ${accent}44)`,
          borderBottom: `3px solid #000`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 48,
          position: "relative",
        }}
      >
        {emoji}

        {/* Lock button (upper left) */}
        <button
          onClick={(e) => { e.stopPropagation(); onLock(); }}
          title={card.locked ? "Unlock this item" : "Lock this item"}
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            width: 32,
            height: 32,
            borderRadius: 8,
            border: card.locked ? "2px solid #000" : "2px solid rgba(0,0,0,0.2)",
            background: card.locked ? "#06D6A0" : "rgba(255,255,255,0.8)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
            transition: "all 0.15s",
          }}
        >
          {card.locked ? "🔒" : "✓"}
        </button>

        {/* Skip / Hide buttons (upper right) */}
        <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }}>
          <button
            onClick={(e) => { e.stopPropagation(); onSkip(); }}
            title="Not today (skip for 30 days)"
            style={{
              padding: "4px 10px",
              borderRadius: 12,
              border: "2px solid rgba(0,0,0,0.15)",
              background: "rgba(255,255,255,0.8)",
              fontSize: 11,
              fontWeight: 700,
              color: "#888",
              cursor: "pointer",
              fontFamily: "'Inter', sans-serif",
              transition: "all 0.15s",
            }}
          >
            Skip
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onHide(); }}
            title="Never show this again"
            style={{
              padding: "4px 10px",
              borderRadius: 12,
              border: "2px solid #000",
              background: "#000",
              fontSize: 11,
              fontWeight: 700,
              color: "#fff",
              cursor: "pointer",
              fontFamily: "'Inter', sans-serif",
              transition: "all 0.15s",
            }}
          >
            Hide
          </button>
        </div>
      </div>

      {/* Card body */}
      <div style={{ padding: 16 }}>
        {/* Time block */}
        <div
          style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: 13,
            fontWeight: 800,
            color: "#000",
            marginBottom: 4,
          }}
        >
          {card.timeBlock}
        </div>
        {/* Category label */}
        <div style={{ marginBottom: 8 }}>
          <span
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 10,
              fontWeight: 900,
              textTransform: "uppercase" as const,
              letterSpacing: 2,
              color: "#000",
              border: "2px solid #000",
              borderRadius: 4,
              padding: "3px 8px",
              display: "inline-block",
            }}
          >
            {card.category}
          </span>
        </div>

        {/* Title */}
        <h3
          style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: 19,
            fontWeight: 900,
            letterSpacing: -0.5,
            color: "#000",
            margin: "0 0 6px",
            lineHeight: 1.2,
          }}
        >
          {card.name}
        </h3>

        {/* Blurb */}
        <p
          style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: 13,
            fontWeight: 500,
            color: "#555",
            margin: "0 0 6px",
            lineHeight: 1.4,
          }}
        >
          {card.blurb}
        </p>

        {/* Why */}
        <p
          style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: 12,
            fontWeight: 600,
            color: accent,
            margin: 0,
            lineHeight: 1.3,
          }}
        >
          {card.why}
        </p>

        {/* Footer: cost + link */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 10,
            paddingTop: 8,
            borderTop: "1px solid #eee",
          }}
        >
          {card.costNote || card.cost ? (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#888",
                fontFamily: "'Inter', sans-serif",
              }}
            >
              {card.costNote || card.cost}
            </span>
          ) : (
            <span />
          )}
          {(card.url || card.mapsUrl) && (
            <a
              href={card.url || card.mapsUrl || "#"}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: accent,
                textDecoration: "none",
                fontFamily: "'Inter', sans-serif",
              }}
            >
              Details →
            </a>
          )}
        </div>
      </div>

      {/* Locked indicator */}
      {card.locked && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 4,
            background: "#06D6A0",
          }}
        />
      )}
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
