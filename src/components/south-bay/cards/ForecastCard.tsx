import { useState, useEffect } from "react";
import type { City } from "../../../lib/south-bay/types";

type ForecastDay = {
  date: string;
  emoji: string;
  desc: string;
  high: number;
  low: number;
  rainPct: number;
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function FogIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M 4 11 q 0 -2.5 2.5 -2.5 q 0.5 -3 4 -3 q 3.5 0 4.5 3 q 3 0 3 2.5 q 0 2.5 -3 2.5 l -8.5 0 q -2.5 0 -2.5 -2.5 z"
        fill="#94A3B8"
      />
      <g stroke="#94A3B8" strokeWidth={1.8} strokeLinecap="round">
        <line x1="4" y1="17" x2="20" y2="17" />
        <line x1="6" y1="20.5" x2="18" y2="20.5" />
      </g>
    </svg>
  );
}

interface Props {
  homeCity: City | null;
}

function ptTodayISO(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

export default function ForecastCard({ homeCity }: Props) {
  const [forecast, setForecast] = useState<ForecastDay[] | null>(null);
  const [todayISO, setTodayISO] = useState<string>(() => ptTodayISO());

  // Roll the PT date forward once per minute so a tab left open past
  // midnight refetches the forecast (dropping yesterday, marking the
  // new day as TODAY).
  useEffect(() => {
    const id = setInterval(() => {
      const next = ptTodayISO();
      setTodayISO((prev) => (prev === next ? prev : next));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const cityParam = homeCity ? `?city=${homeCity}` : "";
    fetch(`/api/weather${cityParam}`)
      .then((r) => r.json())
      .then((d) => setForecast(d.forecast ?? null))
      .catch(() => {});
  }, [homeCity, todayISO]);

  if (!forecast || forecast.length === 0) return null;

  const tempColor = (t: number) => {
    if (t >= 95) return "#C2290A";
    if (t >= 85) return "#E8531D";
    if (t >= 75) return "#D97706";
    if (t >= 65) return "#4D7C0F";
    if (t >= 55) return "#0284C7";
    return "#4F46E5";
  };
  const tempBg = (t: number, strong = false) => {
    const a = strong ? 0.10 : 0.05;
    if (t >= 95) return `rgba(194,41,10,${a})`;
    if (t >= 85) return `rgba(232,83,29,${a})`;
    if (t >= 75) return `rgba(217,119,6,${a})`;
    if (t >= 65) return `rgba(77,124,15,${a})`;
    if (t >= 55) return `rgba(2,132,199,${a})`;
    return `rgba(79,70,229,${a})`;
  };

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: `repeat(${forecast.length}, 1fr)`,
        border: "1.5px solid var(--sb-border-light)",
        borderRadius: 8,
        overflow: "hidden",
        background: "#fff",
      }}>
        {forecast.map((day, i) => {
          const isToday = day.date === todayISO;
          const d = new Date(day.date + "T12:00:00");
          const label = isToday ? "TODAY" : DAY_LABELS[d.getDay()].toUpperCase();
          const hasRainEmoji = /🌦|🌧|⛈|🌨/.test(day.emoji);
          const showRain = day.rainPct >= 20 || hasRainEmoji;
          const color = tempColor(day.high);
          const bg = tempBg(day.high, isToday);
          return (
            <div
              key={day.date}
              className="sbt-forecast-cell"
              style={{
                padding: "12px 4px 10px",
                textAlign: "center",
                borderRight: i < forecast.length - 1 ? "1px solid var(--sb-border-light)" : "none",
                background: bg,
                borderTop: isToday ? `3px solid ${color}` : "3px solid transparent",
              }}
            >
              <div style={{
                fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                letterSpacing: "0.08em",
                color: isToday ? color : "var(--sb-muted)",
                marginBottom: 6,
              }}>
                {label}
              </div>
              <div className="sbt-forecast-emoji" style={{ height: 28, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, lineHeight: 1, marginBottom: 6 }}>
                {day.emoji === "🌫️" || day.emoji === "🌫" ? <FogIcon size={26} /> : day.emoji}
              </div>
              <div className="sbt-forecast-temp" style={{
                fontSize: isToday ? 42 : 32,
                fontWeight: 800,
                lineHeight: 1,
                color,
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "-0.02em",
                marginBottom: 3,
              }}>
                {day.high}°
              </div>
              <div className="sbt-forecast-low" style={{
                fontSize: 11, color: "var(--sb-muted)",
                fontVariantNumeric: "tabular-nums",
              }}>
                {day.low}°
              </div>
              {showRain && (
                <div style={{
                  fontSize: 9, color: "#0284C7", fontWeight: 700,
                  marginTop: 4, fontVariantNumeric: "tabular-nums",
                  fontFamily: "'Space Mono', monospace",
                }}>
                  💧{day.rainPct}%
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
