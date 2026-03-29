import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import upcomingJson from "../../../data/south-bay/upcoming-events.json";
import {
  TECH_COMPANIES,
  TECH_PULSE,
  CATEGORY_LABELS,
  CHART_DATA,
  SCC_SPOTLIGHT,
  type TechCompany,
  type TechTrend,
  type SccTechSpotlight,
} from "../../../data/south-bay/tech-companies";

// ── Tooltip for chart ──────────────────────────────────────────────────────

interface TooltipPayload {
  payload?: { name: string; headcount: number; trend: TechTrend }; // headcount = sccEmployeesK
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.length || !payload[0].payload) return null;
  const d = payload[0].payload;
  const trendColor =
    d.trend === "up" ? "#16a34a" : d.trend === "down" ? "#dc2626" : "#6b7280";
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 4,
        padding: "8px 12px",
        fontSize: 12,
        boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
        fontFamily: "var(--sb-sans)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.name}</div>
      <div style={{ color: trendColor, fontWeight: 500 }}>
        {d.headcount.toLocaleString()}K SCC employees (est.)
      </div>
    </div>
  );
}

// ── Trend badge ────────────────────────────────────────────────────────────

function TrendBadge({ trend }: { trend: TechTrend }) {
  if (trend === "up")
    return (
      <span className="tech-trend tech-trend--up">▲ Growing</span>
    );
  if (trend === "down")
    return (
      <span className="tech-trend tech-trend--down">▼ Shrinking</span>
    );
  return <span className="tech-trend tech-trend--flat">— Stable</span>;
}

// ── Company card ───────────────────────────────────────────────────────────

function CompanyCard({ company }: { company: TechCompany }) {
  return (
    <div className="tech-card">
      <div className="tech-card-top">
        <div className="tech-card-identity">
          <span className="tech-card-name">{company.name}</span>
          {company.ticker && company.ticker !== "MSFT" && company.ticker !== "HPE" && (
            <span className="tech-card-ticker">{company.ticker}</span>
          )}
        </div>
        <TrendBadge trend={company.trend} />
      </div>

      <div className="tech-card-meta">
        <span className="tech-card-city">{company.city}</span>
        <span className="tech-card-dot">·</span>
        <span className="tech-card-category">{CATEGORY_LABELS[company.category]}</span>
        <span className="tech-card-dot">·</span>
        <span className="tech-card-headcount">{company.sccEmployeesK.toLocaleString()}K SCC jobs (est.)</span>
      </div>

      <p className="tech-card-desc">{company.description}</p>

      <div className="tech-card-trend-note">{company.trendNote}</div>

      <ul className="tech-card-highlights">
        {company.highlights.map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ul>
    </div>
  );
}

// ── Spotlight card (startups + mid-size) ───────────────────────────────────

const STAGE_LABELS: Record<SccTechSpotlight["stage"], string> = {
  public: "Public",
  growth: "Growth",
  startup: "Startup",
};

function SpotlightCard({ company }: { company: SccTechSpotlight }) {
  return (
    <div
      className="tech-spotlight-card"
      style={{ borderTop: `3px solid ${company.color}` }}
    >
      <div className="tech-spotlight-top">
        <a
          href={company.url}
          target="_blank"
          rel="noopener noreferrer"
          className="tech-spotlight-name"
          style={{ color: "inherit", textDecoration: "none" }}
        >
          {company.name} ↗
        </a>
        <span
          className="tech-spotlight-stage"
          style={{
            background: company.stage === "startup" ? "#fef3c7" : company.stage === "growth" ? "#dbeafe" : "#f3f4f6",
            color: company.stage === "startup" ? "#92400e" : company.stage === "growth" ? "#1e40af" : "#374151",
          }}
        >
          {STAGE_LABELS[company.stage]}
        </span>
      </div>
      <div className="tech-spotlight-city" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span>{company.city}</span>
        <span style={{ color: "var(--sb-border)" }}>·</span>
        <span style={{ fontSize: 11, color: "var(--sb-muted)" }}>{company.employeesNote}</span>
      </div>
      <p className="tech-spotlight-tagline">{company.tagline}</p>
    </div>
  );
}

// ── Hiring Pulse row ────────────────────────────────────────────────────────

function HiringRow({ company }: { company: TechCompany }) {
  const isUp = company.trend === "up";
  const isDown = company.trend === "down";
  const statusColor = isUp ? "#16a34a" : isDown ? "#dc2626" : "#6b7280";
  const statusBg = isUp ? "#f0fdf4" : isDown ? "#fef2f2" : "#f9fafb";
  const statusLabel = isUp ? "▲ Hiring" : isDown ? "▼ Reduced" : "→ Selective";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 0",
        borderBottom: "1px solid var(--sb-border-light)",
      }}
    >
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: statusColor,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
          {company.careersUrl ? (
            <a
              href={company.careersUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontWeight: 600,
                fontSize: 13,
                color: "var(--sb-ink)",
                textDecoration: "none",
                fontFamily: "var(--sb-sans)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
              onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
            >
              {company.name} ↗
            </a>
          ) : (
            <span style={{ fontWeight: 600, fontSize: 13, fontFamily: "var(--sb-sans)" }}>
              {company.name}
            </span>
          )}
          <span style={{ fontSize: 11, color: "var(--sb-muted)" }}>{company.city}</span>
        </div>
        <div style={{ fontSize: 11, color: "var(--sb-muted)", marginTop: 1, lineHeight: 1.4 }}>
          {company.trendNote}
        </div>
      </div>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          fontFamily: "'Space Mono', monospace",
          color: statusColor,
          background: statusBg,
          border: `1px solid ${statusColor}30`,
          borderRadius: 4,
          padding: "3px 7px",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {statusLabel}
      </span>
    </div>
  );
}

