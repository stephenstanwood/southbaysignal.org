import { useState } from "react";
import realEstateJson from "../../../data/south-bay/real-estate.json";
import type { City } from "../../../lib/south-bay/types";

interface CityData {
  city: string;
  cityId: string;
  periodEnd: string;
  medianSalePrice: number | null;
  medianSalePriceYoy: number | null;
  inventory: number | null;
  medianDaysOnMarket: number | null;
  avgSaleToList: number | null;
  soldAboveListPct: number | null;
}

interface RealEstateData {
  cities: CityData[];
  generatedAt: string;
  source: string;
  sourceUrl: string;
  attribution: string;
}

const data = realEstateJson as RealEstateData;

type SortKey = "city" | "price" | "yoy" | "days";
type SortDir = "asc" | "desc";

function formatPrice(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${(n / 1000).toFixed(0)}K`;
}

function formatYoy(n: number | null): { label: string; up: boolean | null } {
  if (n == null) return { label: "—", up: null };
  const pct = (n * 100).toFixed(1);
  return { label: `${n >= 0 ? "+" : ""}${pct}%`, up: n >= 0 };
}

function formatPeriod(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function sortCities(cities: CityData[], key: SortKey, dir: SortDir): CityData[] {
  return [...cities].sort((a, b) => {
    let diff = 0;
    if (key === "city") {
      diff = a.city.localeCompare(b.city);
    } else if (key === "price") {
      diff = (a.medianSalePrice ?? -Infinity) - (b.medianSalePrice ?? -Infinity);
    } else if (key === "yoy") {
      diff = (a.medianSalePriceYoy ?? -Infinity) - (b.medianSalePriceYoy ?? -Infinity);
    } else if (key === "days") {
      diff = (a.medianDaysOnMarket ?? Infinity) - (b.medianDaysOnMarket ?? Infinity);
    }
    return dir === "asc" ? diff : -diff;
  });
}

interface Props {
  homeCity: City | null;
}

export default function RealEstateCard({ homeCity }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("price");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { cities, sourceUrl } = data;
  if (!cities || cities.length === 0) return null;

  const latestPeriod = cities[0]?.periodEnd ? formatPeriod(cities[0].periodEnd) : "";

  const filtered = cities.filter(
    (c) => !(c.medianSalePriceYoy != null && Math.abs(c.medianSalePriceYoy) > 0.4),
  );
  const sorted = sortCities(filtered, sortKey, sortDir);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Natural defaults: price/yoy desc (higher = more interesting), days asc (lower = hotter), city asc
      setSortDir(key === "days" || key === "city" ? "asc" : "desc");
    }
  }

  function SortIndicator({ k }: { k: SortKey }) {
    if (k !== sortKey) return <span style={{ opacity: 0.25, fontSize: 8 }}> ↕</span>;
    return <span style={{ fontSize: 8 }}> {sortDir === "desc" ? "↓" : "↑"}</span>;
  }

  const COLS: { key: SortKey; label: string }[] = [
    { key: "city",  label: "City" },
    { key: "price", label: "Median Sale" },
    { key: "yoy",   label: "vs. Last Year" },
    { key: "days",  label: "Days" },
  ];

  return (
    <div style={{ marginBottom: 32 }}>
      {/* Header */}
      <div className="sb-section-header" style={{ marginBottom: 12 }}>
        <span className="sb-section-title" style={{ fontSize: 15 }}>
          🏡 Housing Market
        </span>
        {latestPeriod && (
          <span style={{ fontSize: 11, color: "var(--sb-muted)", fontWeight: 500 }}>
            {latestPeriod}
          </span>
        )}
        <div className="sb-section-line" />
      </div>

      {/* Table */}
      <div style={{
        border: "1.5px solid var(--sb-border-light)",
        borderRadius: 8,
        overflow: "hidden",
        background: "#fff",
      }}>
        {/* Column headers */}
        <div className="re-grid" style={{
          display: "grid",
          gridTemplateColumns: "1fr 110px 90px 60px",
          padding: "6px 14px",
          background: "var(--sb-bg)",
          borderBottom: "1px solid var(--sb-border-light)",
        }}>
          {COLS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => handleSort(key)}
              style={{
                all: "unset",
                fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--sb-muted)",
                cursor: "pointer", userSelect: "none",
                display: "flex", alignItems: "center",
              }}
            >
              {label}<SortIndicator k={key} />
            </button>
          ))}
        </div>

        {/* Rows */}
        {sorted.map((c, i) => {
          const yoy = formatYoy(c.medianSalePriceYoy);
          const isHome = homeCity && c.cityId === homeCity;

          return (
            <div
              key={c.cityId}
              className="re-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 110px 90px 60px",
                padding: "8px 14px",
                borderBottom: i < sorted.length - 1 ? "1px solid var(--sb-border-light)" : "none",
                background: isHome ? "#FEFCE8" : "transparent",
                alignItems: "center",
              }}
            >
              <span style={{
                fontSize: 13, fontWeight: isHome ? 700 : 500,
                color: "var(--sb-ink)",
              }}>
                {c.city}
              </span>
              <span style={{
                fontSize: 13, fontWeight: 600, color: "var(--sb-ink)",
                fontVariantNumeric: "tabular-nums",
              }}>
                {formatPrice(c.medianSalePrice)}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                {yoy.up !== null && (
                  <span style={{ fontSize: 10 }}>{yoy.up ? "▲" : "▼"}</span>
                )}
                <span style={{
                  fontSize: 12,
                  color: yoy.up === null
                    ? "var(--sb-muted)"
                    : yoy.up ? "#15803D" : "#DC2626",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {yoy.label}
                </span>
              </div>
              <span style={{
                fontSize: 12, color: "var(--sb-muted)",
                fontVariantNumeric: "tabular-nums",
              }}>
                {c.medianDaysOnMarket != null ? `${c.medianDaysOnMarket}d` : "—"}
              </span>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ marginTop: 6, fontSize: 10, color: "var(--sb-light)" }}>
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 2 }}
        >
          Redfin Data Center
        </a>
        {" · All Residential · Low-volume cities excluded"}
      </div>
    </div>
  );
}
