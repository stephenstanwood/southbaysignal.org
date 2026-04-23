import permitPulseJson from "../../../data/south-bay/permit-pulse.json";
import type { City } from "../../../lib/south-bay/types";

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

const CATEGORY_ICON: Record<string, string> = {
  "multi-family-new": "🏘️",
  "residential-new": "🏠",
  "new-construction": "🏗️",
  "commercial-large": "🏢",
  "residential-large": "🔨",
  commercial: "🏪",
  entitlement: "📐",
};

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${n.toLocaleString()}`;
}

export default function PermitPulseCard() {
  // Regional view — show whatever city has data first.
  const data = Object.values(allData)[0] || null;
  if (!data || !data.permits || data.permits.length === 0) return null;

  const isRegional = true;
  const { stats, permits, dateRange, city, sourceUrl, source } = data;

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
            {isRegional ? `${city} (Regional) · ` : `${city} · `}{dateRange}
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