// ── Tech Events Near You ────────────────────────────────────────────────────

interface UpcomingEvent {
  id: string;
  title: string;
  date: string;
  time?: string | null;
  venue?: string;
  city?: string;
  url?: string;
  cost?: string;
  ongoing?: boolean;
}

const TECH_EVENT_KEYWORDS = /\b(ai|robot|silicon|tech|chip|algorithm|startup|venture|humanoid|digital|software|computer|hardware|machine learning|neural|innovation)\b/i;

function isTechEvent(e: UpcomingEvent): boolean {
  const isChm = !!e.venue?.toLowerCase().includes("computer history");
  const isTechTitle = TECH_EVENT_KEYWORDS.test(e.title);
  return isChm || isTechTitle;
}

function getTechEvents(): UpcomingEvent[] {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const events = (upcomingJson as { events: UpcomingEvent[] }).events;

  // CHM ongoing exhibits (deduplicate by venue, pick the best ones)
  const chmExhibits = events
    .filter((e) => e.venue?.toLowerCase().includes("computer history") && e.ongoing)
    .filter((e) => !["2026 Fellow Awards Ceremony", "Read Me", "To Infinity and Beyond"].includes(e.title));

  // Upcoming dated tech events
  const upcoming = events
    .filter((e) => !e.ongoing && e.date >= today && e.date <= cutoff && isTechEvent(e))
    .sort((a, b) => a.date.localeCompare(b.date));

  return [...chmExhibits.slice(0, 5), ...upcoming.slice(0, 5)];
}

