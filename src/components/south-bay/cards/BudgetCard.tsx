import cityBudgetsJson from "../../../data/south-bay/city-budgets.json";

interface Department {
  name: string;
  amount: number;
}

interface CityBudget {
  cityId: string;
  cityName: string;
  fiscalYear: string;
  population: number;
  totalBudget: number | null;
  generalFund: number | null;
  perCapitaGF: number | null;
  departments: Department[];
  notes: string;
  source: string;
}

const cityBudgets = cityBudgetsJson as CityBudget[];

function fmtMillions(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}b`;
  return `$${n.toFixed(1)}m`;
}

function fmtDollars(n: number): string {
  return `$${n.toLocaleString()}`;
}

interface Props {
  cityId: string | null;
}

export default function BudgetCard({ cityId }: Props) {
  if (!cityId) return null;

  const budget = cityBudgets.find((b) => b.cityId === cityId);
  if (!budget) return null;

  const hasData = budget.totalBudget !== null && budget.generalFund !== null;

  // Top 4 departments, Public Safety always first
  const topDepts = (() => {
    if (!budget.departments || budget.departments.length === 0) return [];
    const sorted = [...budget.departments].sort((a, b) => {
      if (a.name.toLowerCase().includes("public safety")) return -1;
      if (b.name.toLowerCase().includes("public safety")) return 1;
      return b.amount - a.amount;
    });
    return sorted.slice(0, 4);
  })();

  const truncatedNotes =
    budget.notes.length > 120 ? budget.notes.slice(0, 117) + "…" : budget.notes;

  return (
    <div
      style={{
        border: "1px solid var(--sb-border)",
        borderRadius: "var(--sb-radius)",
        padding: "14px 16px",
        marginBottom: 20,
        background: "#fff",
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: "var(--sb-ink)",
            fontFamily: "'Space Mono', monospace",
            letterSpacing: "-0.01em",
          }}
        >
          City Budget Snapshot
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--sb-accent)",
            background: "#FEF2F2",
            padding: "2px 7px",
            borderRadius: 3,
            letterSpacing: "0.02em",
            flexShrink: 0,
          }}
        >
          {budget.fiscalYear}
        </span>
      </div>

      {/* Stat chips */}
      {hasData ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 14,
            flexWrap: "wrap",
          }}
        >
          <StatChip label="Total Budget" value={fmtMillions(budget.totalBudget!)} />
          <StatChip label="General Fund" value={fmtMillions(budget.generalFund!)} />
          <StatChip
            label="Per Capita"
            value={`${fmtDollars(budget.perCapitaGF!)}/yr`}
          />
        </div>
      ) : (
        <div
          style={{
            fontSize: 12,
            color: "var(--sb-muted)",
            marginBottom: 14,
            fontStyle: "italic",
          }}
        >
          Data pending
        </div>
      )}

      {/* Dept mini-bar chart */}
      {hasData && topDepts.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--sb-muted)",
              marginBottom: 7,
              fontFamily: "'Space Mono', monospace",
            }}
          >
            Spending breakdown
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {topDepts.map((dept) => {
              const pct =
                budget.generalFund! > 0
                  ? Math.round((dept.amount / budget.generalFund!) * 100)
                  : 0;
              return (
                <div key={dept.name}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 2,
                    }}
                  >
                    <span style={{ fontSize: 11, color: "var(--sb-ink)" }}>
                      {dept.name}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        color: "var(--sb-muted)",
                        fontFamily: "'Space Mono', monospace",
                      }}
                    >
                      {pct}%
                    </span>
                  </div>
                  <div
                    style={{
                      height: 4,
                      background: "var(--sb-border-light, #e5e7eb)",
                      borderRadius: 2,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${pct}%`,
                        background: "var(--sb-accent)",
                        borderRadius: 2,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Notes */}
      <p
        style={{
          fontSize: 11,
          color: "var(--sb-muted)",
          margin: "0 0 10px 0",
          lineHeight: 1.45,
        }}
      >
        {truncatedNotes}
      </p>

      {/* Footer */}
      <div style={{ borderTop: "1px solid var(--sb-border-light, #e5e7eb)", paddingTop: 8 }}>
        <a
          href="https://stoa.works/portfolio/budget-dashboard"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: 11,
            color: "var(--sb-accent)",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Full 11-city comparison →
        </a>
      </div>
    </div>
  );
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        background: "var(--sb-light, #f8f8f5)",
        border: "1px solid var(--sb-border)",
        borderRadius: 4,
        padding: "5px 9px",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: "var(--sb-muted)",
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          fontFamily: "'Space Mono', monospace",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: "var(--sb-ink)",
          fontFamily: "'Space Mono', monospace",
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </span>
    </div>
  );
}
