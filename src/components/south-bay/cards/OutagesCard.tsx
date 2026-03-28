import outagesJson from "../../../data/south-bay/outages.json";

interface Outage {
  city: string;
  county: string;
  customers: number | null;
  cause: string | null;
  startedAt: string | null;
  etor: string | null;
  crewStatus: string | null;
}

interface OutageData {
  outages: Outage[];
  totalOutages: number;
  totalCustomers: number;
  generatedAt: string;
  source: string;
  sourceUrl: string;
  error?: string;
}

const data = outagesJson as OutageData;

function relativeTime(isoString: string | null): string {
  if (!isoString) return "";
  const d = new Date(isoString);
  const diffMs = Date.now() - d.getTime();
  const diffH = Math.floor(diffMs / 3600000);
  const diffM = Math.floor((diffMs % 3600000) / 60000);
  if (diffH > 0) return `${diffH}h ago`;
  if (diffM > 0) return `${diffM}m ago`;
  return "just now";
}

export default function OutagesCard() {
  const { outages, totalOutages, totalCustomers, sourceUrl } = data;

  // Don't render anything when there are no outages
  if (!outages || totalOutages === 0) return null;

  return (
    <div style={{
      marginBottom: 20,
      borderRadius: 8,
      border: "2px solid #FCA5A5",
      background: "#FEF2F2",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        background: "#EF4444",
        padding: "8px 14px",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}>
        <span style={{ fontSize: 14 }}>⚡</span>
        <span style={{
          fontSize: 12, fontWeight: 700, color: "#fff",
          fontFamily: "'Space Mono', monospace",
          letterSpacing: "0.06em", textTransform: "uppercase",
        }}>
          {totalOutages === 1 ? "1 Active Power Outage" : `${totalOutages} Active Power Outages`}
          {" · "}
          {totalCustomers.toLocaleString()} customers affected
        </span>
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            marginLeft: "auto",
            fontSize: 10, color: "rgba(255,255,255,0.8)",
            textDecoration: "underline", textUnderlineOffset: 2,
            fontWeight: 500,
          }}
        >
          PG&E map →
        </a>
      </div>

      {/* Outage rows */}
      <div style={{ padding: "8px 0" }}>
        {outages.map((o, i) => (
          <div
            key={i}
            style={{
              padding: "6px 14px",
              borderBottom: i < outages.length - 1 ? "1px solid #FECACA" : "none",
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13, fontWeight: 700, color: "#7F1D1D",
                display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
              }}>
                <span>{o.city || "Santa Clara County"}</span>
                {o.customers != null && (
                  <span style={{
                    fontSize: 10, fontWeight: 600, padding: "1px 6px",
                    borderRadius: 3, background: "#FEE2E2", color: "#991B1B",
                  }}>
                    {o.customers.toLocaleString()} customers
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: "#B91C1C", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {o.cause && <span>{o.cause}</span>}
                {o.startedAt && <span style={{ opacity: 0.8 }}>Started {relativeTime(o.startedAt)}</span>}
                {o.etor && <span>ERT: {o.etor}</span>}
                {o.crewStatus && <span style={{ opacity: 0.8 }}>· {o.crewStatus}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