function TechEventsSection() {
  const events = getTechEvents();
  if (events.length === 0) return null;

  const chmEvents = events.filter((e) => e.venue?.toLowerCase().includes("computer history"));
  const upcomingEvents = events.filter((e) => !e.venue?.toLowerCase().includes("computer history"));

  return (
    <div className="tech-section">
      <div className="tech-section-head">
        <h3 className="tech-section-title">Tech Events Near You</h3>
        <span className="tech-section-note">South Bay · Computer History Museum · upcoming talks</span>
      </div>

      {chmEvents.length > 0 && (
        <>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              fontFamily: "'Space Mono', monospace",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#6b7280",
              marginBottom: 10,
              paddingBottom: 6,
              borderBottom: "2px solid var(--sb-border-light)",
            }}
          >
            Computer History Museum · Mountain View · Ongoing Exhibits
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 10,
              marginBottom: upcomingEvents.length > 0 ? 20 : 0,
            }}
          >
            {chmEvents.map((e) => (
              <a
                key={e.id}
                href={e.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "block",
                  padding: "10px 12px",
                  border: "1px solid var(--sb-border-light)",
                  borderLeft: "3px solid #b45309",
                  borderRadius: 4,
                  textDecoration: "none",
                  color: "inherit",
                  background: "#fffbf5",
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: "var(--sb-sans)",
                  lineHeight: 1.3,
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={(el) => (el.currentTarget.style.borderLeftColor = "#92400e")}
                onMouseLeave={(el) => (el.currentTarget.style.borderLeftColor = "#b45309")}
              >
                {e.title}
                <div style={{ fontSize: 11, color: "var(--sb-muted)", fontWeight: 400, marginTop: 3 }}>
                  Ongoing exhibit · {e.cost === "paid" ? "Admission required" : "Free"}
                </div>
              </a>
            ))}
          </div>
        </>
      )}

      {upcomingEvents.length > 0 && (
        <>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              fontFamily: "'Space Mono', monospace",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#6b7280",
              marginBottom: 8,
              paddingBottom: 6,
              borderBottom: "2px solid var(--sb-border-light)",
            }}
          >
            Upcoming Tech Events
          </div>
          {upcomingEvents.map((e) => (
            <a
              key={e.id}
              href={e.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: "9px 0",
                borderBottom: "1px solid var(--sb-border-light)",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "var(--sb-muted)",
                  fontFamily: "'Space Mono', monospace",
                  whiteSpace: "nowrap",
                  minWidth: 72,
                  paddingTop: 1,
                }}
              >
                {new Date(e.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                {e.time ? <><br />{e.time}</> : null}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--sb-sans)", lineHeight: 1.3 }}>
                  {e.title} ↗
                </div>
                {e.venue && (
                  <div style={{ fontSize: 11, color: "var(--sb-muted)", marginTop: 2 }}>
                    {e.venue}
                    {e.city && ` · ${e.city.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`}
                  </div>
                )}
              </div>
              {e.cost === "free" && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#166534",
                    background: "#dcfce7",
                    border: "1px solid #bbf7d0",
                    borderRadius: 3,
                    padding: "2px 6px",
                    flexShrink: 0,
                    alignSelf: "center",
                    fontFamily: "'Space Mono', monospace",
                  }}
                >
                  FREE
                </span>
              )}
            </a>
          ))}
        </>
      )}
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────────────────

