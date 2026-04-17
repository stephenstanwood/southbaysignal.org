import { useState, useEffect } from "react";
import {
  buildDayPlan,
  type DayPlan,
  type PlanStop,
  type Who,
  type Duration,
  type VibeType,
  type BudgetType,
} from "../../../lib/south-bay/planMyDay";

// ── Option definitions ────────────────────────────────────────────────────────

const WHO_OPTIONS: { id: Who; label: string; emoji: string }[] = [
  { id: "solo", label: "Solo", emoji: "🧍" },
  { id: "couple", label: "Couple", emoji: "👫" },
  { id: "family-young", label: "Young family", emoji: "👶" },
  { id: "family-kids", label: "Family w/ kids", emoji: "👨‍👩‍👦" },
  { id: "teens", label: "Teens", emoji: "🛹" },
  { id: "group", label: "Group", emoji: "👥" },
];

const DURATION_OPTIONS: { id: Duration; label: string; emoji: string; sub: string }[] = [
  { id: "morning", label: "Morning", emoji: "🌅", sub: "til noon" },
  { id: "afternoon", label: "Afternoon", emoji: "☀️", sub: "noon–5pm" },
  { id: "evening", label: "Evening", emoji: "🌆", sub: "6pm+" },
  { id: "full-day", label: "Full day", emoji: "🗓️", sub: "9am–9pm" },
  { id: "quick", label: "Quick 2hrs", emoji: "⚡", sub: "right now" },
];

const VIBE_OPTIONS: { id: VibeType; label: string; emoji: string }[] = [
  { id: "outdoors", label: "Outside", emoji: "🌳" },
  { id: "mix", label: "Mix it up", emoji: "✨" },
  { id: "indoors", label: "Inside", emoji: "🏛️" },
];

const BUDGET_OPTIONS: { id: BudgetType; label: string; emoji: string; sub: string }[] = [
  { id: "free", label: "Free only", emoji: "🆓", sub: "$0" },
  { id: "some", label: "Some OK", emoji: "💵", sub: "under $25" },
  { id: "anything", label: "No limit", emoji: "🎉", sub: "treat yourself" },
];

// ── Cost badge ────────────────────────────────────────────────────────────────

function costBadge(cost: "free" | "low" | "paid", costNote?: string) {
  if (cost === "free")
    return { label: "FREE", bg: "#D1FAE5", color: "#065F46" };
  if (cost === "low")
    return {
      label: costNote?.split(" ").slice(0, 3).join(" ") ?? "$",
      bg: "#FEF3C7",
      color: "#92400E",
    };
  return {
    label: costNote?.split(" ").slice(0, 3).join(" ") ?? "$$+",
    bg: "#EDE9FE",
    color: "#5B21B6",
  };
}

// ── Option pill ───────────────────────────────────────────────────────────────

function OptionPill({
  emoji,
  label,
  sub,
  active,
  onClick,
}: {
  emoji: string;
  label: string;
  sub?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`plan-option${active ? " plan-option--active" : ""}`}
    >
      <span className="plan-option-emoji">{emoji}</span>
      <span className="plan-option-label">{label}</span>
      {sub && <span className="plan-option-sub">{sub}</span>}
    </button>
  );
}

// ── Stop card ─────────────────────────────────────────────────────────────────

