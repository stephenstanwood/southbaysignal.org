import { useState } from "react";
import airQualityJson from "../../../data/south-bay/air-quality.json";
import type { City } from "../../../lib/south-bay/types";

interface CityAQI {
  id: string;
  name: string;
  aqi: number;
  level: string;
  label: string;
  color: string;
  textColor: string;
  primaryPollutant: string;
  pm25: number;
  pm10: number;
  ozone: number;
  recommendation: string;
}

interface AirQualityData {
  generatedAt: string;
  source: string;
  sourceUrl: string;
  southBayAvg: {
    aqi: number;
    level: string;
    label: string;
    color: string;
    textColor: string;
    recommendation: string;
  };
  cities: CityAQI[];
}

const data = airQualityJson as AirQualityData;

function AqiBadge({ aqi, label, color, textColor }: { aqi: number; label: string; color: string; textColor: string }) {
  // Use background tint for moderate/good to avoid eye-searing yellow
  const bg = label === "Good" ? "#D1FAE5" : label === "Moderate" ? "#FEF9C3" : color + "22";
  const text = label === "Good" ? "#065F46" : label === "Moderate" ? "#78350F" : textColor;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div
        style={{
          fontSize: 36,
          fontWeight: 800,
          fontFamily: "'Space Mono', monospace",
          color: text,
          lineHeight: 1,
          letterSpacing: "-1px",
        }}
      >
        {aqi}
      </div>
      <div>
        <div
          style={{
            display: "inline-block",
            padding: "2px 8px",
            borderRadius: 2,
            background: bg,
            color: text,
            fontSize: 11,
            fontWeight: 700,
            fontFamily: "'Space Mono', monospace",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: 10, color: "#6B7280", marginTop: 2, fontFamily: "'Inter', sans-serif" }}>
          US Air Quality Index
        </div>
      </div>
    </div>
  );
}

function AqiBar({ aqi }: { aqi: number }) {
  // AQI scale: 0-500, color bands
  const pct = Math.min(100, (aqi / 300) * 100);
  return (
    <div style={{ position: "relative", height: 6, borderRadius: 3, overflow: "hidden", marginTop: 8 }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(to right, #00E400 0%, #FFFF00 16%, #FF7E00 33%, #FF0000 50%, #8F3F97 66%, #7E0023 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "white",
          left: `${pct}%`,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: -2,
          left: `calc(${pct}% - 1px)`,
          width: 2,
          height: 10,
          background: "#111",
          borderRadius: 1,
        }}
      />
    </div>
  );
}