export default function TechnologyView() {
  const sortedCompanies = [...TECH_COMPANIES].sort(
    (a, b) => b.sccEmployeesK - a.sccEmployeesK
  );

  const hiringGroups = [
    {
      label: "Actively Hiring",
      note: "Growing headcount — AI, security, and SaaS leading the wave",
      companies: TECH_COMPANIES.filter((c) => c.trend === "up").sort(
        (a, b) => b.sccEmployeesK - a.sccEmployeesK
      ),
    },
    {
      label: "Selective Hiring",
      note: "Stable or post-restructuring — open roles but no broad expansion",
      companies: TECH_COMPANIES.filter((c) => c.trend === "flat").sort(
        (a, b) => b.sccEmployeesK - a.sccEmployeesK
      ),
    },
    {
      label: "Reduced Hiring",
      note: "Post-layoff recovery — limited openings, cautious on headcount",
      companies: TECH_COMPANIES.filter((c) => c.trend === "down").sort(
        (a, b) => b.sccEmployeesK - a.sccEmployeesK
      ),
    },
  ];

  return (
    <div className="tech-view">
      {/* ── Header ── */}
      <div className="tech-header">
        <div className="tech-header-eyebrow">South Bay</div>
        <h2 className="tech-header-title">Technology</h2>
        <p className="tech-header-subtitle">
          The companies headquartered in your backyard — and how many people
          they employ right here in Santa Clara County.
        </p>
        <div className="tech-header-note">
          Data snapshot · Q1 2026 · Santa Clara County employment estimates · Not affiliated with any company listed
        </div>
      </div>

      {/* ── Pulse strip ── */}
      <div className="tech-pulse">
        {TECH_PULSE.map((stat) => (
          <div key={stat.label} className="tech-pulse-item">
            <div className="tech-pulse-value">{stat.value}</div>
            <div className="tech-pulse-label">{stat.label}</div>
            <div className="tech-pulse-note">{stat.note}</div>
          </div>
        ))}
      </div>

      {/* ── Hiring Pulse ── */}
      <div className="tech-section">
        <div className="tech-section-head">
          <h3 className="tech-section-title">Hiring Pulse</h3>
          <span className="tech-section-note">Q1 2026 · South Bay tech hiring at a glance</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 24 }}>
          {hiringGroups.map((group) => (
            <div key={group.label}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: "'Space Mono', monospace",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: group.label === "Actively Hiring" ? "#16a34a" : group.label === "Reduced Hiring" ? "#dc2626" : "#6b7280",
                  marginBottom: 6,
                  paddingBottom: 6,
                  borderBottom: "2px solid var(--sb-border-light)",
                }}
              >
                {group.label}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--sb-muted)",
                  marginBottom: 8,
                  lineHeight: 1.4,
                  fontStyle: "italic",
                }}
              >
                {group.note}
              </div>
              {group.companies.map((company) => (
                <HiringRow key={company.id} company={company} />
              ))}
            </div>
          ))}
        </div>

        <div
          style={{
            marginTop: 12,
            fontSize: 11,
            color: "var(--sb-muted)",
            fontStyle: "italic",
          }}
        >
          Based on public filings, layoff announcements, and job board activity as of Q1 2026. Not investment advice.
          Career links go to each company's official jobs page.
        </div>
      </div>

      {/* ── Top Employers Chart ── */}
      <div className="tech-section">
        <div className="tech-section-head">
          <h3 className="tech-section-title">Top Employers</h3>
          <span className="tech-section-note">SCC local jobs, thousands · Top 10 by size</span>
        </div>

        <div className="tech-chart-wrap">
          <ResponsiveContainer width="100%" height={320}>
            <BarChart
              data={CHART_DATA}
              layout="vertical"
              margin={{ top: 4, right: 48, bottom: 4, left: 80 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                horizontal={false}
                stroke="#e5e7eb"
              />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "var(--sb-sans)" }}
                tickFormatter={(v) => `${v}K`}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 12, fill: "#374151", fontFamily: "var(--sb-sans)" }}
                width={76}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
              <Bar dataKey="headcount" radius={[0, 3, 3, 0]} maxBarSize={22}>
                {CHART_DATA.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.color}
                    opacity={entry.trend === "down" ? 0.55 : 0.9}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="tech-chart-legend">
          <span className="tech-legend-up">▲ Growing</span>
          <span className="tech-legend-down">▼ Shrinking (shown lighter)</span>
          <span className="tech-legend-note">Estimates only. Not investment advice.</span>
        </div>
      </div>

      {/* ── Company Grid ── */}
      <div className="tech-section">
        <div className="tech-section-head">
          <h3 className="tech-section-title">All Companies</h3>
          <span className="tech-section-note">Sorted by SCC local employment</span>
        </div>

        <div className="tech-grid">
          {sortedCompanies.map((company) => (
            <CompanyCard key={company.id} company={company} />
          ))}
        </div>
      </div>

      {/* ── Spotlight: Startups & More ── */}
      <div className="tech-section">
        <div className="tech-section-head">
          <h3 className="tech-section-title">More South Bay Tech</h3>
          <span className="tech-section-note">Notable SCC companies beyond the top employers</span>
        </div>
        <div className="tech-spotlight-grid">
          {SCC_SPOTLIGHT.map((company) => (
            <SpotlightCard key={company.id} company={company} />
          ))}
        </div>
      </div>

      {/* ── Tech Events Near You ── */}
      <TechEventsSection />

      {/* ── Footer note ── */}
      <div className="tech-footer-note">
        Employment figures are Santa Clara County estimates as of Q1 2026, derived from campus headcount reports,
        company filings, EDD data, and news coverage. Global headcounts are much larger. South Bay Signal is not
        affiliated with any company listed and this is not investment advice.
      </div>
    </div>
  );
}