function StopCard({ stop }: { stop: PlanStop }) {
  const badge = costBadge(stop.cost, stop.costNote);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (stop.photoRef) {
      // Google Places photo — real photo of the actual venue
      setPhotoUrl(`/api/place-photo?ref=${encodeURIComponent(stop.photoRef)}&w=144&h=144`);
    }
  }, [stop.photoRef]);

  return (
    <div style={{ marginBottom: 24 }}>
      {/* Slot time header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: "var(--sb-muted)",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            fontFamily: "var(--sb-sans)",
          }}
        >
          {stop.slotLabel} · {stop.time}
        </span>
        <div
          style={{ flex: 1, height: 1, background: "var(--sb-border-light)" }}
        />
      </div>

      {/* Activity card */}
      <div className="plan-stop-card">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 0 }}>
          {/* Photo thumbnail */}
          <div style={{ flexShrink: 0, margin: "12px 14px 12px 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <div style={{
              width: 72, height: 72, borderRadius: 8, overflow: "hidden",
              background: photoUrl ? "transparent" : "var(--sb-bg)",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28,
              flexShrink: 0,
            }}>
              {photoUrl
                ? <img src={photoUrl} alt={stop.title} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} onError={() => setPhotoUrl(null)} />
                : <span>{stop.emoji}</span>
              }
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0, paddingTop: 12, paddingRight: 12 }}>
            {/* Title + today badge */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 4,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--sb-serif)",
                  fontWeight: 700,
                  fontSize: 16,
                  color: "var(--sb-ink)",
                  lineHeight: 1.3,
                }}
              >
                {stop.url ? (
                  <a
                    href={stop.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "inherit", textDecoration: "none" }}
                  >
                    {stop.title}
                  </a>
                ) : (
                  stop.title
                )}
              </span>
              {stop.isTodaySpecial && (
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    padding: "2px 7px",
                    borderRadius: 2,
                    background: "var(--sb-accent-light)",
                    color: "var(--sb-accent)",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    flexShrink: 0,
                  }}
                >
                  ★ Today
                </span>
              )}
            </div>

            {/* Venue / city */}
            <div
              style={{
                fontSize: 12,
                color: "var(--sb-muted)",
                marginBottom: 10,
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <span>{stop.venue}</span>
              <span style={{ color: "var(--sb-border)" }}>·</span>
              <span>{stop.city}</span>
            </div>

            {/* Badges */}
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                alignItems: "center",
                marginBottom: 10,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 7px",
                  borderRadius: 3,
                  background: badge.bg,
                  color: badge.color,
                  letterSpacing: "0.04em",
                }}
              >
                {badge.label}
              </span>
              {stop.kidFriendly && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    padding: "2px 7px",
                    borderRadius: 3,
                    background: "#F0F9FF",
                    color: "#0369A1",
                    letterSpacing: "0.04em",
                  }}
                >
                  👶 Kid-friendly
                </span>
              )}
              {stop.indoorOutdoor === "outdoor" && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    padding: "2px 7px",
                    borderRadius: 3,
                    background: "#F0FDF4",
                    color: "#166534",
                    letterSpacing: "0.04em",
                  }}
                >
                  🌿 Outdoor
                </span>
              )}
              {stop.indoorOutdoor === "indoor" && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    padding: "2px 7px",
                    borderRadius: 3,
                    background: "#F8FAFC",
                    color: "#475569",
                    letterSpacing: "0.04em",
                  }}
                >
                  🏛️ Indoor
                </span>
              )}
            </div>

            {/* Why note — hidden; AI rationale is internal only */}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type Step = "form" | "building" | "result";

// Build date options: today + 6 more days
function buildDateOptions() {
  const options: { label: string; short: string; date: Date }[] = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString("en-US", { weekday: "short" });
    const short = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    options.push({ label, short, date: d });
  }
  return options;
}

const DATE_OPTIONS = buildDateOptions();

// Parse "9:00 AM" / "2:30 PM" → minutes since midnight
function parseTimeToMinutes(t: string): number | null {
  const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let hrs = parseInt(m[1]);
  const mins = parseInt(m[2]);
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && hrs !== 12) hrs += 12;
  if (ampm === "AM" && hrs === 12) hrs = 0;
  return hrs * 60 + mins;
}

