import { useState, useEffect } from "react";

// USGS Instantaneous Values API — no key required, public domain government data
// South Bay stream gauges: key creeks and rivers in Santa Clara County

interface Gauge {
  id: string;
  name: string;
  location: string;
  normalMaxCfs: number;   // below = Normal
  elevatedMaxCfs: number; // below = Elevated, above = High
}

const GAUGES: Gauge[] = [
  { id: "11164500", name: "San Francisquito Creek", location: "Stanford",      normalMaxCfs: 25,  elevatedMaxCfs: 100 },
  { id: "11169025", name: "Guadalupe River",        location: "San Jose",      normalMaxCfs: 80,  elevatedMaxCfs: 400 },
  { id: "11169500", name: "Saratoga Creek",         location: "Saratoga",      normalMaxCfs: 15,  elevatedMaxCfs: 75  },
  { id: "11170000", name: "Coyote Creek",           location: "S. San Jose",   normalMaxCfs: 50,  elevatedMaxCfs: 300 },
  { id: "11172175", name: "Coyote Creek",           location: "Milpitas",      normalMaxCfs: 75,  elevatedMaxCfs: 500 },
];

const SITE_IDS = GAUGES.map((g) => g.id).join(",");
const USGS_URL =
  `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${SITE_IDS}&parameterCd=00060&period=P1D`;

interface Reading {
  siteId: string;
  cfs: number;
  trend: "rising" | "stable" | "falling";
  updatedAt: string; // ISO datetime
}

type Status = "normal" | "elevated" | "high" | "unknown";

function getStatus(cfs: number, gauge: Gauge): Status {
  if (cfs < 0) return "unknown";
  if (cfs <= gauge.normalMaxCfs) return "normal";
  if (cfs <= gauge.elevatedMaxCfs) return "elevated";
  return "high";
}

const STATUS_CONFIG: Record<Status, { label: string; dot: string; bg: string; text: string }> = {
  normal:   { label: "Normal",   dot: "#2563EB", bg: "#EFF6FF", text: "#1E40AF" },
  elevated: { label: "Elevated", dot: "#D97706", bg: "#FFFBEB", text: "#92400E" },
  high:     { label: "High",     dot: "#DC2626", bg: "#FEF2F2", text: "#991B1B" },
  unknown:  { label: "No data",  dot: "#9CA3AF", bg: "#F9FAFB", text: "#6B7280" },
};

