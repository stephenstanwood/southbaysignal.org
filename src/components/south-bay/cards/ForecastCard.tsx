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

interface Props {
  homeCity: City | null;
}

export default function ForecastCard({ homeCity }: Props) {
  const [forecast, setForecast] = useState<ForecastDay[] | null>(null);

  useEffect(() => {
    const cityParam = homeCity ? `?city=${homeCity}` : "";
    fetch(`/api/weather${cityParam}`)
      .then((r) => r.json())
      .then((d) => setForecast(d.forecast ?? null))
      .catch(() => {});
  }, [homeCity]);

  if (!forecast || forecast.length === 0) return null;

  const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

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
          const label = isToday ? "Today" : DAY_LABELS[d.getDay()];
          const showRain = day.rainPct >= 20;
          return (
            <div
              key={day.date}
              style={{
                padding: "10px 6px 8px",
                textAlign: "center",
                borderRight: i < forecast.length - 1 ? "1px solid var(--sb-border-light)" : "none",
                background: isToday ? "var(--sb-primary-light)" : "transparent",
              }}
            >
              <div style={{
                fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                letterSpacing: "0.06em", textTransform: "uppercase",
                color: isToday ? "var(--sb-ink)" : "var(--sb-muted)",
                marginBottom: 4,
              }}>
                {label}
              </div>
              <div style={{ fontSize: 18, lineHeight: 1, marginBottom: 4 }}>{day.emoji}</div>
              <div style={{
                fontSize: 12, fontWeight: 700, color: "var(--sb-ink)",
                fontVariantNumeric: "tabular-nums",
              }}>
                {day.high}°
              </div>
              <div style={{
                fontSize: 11, color: "var(--sb-muted)",
                fontVariantNumeric: "tabular-nums",
              }}>
                {day.low}°
              </div>
              {showRain && (
                <div style={{
                  fontSize: 9, color: "#1d4ed8", fontWeight: 600,
                  marginTop: 3, fontVariantNumeric: "tabular-nums",
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