export default function PlanView({ homeCity }: { homeCity: string | null }) {
  const isAnonymous = !homeCity;
  const [step, setStep] = useState<Step>(isAnonymous ? "result" : "form");
  const [weather, setWeather] = useState<string>("70°F partly cloudy");
  const [plan, setPlan] = useState<DayPlan | null>(() => {
    // Anonymous visitors get an instant default plan — no form, no loading
    if (isAnonymous) {
      return buildDayPlan(
        { who: "couple", duration: "full-day", vibe: "mix", budget: "anything", date: new Date() },
        "70°F partly cloudy",
      );
    }
    return null;
  });

  // Form state with sensible defaults
  const [who, setWho] = useState<Who>("family-young");
  const [duration, setDuration] = useState<Duration>("full-day");
  const [vibe, setVibe] = useState<VibeType>("mix");
  const [budget, setBudget] = useState<BudgetType>("anything");
  const [selectedDateIdx, setSelectedDateIdx] = useState<number>(0);

  // Fetch weather silently on mount — also rebuild anonymous plan with real weather
  useEffect(() => {
    fetch("/api/weather")
      .then((r) => r.json())
      .then((d) => {
        if (d.weather) {
          setWeather(d.weather);
          // Rebuild anonymous plan with actual weather data
          if (isAnonymous) {
            setPlan(buildDayPlan(
              { who: "couple", duration: "full-day", vibe: "mix", budget: "anything", date: new Date() },
              d.weather,
            ));
          }
        }
      })
      .catch(() => {});
  }, [isAnonymous]);

  function handleBuild() {
    setStep("building");
    // Small artificial delay for UX polish
    setTimeout(() => {
      const result = buildDayPlan({ who, duration, vibe, budget, date: DATE_OPTIONS[selectedDateIdx].date, homeCity: homeCity ?? undefined }, weather);
      setPlan(result);
      setStep("result");
    }, 600);
  }

  function handleReset() {
    setStep("form");
    setPlan(null);
  }

  // For anonymous visitors, filter out stops whose time has already passed
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const visibleStops = plan?.stops.filter((stop) => {
    if (!isAnonymous) return true; // customized plans show everything
    const stopMin = parseTimeToMinutes(stop.time);
    if (stopMin === null) return true; // keep stops without parseable time
    return stopMin >= nowMinutes - 30; // 30min grace window
  }) ?? [];

  // ── Form ────────────────────────────────────────────────────────────────────

  if (step === "form" || step === "building") {
    return (
      <div className="plan-view">
        <div className="sb-section-header">
          <span className="sb-section-title">Plan My Day</span>
        </div>

        <p
          style={{
            fontSize: 15,
            color: "var(--sb-muted)",
            marginTop: 0,
            marginBottom: 28,
            lineHeight: 1.6,
          }}
        >
          Tell us a little about your day and we'll build a real South Bay
          itinerary — events that are actually happening, places worth going,
          matched to the weather.
        </p>

        {/* Date */}
        <div className="plan-section">
          <div className="plan-section-label">When?</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {DATE_OPTIONS.map((opt, i) => (
              <button
                key={i}
                onClick={() => setSelectedDateIdx(i)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: `1px solid ${selectedDateIdx === i ? "var(--sb-ink)" : "var(--sb-border)"}`,
                  background: selectedDateIdx === i ? "var(--sb-ink)" : "var(--sb-card)",
                  color: selectedDateIdx === i ? "white" : "var(--sb-muted)",
                  fontSize: 13,
                  fontWeight: selectedDateIdx === i ? 600 : 400,
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 1,
                  lineHeight: 1.2,
                  minWidth: 56,
                }}
              >
                <span style={{ fontWeight: 600 }}>{opt.label}</span>
                <span style={{ fontSize: 10, opacity: 0.7 }}>{opt.short}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Who */}
        <div className="plan-section">
          <div className="plan-section-label">Who's coming?</div>
          <div className="plan-options">
            {WHO_OPTIONS.map((o) => (
              <OptionPill
                key={o.id}
                emoji={o.emoji}
                label={o.label}
                active={who === o.id}
                onClick={() => setWho(o.id)}
              />
            ))}
          </div>
        </div>

        {/* Duration */}
        <div className="plan-section">
          <div className="plan-section-label">How much time?</div>
          <div className="plan-options">
            {DURATION_OPTIONS.map((o) => (
              <OptionPill
                key={o.id}
                emoji={o.emoji}
                label={o.label}
                sub={o.sub}
                active={duration === o.id}
                onClick={() => setDuration(o.id)}
              />
            ))}
          </div>
        </div>

        {/* Vibe */}
        <div className="plan-section">
          <div className="plan-section-label">Indoor or outdoor?</div>
          <div className="plan-options">
            {VIBE_OPTIONS.map((o) => (
              <OptionPill
                key={o.id}
                emoji={o.emoji}
                label={o.label}
                active={vibe === o.id}
                onClick={() => setVibe(o.id)}
              />
            ))}
          </div>
        </div>

        {/* Budget */}
        <div className="plan-section">
          <div className="plan-section-label">Budget?</div>
          <div className="plan-options">
            {BUDGET_OPTIONS.map((o) => (
              <OptionPill
                key={o.id}
                emoji={o.emoji}
                label={o.label}
                sub={o.sub}
                active={budget === o.id}
                onClick={() => setBudget(o.id)}
              />
            ))}
          </div>
        </div>

        {/* Build button */}
        <button
          onClick={handleBuild}
          disabled={step === "building"}
          className="plan-cta"
        >
          {step === "building" ? "Building your day…" : "Build My Day →"}
        </button>
      </div>
    );
  }

  // ── Result ──────────────────────────────────────────────────────────────────

  if (!plan) return null;

  return (
    <div className="plan-view">
      {/* Header */}
      <div className="sb-section-header">
        <span className="sb-section-title">Plan My Day</span>
      </div>

      {/* Headline */}
      <h2 className="plan-headline">{plan.headline}</h2>

      {/* Weather note */}
      <div className="plan-weather">
        <span style={{ fontSize: 14 }}>🌤️</span>
        <span>{plan.weatherNote}</span>
      </div>

      {/* Stops */}
      <div style={{ marginTop: 28 }}>
        {visibleStops.length === 0 ? (
          <p
            style={{
              color: "var(--sb-muted)",
              fontStyle: "italic",
              fontSize: 14,
            }}
          >
            {isAnonymous
              ? "Today's plan is winding down. Set your city for a personalized day tomorrow."
              : "No matching options found for those preferences. Try adjusting your filters."}
          </p>
        ) : (
          visibleStops.map((stop, i) => (
            <StopCard key={`${stop.title}-${i}`} stop={stop} />
          ))
        )}
      </div>

      {/* Actions */}
      <div
        style={{
          marginTop: 32,
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
          paddingTop: 20,
          borderTop: "1px solid var(--sb-border-light)",
        }}
      >
        {isAnonymous ? (
          <button onClick={() => { setStep("form"); setPlan(null); }} className="plan-cta plan-cta--secondary">
            Customize your day →
          </button>
        ) : (
          <button onClick={handleReset} className="plan-cta plan-cta--secondary">
            ← Start over
          </button>
        )}
        <span
          style={{
            fontSize: 12,
            color: "var(--sb-light)",
            lineHeight: 1.5,
          }}
        >
          {isAnonymous
            ? "A curated South Bay day based on today's real events and weather."
            : "Based on today's events, weather, and your preferences."}
        </span>
      </div>
    </div>
  );
}