function TrendArrow({ trend }: { trend: "rising" | "stable" | "falling" }) {
  if (trend === "rising")  return <span style={{ color: "#DC2626", fontSize: 11 }}>▲</span>;
  if (trend === "falling") return <span style={{ color: "#2563EB", fontSize: 11 }}>▼</span>;
  return <span style={{ color: "#9CA3AF", fontSize: 11 }}>—</span>;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

export default function WaterWatchCard() {
  const [readings, setReadings] = useState<Reading[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(USGS_URL)
      .then((r) => r.json())
      .then((d) => {
        const tsList: any[] = d?.value?.timeSeries ?? [];
        const result: Reading[] = [];

        for (const ts of tsList) {
          const siteId = ts?.sourceInfo?.siteCode?.[0]?.value;
          if (!siteId) continue;

          const values: Array<{ value: string; dateTime: string }> =
            ts?.values?.[0]?.value ?? [];

          // Filter valid readings
          const valid = values
            .map((v) => ({ cfs: parseFloat(v.value), dt: v.dateTime }))
            .filter((v) => !isNaN(v.cfs) && v.cfs >= 0);

          if (valid.length === 0) continue;

          const latest = valid[valid.length - 1];
          // ~6h back: readings every 15 min → 24 intervals
          const h6Idx = Math.max(0, valid.length - 25);
          const h6 = valid[h6Idx].cfs;

          const trendRatio = latest.cfs / (h6 || 0.001);
          const trend: "rising" | "stable" | "falling" =
            trendRatio > 1.12 ? "rising" : trendRatio < 0.88 ? "falling" : "stable";

          result.push({ siteId, cfs: latest.cfs, trend, updatedAt: latest.dt });
        }

        setReadings(result);
      })
      .catch(() => setError(true));
  }, []);

  if (error) return null;

  const loading = readings === null;

  // Pair gauges with readings
  const rows = GAUGES.map((gauge) => {
    const reading = readings?.find((r) => r.siteId === gauge.id);
    return { gauge, reading };
  });

  // Count any elevated/high
  const alertCount = rows.filter(({ gauge, reading }) => {
    if (!reading) return false;
    const s = getStatus(reading.cfs, gauge);
    return s === "elevated" || s === "high";
  }).length;

  const lastUpdated = readings
    ? readings.reduce((latest, r) => (r.updatedAt > latest ? r.updatedAt : latest), "")
    : null;

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
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 16,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              fontFamily: "'Space Mono', monospace",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "#6B7280",
              marginBottom: 2,
            }}
          >
            South Bay
          </div>
          <h3
            style={{
              margin: 0,
              fontSize: 16,
              fontWeight: 700,
              fontFamily: "var(--sb-sans)",
              color: "#111827",
              letterSpacing: "-0.3px",
            }}
          >
            Stream Watch
          </h3>
          <p
            style={{
              margin: "3px 0 0",
              fontSize: 12,
              color: "#6B7280",
              fontFamily: "var(--sb-sans)",
            }}
          >
            Live creek and river flow levels
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {alertCount > 0 && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                fontFamily: "'Space Mono', monospace",
                color: "#D97706",
                background: "#FEF3C7",
                border: "1px solid #FDE68A",
                borderRadius: 4,
                padding: "3px 8px",
              }}
            >
              {alertCount} elevated
            </span>
          )}
          {alertCount === 0 && !loading && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                fontFamily: "'Space Mono', monospace",
                color: "#065F46",
                background: "#D1FAE5",
                border: "1px solid #A7F3D0",
                borderRadius: 4,
                padding: "3px 8px",
              }}
            >
              All normal
            </span>
          )}
        </div>
      </div>

      {/* Gauge rows */}
      <div>
        {rows.map(({ gauge, reading }, i) => {
          const status: Status = reading ? getStatus(reading.cfs, gauge) : "unknown";
          const cfg = STATUS_CONFIG[status];
          const isLast = i === rows.length - 1;

          return (
            <div
              key={gauge.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 0",
                borderBottom: isLast ? "none" : "1px solid #F3F4F6",
              }}
            >
              {/* Status dot */}
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: cfg.dot,
                  flexShrink: 0,
                  marginTop: 1,
                }}
              />

              {/* Name + location */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      fontFamily: "var(--sb-sans)",
                      color: "#111827",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {gauge.name}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: "#9CA3AF",
                      fontFamily: "var(--sb-sans)",
                    }}
                  >
                    {gauge.location}
                  </span>
                </div>
              </div>

              {/* Flow + trend */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexShrink: 0,
                }}
              >
                {loading ? (
                  <span
                    style={{
                      fontSize: 12,
                      color: "#D1D5DB",
                      fontFamily: "'Space Mono', monospace",
                    }}
                  >
                    —
                  </span>
                ) : reading ? (
                  <>
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        fontFamily: "'Space Mono', monospace",
                        color: "#374151",
                      }}
                    >
                      {reading.cfs < 10
                        ? reading.cfs.toFixed(1)
                        : Math.round(reading.cfs).toLocaleString()}{" "}
                      <span style={{ fontWeight: 400, fontSize: 10, color: "#9CA3AF" }}>cfs</span>
                    </span>
                    <TrendArrow trend={reading.trend} />
                  </>
                ) : (
                  <span
                    style={{
                      fontSize: 11,
                      color: "#9CA3AF",
                      fontFamily: "var(--sb-sans)",
                    }}
                  >
                    No data
                  </span>
                )}
              </div>

              {/* Status badge */}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: "'Space Mono', monospace",
                  color: cfg.text,
                  background: cfg.bg,
                  border: `1px solid ${cfg.dot}30`,
                  borderRadius: 4,
                  padding: "3px 7px",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                  width: 62,
                  textAlign: "center",
                }}
              >
                {cfg.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div
        style={{
          marginTop: 12,
          fontSize: 11,
          color: "#9CA3AF",
          fontFamily: "var(--sb-sans)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span>
          USGS National Water Information System ·{" "}
          <a
            href="https://waterdata.usgs.gov/ca/nwis/rt"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#6B7280", textDecoration: "underline" }}
          >
            realtime data ↗
          </a>
        </span>
        {lastUpdated && (
          <span>Updated {timeAgo(lastUpdated)}</span>
        )}
      </div>
    </section>
  );
}