function formatAge(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

interface Props {
  homeCity: City | null;
}

export default function AirQualityCard({ homeCity }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!data.cities || data.cities.length === 0) return null;

  const cityData = homeCity
    ? data.cities.find((c) => c.id === homeCity) ?? data.cities[0]
    : null;

  const display = cityData ?? {
    ...data.southBayAvg,
    name: "South Bay",
    primaryPollutant: data.cities[0]?.primaryPollutant ?? "PM2.5",
    pm25: data.cities.reduce((s, c) => s + c.pm25, 0) / data.cities.length,
    pm10: data.cities.reduce((s, c) => s + c.pm10, 0) / data.cities.length,
    ozone: data.cities.reduce((s, c) => s + c.ozone, 0) / data.cities.length,
  };

  return (
    <section
      style={{
        background: "white",
        border: "1.5px solid #E5E7EB",
        borderRadius: 2,
        padding: "20px 24px",
        marginBottom: 24,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <h2
            style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: 18,
              fontWeight: 700,
              color: "#1A1A1A",
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            Air Quality
          </h2>
          <div style={{ fontSize: 11, color: "#6B7280", fontFamily: "'Inter', sans-serif", marginTop: 2 }}>
            {cityData ? cityData.name : "South Bay"} · Updated {formatAge(data.generatedAt)}
          </div>
        </div>
        <a
          href={data.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: "#9CA3AF", fontFamily: "'Inter', sans-serif", textDecoration: "none" }}
        >
          Open-Meteo ↗
        </a>
      </div>

      {/* AQI hero */}
      <AqiBadge
        aqi={display.aqi}
        label={display.label}
        color={display.color}
        textColor={display.textColor}
      />

      {/* AQI bar */}
      <AqiBar aqi={display.aqi} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
        <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "'Inter', sans-serif" }}>Good</span>
        <span style={{ fontSize: 9, color: "#9CA3AF", fontFamily: "'Inter', sans-serif" }}>Hazardous</span>
      </div>

      {/* Recommendation */}
      <div
        style={{
          marginTop: 12,
          padding: "8px 12px",
          background: "#F9FAFB",
          borderLeft: `3px solid ${display.color === "#FFFF00" ? "#F59E0B" : display.color}`,
          borderRadius: "0 2px 2px 0",
          fontSize: 12,
          color: "#374151",
          fontFamily: "'Inter', sans-serif",
          lineHeight: 1.5,
        }}
      >
        {display.recommendation}
      </div>

      {/* Pollutants */}
      <div style={{ display: "flex", gap: 16, marginTop: 14 }}>
        {[
          { label: "PM2.5", value: `${display.pm25.toFixed(1)} μg/m³` },
          { label: "PM10",  value: `${display.pm10.toFixed(1)} μg/m³` },
          { label: "Ozone", value: `${Math.round(display.ozone)} ppb` },
        ].map(({ label, value }) => (
          <div key={label} style={{ flex: 1, textAlign: "center" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", fontFamily: "'Inter', sans-serif" }}>
              {value}
            </div>
            <div style={{ fontSize: 10, color: "#9CA3AF", fontFamily: "'Inter', sans-serif", marginTop: 1 }}>
              {label}
            </div>
          </div>
        ))}
      </div>

      {/* Cities table (expandable) */}
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          marginTop: 14,
          display: "block",
          width: "100%",
          background: "none",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          fontSize: 11,
          fontWeight: 600,
          color: "#6B7280",
          fontFamily: "'Space Mono', monospace",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          padding: "6px 0 0",
          borderTop: "1px solid #F3F4F6",
        }}
      >
        {expanded ? "▲ Hide cities" : "▼ All cities"}
      </button>

      {expanded && (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "4px 0", color: "#9CA3AF", fontWeight: 600, fontFamily: "'Inter', sans-serif", fontSize: 10 }}>City</th>
              <th style={{ textAlign: "right", padding: "4px 0", color: "#9CA3AF", fontWeight: 600, fontFamily: "'Inter', sans-serif", fontSize: 10 }}>AQI</th>
              <th style={{ textAlign: "right", padding: "4px 0", color: "#9CA3AF", fontWeight: 600, fontFamily: "'Inter', sans-serif", fontSize: 10 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {[...data.cities]
              .sort((a, b) => b.aqi - a.aqi)
              .map((city) => {
                const isHome = city.id === homeCity;
                const bg = city.level === "good" ? "#D1FAE5" : city.level === "moderate" ? "#FEF9C3" : city.color + "22";
                const txt = city.level === "good" ? "#065F46" : city.level === "moderate" ? "#78350F" : city.textColor;
                return (
                  <tr
                    key={city.id}
                    style={{
                      background: isHome ? "#FAFAF5" : "transparent",
                      borderBottom: "1px solid #F3F4F6",
                    }}
                  >
                    <td style={{ padding: "5px 0", fontFamily: "'Inter', sans-serif", fontWeight: isHome ? 700 : 400, color: "#1F2937" }}>
                      {city.name}
                      {isHome && <span style={{ fontSize: 9, marginLeft: 4, color: "#9CA3AF" }}>HOME</span>}
                    </td>
                    <td style={{ textAlign: "right", padding: "5px 0", fontWeight: 700, fontFamily: "'Space Mono', monospace", color: "#1F2937" }}>
                      {city.aqi}
                    </td>
                    <td style={{ textAlign: "right", padding: "5px 4px" }}>
                      <span style={{ background: bg, color: txt, fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 2, fontFamily: "'Inter', sans-serif" }}>
                        {city.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      )}
    </section>
  );
}
