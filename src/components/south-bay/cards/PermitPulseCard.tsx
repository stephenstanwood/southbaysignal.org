import { useState } from "react";
import permitPulseJson from "../../../data/south-bay/permit-pulse.json";

interface Permit {
  id: string;
  address: string;
  category: string;
  categoryLabel: string;
  workType: string;
  description: string;
  valuation: number;
  units: number;
  issueDate: string;
  subtype: string;
}

interface PermitPulseData {
  generatedAt: string;
  city: string;
  source: string;
  sourceUrl: string;
  windowDays: number;
  dateRange: string;
  stats: {
    total: number;
    notable: number;
    newUnits: number;
    totalValuation: number;
  };
  permits: Permit[];
}

const allData = (permitPulseJson as { cities: Record<string, PermitPulseData> }).cities;

const CITY_LABELS: Record<string, string> = {
  "san-jose": "San José",
  "palo-alto": "Palo Alto",
  "sunnyvale": "Sunnyvale",
  "santa-clara": "Santa Clara",
  "mountain-view": "Mountain View",
  "cupertino": "Cupertino",
  "campbell": "Campbell",
  "milpitas": "Milpitas",
};

const CATEGORY_ICON: Record<string, string> = {
  "multi-family-new": "🏘️",
  "residential-new": "🏠",
  "new-construction": "🏗️",
  "commercial-large": "🏢",
  "residential-large": "🔨",
  "residential-remodel": "🛠️",
  commercial: "🏪",
  entitlement: "📐",
};

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${n.toLocaleString()}`;
}

export default function PermitPulseCard() {
  const cityKeys = Object.keys(allData).filter(
    (k) => allData[k]?.permits?.length > 0
  );
  const [activeCity, setActiveCity] = useState(cityKeys[0] ?? "");

  if (cityKeys.length === 0) return null;

  const data = allData[activeCity];
  if (!data) return null;
  const { stats, permits, dateRange, sourceUrl, source } = data;

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
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
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
            Permit Pulse
          </h2>
          <div
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 11,
              color: "#6B7280",
              marginTop: 2,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            {dateRange}
          </div>
        </div>
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: 11,
            color: "#9CA3AF",
            textDecoration: "none",
            letterSpacing: "0.02em",
          }}
        >
          Open Data ↗
        </a>
      </div>

      {/* City tabs — only shown when multiple cities have data */}
      {cityKeys.length > 1 && (
        <div
          style={{
            display: "flex",
            gap: 4,
            marginBottom: 14,
            borderBottom: "1px solid #E5E7EB",
            paddingBottom: 0,
          }}
        >
          {cityKeys.map((key) => {
            const label = CITY_LABELS[key] ?? key;
            const isActive = key === activeCity;
            return (
              <button
                key={key}
                onClick={() => setActiveCity(key)}
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 12,
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? "#1A1A1A" : "#6B7280",
                  background: "none",
                  border: "none",
                  borderBottom: isActive ? "2px solid #1A1A1A" : "2px solid transparent",
                  padding: "4px 10px 8px",
                  cursor: "pointer",
                  marginBottom: -1,
                  letterSpacing: "0.01em",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Stats row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 8,
          marginBottom: 16,
          background: "#F9FAFB",
          border: "1px solid #F3F4F6",
          borderRadius: 2,
          padding: "12px 16px",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 700, color: "#1A1A1A", lineHeight: 1 }}>
            {stats.total}
          </div>
          <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 10, color: "#6B7280", marginTop: 2, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Permits Issued
          </div>
        </div>
        <div style={{ textAlign: "center", borderLeft: "1px solid #E5E7EB", borderRight: "1px solid #E5E7EB" }}>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 700, color: "#1A1A1A", lineHeight: 1 }}>
            {stats.newUnits}
          </div>
          <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 10, color: "#6B7280", marginTop: 2, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            New Units
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 700, color: "#1A1A1A", lineHeight: 1 }}>
            {formatMoney(stats.totalValuation)}
          </div>
          <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 10, color: "#6B7280", marginTop: 2, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Total Value
          </div>
        </div>
      </div>

      {/* Permit list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {permits.map((permit, i) => (
          <div
            key={permit.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "9px 0",
              borderTop: i === 0 ? "none" : "1px solid #F3F4F6",
            }}
          >
            <div
              style={{
                flexShrink: 0,
                width: 28,
                height: 28,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "#F9FAFB",
                border: "1px solid #E5E7EB",
                borderRadius: 2,
                fontSize: 14,
              }}
            >
              {CATEGORY_ICON[permit.category] ?? "📋"}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#1A1A1A",
                  lineHeight: 1.3,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {permit.address}
              </div>
              <div
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 11,
                  color: "#6B7280",
                  marginTop: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {permit.description || permit.workType}
                {permit.units > 0 && ` · ${permit.units} unit${permit.units > 1 ? "s" : ""}`}
              </div>
            </div>

            <div style={{ flexShrink: 0, textAlign: "right" }}>
              <div
                style={{
                  display: "inline-block",
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 10,
                  fontWeight: 600,
                  color: "#C0392B",
                  background: "#FEF2F2",
                  border: "1px solid #FECACA",
                  borderRadius: 2,
                  padding: "1px 5px",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  marginBottom: 2,
                }}
              >
                {permit.categoryLabel}
              </div>
              {permit.valuation > 0 && (
                <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: "#374151", fontWeight: 500 }}>
                  {formatMoney(permit.valuation)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid #F3F4F6",
          fontFamily: "'Inter', sans-serif",
          fontSize: 10,
          color: "#9CA3AF",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>Source: {source}</span>
      </div>
    </section>
  );
}
