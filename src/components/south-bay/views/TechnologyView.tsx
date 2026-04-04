import { useState } from "react";
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
import techBriefingJson from "../../../data/south-bay/tech-briefing.json";
import upcomingMeetingsJson from "../../../data/south-bay/upcoming-meetings.json";
import apodJson from "../../../data/south-bay/apod.json";
import {
  TECH_COMPANIES,
  TECH_PULSE,
  CATEGORY_LABELS,
  CHART_DATA,
  SCC_SPOTLIGHT,
  RECENTLY_FUNDED,
  TECH_MILESTONES,
  TECH_CONFERENCES,
  type TechCompany,
  type TechTrend,
  type SccTechSpotlight,
  type RecentlyFunded,
  type TechMilestone,
  type TechConference,
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

// ── Gov × Tech callout ────────────────────────────────────────────────────

const GOV_TECH_KEYWORDS = /\b(ai|artificial intelligence|govai|energy storage|battery storage|ev |electric vehicle|autonomous|robot|startup|innovation|chip|semiconductor|broadband|5g|fiber optic|automation|data center|software|digital infrastructure)\b/i;

interface GovTechItem {
  city: string;
  date: string;
  displayDate: string;
  title: string;
  url: string;
}

interface MeetingAgendaItem {
  title: string;
  sequence: number;
}

interface UpcomingMeeting {
  date: string;
  displayDate: string;
  bodyName: string;
  url: string;
  agendaItems: MeetingAgendaItem[];
}

function getGovTechItems(): GovTechItem[] {
  const data = upcomingMeetingsJson as { meetings: Record<string, UpcomingMeeting> };
  const results: GovTechItem[] = [];
  for (const [cityId, meeting] of Object.entries(data.meetings)) {
    const cityName = cityId.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    for (const item of meeting.agendaItems) {
      if (GOV_TECH_KEYWORDS.test(item.title)) {
        results.push({
          city: cityName,
          date: meeting.date,
          displayDate: meeting.displayDate,
          title: item.title.replace(/\.$/, ""),
          url: meeting.url,
        });
      }
    }
  }
  results.sort((a, b) => a.date.localeCompare(b.date));
  return results.slice(0, 5);
}

function GovTechCallout() {
  const items = getGovTechItems();
  if (items.length === 0) return null;
  return (
    <div className="tech-section">
      <div className="tech-section-head">
        <h3 className="tech-section-title">City Hall × Tech</h3>
        <span className="tech-section-note">Tech-relevant items on upcoming council agendas</span>
      </div>
      {items.map((item, i) => (
        <a
          key={i}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: "10px 0",
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
              minWidth: 80,
              paddingTop: 2,
            }}
          >
            {item.displayDate}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "var(--sb-sans)",
                lineHeight: 1.3,
                color: "var(--sb-ink)",
              }}
            >
              {item.title} ↗
            </div>
            <div style={{ fontSize: 11, color: "var(--sb-muted)", marginTop: 2 }}>
              {item.city} City Council
            </div>
          </div>
        </a>
      ))}
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

const TECH_EVENT_KEYWORDS = /\b(ai|robot|silicon|tech|chip|algorithm|startup|venture|humanoid|machine learning|neural|innovation|physical ai|autonomous)\b/i;
const TECH_EVENT_EXCLUDES = /\bhelp\b|digital skills|computer help|tech help|1-on-1|one-on-one/i;

function isTechEvent(e: UpcomingEvent): boolean {
  const isChm = !!e.venue?.toLowerCase().includes("computer history");
  const isTechTitle = TECH_EVENT_KEYWORDS.test(e.title) && !TECH_EVENT_EXCLUDES.test(e.title);
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

// ── Recently Funded ────────────────────────────────────────────────────────

const ROUND_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  "Seed":      { bg: "#fef3c7", color: "#92400e", border: "#fcd34d" },
  "Pre-Seed":  { bg: "#fef3c7", color: "#92400e", border: "#fcd34d" },
  "Series A":  { bg: "#dbeafe", color: "#1e40af", border: "#93c5fd" },
  "Series A1": { bg: "#dbeafe", color: "#1e40af", border: "#93c5fd" },
  "Series B":  { bg: "#f3e8ff", color: "#6b21a8", border: "#c4b5fd" },
  "Series C":  { bg: "#fce7f3", color: "#9d174d", border: "#f9a8d4" },
  "Series D":  { bg: "#fff7ed", color: "#9a3412", border: "#fdba74" },
  "Series E":  { bg: "#ecfdf5", color: "#065f46", border: "#6ee7b7" },
  "Series F":  { bg: "#fdf4ff", color: "#581c87", border: "#d8b4fe" },
  "Series F+": { bg: "#fdf4ff", color: "#581c87", border: "#d8b4fe" },
  "Strategic":   { bg: "#f0fdf4", color: "#166534", border: "#86efac" },
  "Convertible": { bg: "#f0f9ff", color: "#0369a1", border: "#7dd3fc" },
};

function RoundBadge({ round }: { round: string }) {
  const style = ROUND_COLORS[round] ?? { bg: "#f3f4f6", color: "#374151", border: "#d1d5db" };
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        fontFamily: "'Space Mono', monospace",
        letterSpacing: "0.04em",
        background: style.bg,
        color: style.color,
        border: `1px solid ${style.border}`,
        borderRadius: 3,
        padding: "2px 6px",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {round}
    </span>
  );
}

function RecentlyFundedCard({ company }: { company: RecentlyFunded }) {
  const d = new Date(company.date + "T12:00:00");
  const dateLabel = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <div
      style={{
        padding: "14px 0",
        borderBottom: "1px solid var(--sb-border-light)",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      {/* Color bar */}
      <div
        style={{
          width: 3,
          alignSelf: "stretch",
          background: company.color,
          borderRadius: 2,
          flexShrink: 0,
          minHeight: 40,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 4,
          }}
        >
          <a
            href={company.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontWeight: 700,
              fontSize: 14,
              color: "var(--sb-ink)",
              textDecoration: "none",
              fontFamily: "var(--sb-sans)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
            onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
          >
            {company.name} ↗
          </a>
          <RoundBadge round={company.round} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#16a34a",
              fontFamily: "var(--sb-sans)",
            }}
          >
            {company.amount}
          </span>
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--sb-muted)",
            marginBottom: 5,
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span>{company.city}</span>
          <span style={{ color: "var(--sb-border)" }}>·</span>
          <span>{CATEGORY_LABELS[company.category as keyof typeof CATEGORY_LABELS] ?? company.category}</span>
          <span style={{ color: "var(--sb-border)" }}>·</span>
          <span>{dateLabel}</span>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: "#374151",
            lineHeight: 1.5,
            fontFamily: "var(--sb-sans)",
          }}
        >
          {company.tagline}
        </p>
      </div>
    </div>
  );
}

// Q1 2026 stats — derived from RECENTLY_FUNDED, hardcoded for display accuracy
const Q1_2026_ROUNDS = RECENTLY_FUNDED.filter(
  (r) => r.date >= "2026-01-01" && r.date <= "2026-03-31"
).length;

const EARLY_STAGES = new Set(["Seed", "Pre-Seed", "Series A", "Series A1"]);

function RecentlyFundedSection() {
  const [stageFilter, setStageFilter] = useState<"all" | "early">("all");
  const sorted = [...RECENTLY_FUNDED].sort((a, b) => b.date.localeCompare(a.date));
  const earlyCount = sorted.filter((r) => EARLY_STAGES.has(r.round)).length;
  const filtered = stageFilter === "early" ? sorted.filter((r) => EARLY_STAGES.has(r.round)) : sorted;
  return (
    <div className="tech-section">
      <div className="tech-section-head">
        <h3 className="tech-section-title">Recently Funded</h3>
        <span className="tech-section-note">South Bay startups · Q4 2025 – Q2 2026 · {RECENTLY_FUNDED.length} rounds</span>
      </div>

      {/* Q1 2026 Recap */}
      <div
        style={{
          display: "flex",
          gap: 0,
          marginBottom: 18,
          border: "1px solid var(--sb-border-light)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flex: 1,
            padding: "12px 14px",
            background: "#fdf4ff",
            borderRight: "1px solid var(--sb-border-light)",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'Space Mono', monospace", color: "#581c87", lineHeight: 1 }}>$3.2B+</div>
          <div style={{ fontSize: 10, color: "#6b21a8", fontFamily: "'Space Mono', monospace", marginTop: 4, letterSpacing: "0.04em" }}>Q1 2026 RAISED</div>
        </div>
        <div
          style={{
            flex: 1,
            padding: "12px 14px",
            background: "#f5f3ff",
            borderRight: "1px solid var(--sb-border-light)",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'Space Mono', monospace", color: "#4c1d95", lineHeight: 1 }}>{Q1_2026_ROUNDS}</div>
          <div style={{ fontSize: 10, color: "#5b21b6", fontFamily: "'Space Mono', monospace", marginTop: 4, letterSpacing: "0.04em" }}>Q1 ROUNDS</div>
        </div>
        <div
          style={{
            flex: 2,
            padding: "12px 14px",
            background: "#fafaf9",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--sb-ink)", fontFamily: "var(--sb-sans)", marginBottom: 3 }}>Q1 2026 — South Bay VC wrap</div>
          <div style={{ fontSize: 11, color: "var(--sb-muted)", lineHeight: 1.5 }}>Three $500M rounds (Nexthop AI, MatX, Ayar Labs) anchored the quarter. Chips, robotics, and AI networking dominated deal flow.</div>
        </div>
      </div>

      {/* Stage filter */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {(["all", "early"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setStageFilter(f)}
            style={{
              padding: "4px 12px",
              fontSize: 11,
              fontWeight: 700,
              fontFamily: "'Space Mono', monospace",
              letterSpacing: "0.04em",
              border: `1px solid ${stageFilter === f ? "#7c3aed" : "var(--sb-border-light)"}`,
              borderRadius: 4,
              background: stageFilter === f ? "#7c3aed" : "#fff",
              color: stageFilter === f ? "#fff" : "var(--sb-muted)",
              cursor: "pointer",
            }}
          >
            {f === "all" ? `All (${sorted.length})` : `Early Stage (${earlyCount})`}
          </button>
        ))}
      </div>

      <div>
        {filtered.map((company) => (
          <RecentlyFundedCard key={company.id} company={company} />
        ))}
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 11,
          color: "var(--sb-muted)",
          fontStyle: "italic",
        }}
      >
        Verified from public announcements and news coverage. Not investment advice.
      </div>
    </div>
  );
}

// ── This Week in SV History ────────────────────────────────────────────────

function getActiveMilestones(): TechMilestone[] {
  const now = new Date();
  const WINDOW_DAYS = 8; // show milestone if within ±8 days
  return TECH_MILESTONES.filter((m) => {
    // Build a date for this milestone in the current year
    const mDate = new Date(now.getFullYear(), m.month - 1, m.day);
    const diff = Math.abs(mDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return diff <= WINDOW_DAYS;
  });
}

function milestoneAge(m: TechMilestone): number {
  return new Date().getFullYear() - m.foundedYear;
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  if (n % 10 === 1) return `${n}st`;
  if (n % 10 === 2) return `${n}nd`;
  if (n % 10 === 3) return `${n}rd`;
  return `${n}th`;
}

function SvHistorySection() {
  const milestones = getActiveMilestones();
  if (milestones.length === 0) return null;

  return (
    <div className="tech-section">
      <div className="tech-section-head">
        <h3 className="tech-section-title">This Week in SV History</h3>
        <span className="tech-section-note">Local company milestones happening right now</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {milestones.map((m) => {
          const age = milestoneAge(m);
          return (
            <div
              key={m.id}
              style={{
                display: "flex",
                gap: 14,
                padding: "14px 16px",
                background: "#fdf8f0",
                border: "1px solid var(--sb-border-light)",
                borderLeft: "4px solid #b45309",
                borderRadius: 6,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    flexWrap: "wrap",
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: "var(--sb-ink)",
                      fontFamily: "var(--sb-sans)",
                    }}
                  >
                    {m.company}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      fontFamily: "'Space Mono', monospace",
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "#b45309",
                      background: "#fef3c7",
                      padding: "2px 7px",
                      borderRadius: 3,
                    }}
                  >
                    {ordinal(age)} anniversary
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--sb-muted)",
                      fontFamily: "var(--sb-sans)",
                    }}
                  >
                    {m.city} · est. {m.foundedYear}
                  </span>
                </div>

                <p
                  style={{
                    margin: "0 0 6px",
                    fontSize: 13,
                    lineHeight: 1.55,
                    color: "var(--sb-ink)",
                  }}
                >
                  {m.anniversaryNote}
                </p>

                {m.chmExhibit && (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 11,
                      color: "#1d4ed8",
                      background: "#eff6ff",
                      border: "1px solid #bfdbfe",
                      borderRadius: 4,
                      padding: "3px 8px",
                      marginTop: 2,
                    }}
                  >
                    <span>🏛️</span>
                    <span>
                      Computer History Museum:{" "}
                      <strong>{m.chmExhibit}</strong>
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Annual Tech Conferences ────────────────────────────────────────────────

const MONTH_NAMES_FULL = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function getConferenceNextDate(conf: TechConference, now: Date): { label: string; sortMs: number; isUpcoming: boolean } {
  const currentMonth = now.getMonth() + 1;
  const year = conf.typicalMonth < currentMonth ? now.getFullYear() + 1 : now.getFullYear();
  const monthName = MONTH_NAMES_FULL[conf.typicalMonth - 1];
  const approxDay = conf.typicalDay ?? 15;
  const targetMs = new Date(year, conf.typicalMonth - 1, approxDay).getTime();
  const diffDays = (targetMs - now.getTime()) / (1000 * 60 * 60 * 24);
  const isUpcoming = diffDays >= -7 && diffDays <= 90;
  let label = `${monthName} ${year}`;
  if (conf.typicalDay) {
    label = conf.typicalEndDay
      ? `${monthName} ${conf.typicalDay}–${conf.typicalEndDay}, ${year}`
      : `${monthName} ${conf.typicalDay}, ${year}`;
  }
  return { label, sortMs: targetMs, isUpcoming };
}

function ConferenceRow({ conf, dateLabel, highlight }: { conf: TechConference; dateLabel: string; highlight: boolean }) {
  const scaleStyle = conf.scale === "global"
    ? { bg: "#eff6ff", color: "#1e40af", border: "#bfdbfe", text: "Global" }
    : { bg: "#f0fdf4", color: "#166534", border: "#bbf7d0", text: "Regional" };
  return (
    <a
      href={conf.url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "11px 0",
        borderBottom: "1px solid var(--sb-border-light)",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div style={{ minWidth: 82, paddingTop: 2, flexShrink: 0 }}>
        <div style={{
          fontSize: 11,
          fontFamily: "'Space Mono', monospace",
          color: highlight ? "#16a34a" : "var(--sb-muted)",
          fontWeight: highlight ? 700 : 400,
          lineHeight: 1.3,
        }}>
          {dateLabel}
        </div>
        {highlight && (
          <div style={{
            fontSize: 9,
            fontFamily: "'Space Mono', monospace",
            color: "#16a34a",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            marginTop: 2,
          }}>
            Coming up
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 3 }}>
          <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--sb-sans)", color: "var(--sb-ink)" }}>
            {conf.name} ↗
          </span>
          <span style={{
            fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace",
            background: scaleStyle.bg, color: scaleStyle.color, border: `1px solid ${scaleStyle.border}`,
            borderRadius: 3, padding: "2px 6px", whiteSpace: "nowrap",
          }}>
            {scaleStyle.text}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--sb-muted)", marginBottom: 4 }}>
          {conf.venue} · {conf.city}
        </div>
        <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.5, fontFamily: "var(--sb-sans)" }}>
          {conf.description}
        </div>
      </div>
    </a>
  );
}

function AnnualConferencesSection() {
  const now = new Date();
  const withDates = TECH_CONFERENCES
    .map((conf) => ({ conf, ...getConferenceNextDate(conf, now) }))
    .sort((a, b) => a.sortMs - b.sortMs);

  const upcoming = withDates.filter((c) => c.isUpcoming);
  const later = withDates.filter((c) => !c.isUpcoming);

  return (
    <div className="tech-section">
      <div className="tech-section-head">
        <h3 className="tech-section-title">Annual Tech Conferences</h3>
        <span className="tech-section-note">Major SV events · South Bay and nearby · typical annual timing</span>
      </div>

      {upcoming.length > 0 && (
        <>
          <div style={{
            fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace",
            letterSpacing: "0.08em", textTransform: "uppercase",
            color: "#16a34a", marginBottom: 10, paddingBottom: 6,
            borderBottom: "2px solid var(--sb-border-light)",
          }}>
            Coming Up
          </div>
          {upcoming.map(({ conf, label }) => (
            <ConferenceRow key={conf.id} conf={conf} dateLabel={label} highlight />
          ))}
        </>
      )}

      {later.length > 0 && (
        <>
          <div style={{
            fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace",
            letterSpacing: "0.08em", textTransform: "uppercase",
            color: "#6b7280",
            marginTop: upcoming.length > 0 ? 16 : 0,
            marginBottom: 10, paddingBottom: 6,
            borderBottom: "2px solid var(--sb-border-light)",
          }}>
            Later This Year
          </div>
          {later.map(({ conf, label }) => (
            <ConferenceRow key={conf.id} conf={conf} dateLabel={label} highlight={false} />
          ))}
        </>
      )}

      <div style={{ fontSize: 10, color: "var(--sb-muted)", marginTop: 8, fontStyle: "italic" }}>
        Dates are typical annual timing — confirm on the organizer's website before making plans.
      </div>
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────────────────

// Category filters for the All Companies grid (only cats with ≥2 companies)
const COMPANY_CATEGORY_FILTERS = [
  { key: null, label: "All" },
  { key: "chip", label: "Chip" },
  { key: "cloud", label: "Cloud" },
  { key: "security", label: "Security" },
  { key: "robotics", label: "Robotics" },
  { key: "hardware", label: "Hardware" },
  { key: "saas", label: "SaaS" },
  { key: "network", label: "Network" },
  { key: "software", label: "Software" },
] as const;

// City filters for the More South Bay Tech spotlight
const SPOTLIGHT_CITY_FILTERS = [
  { key: null, label: "All" },
  { key: "San Jose", label: "San Jose" },
  { key: "Santa Clara", label: "Santa Clara" },
  { key: "Mountain View", label: "Mountain View" },
  { key: "Sunnyvale", label: "Sunnyvale" },
  { key: "Palo Alto", label: "Palo Alto" },
  { key: "Milpitas", label: "Milpitas" },
  { key: "Cupertino", label: "Cupertino" },
  { key: "Los Gatos", label: "Los Gatos" },
] as const;

// ── NASA APOD Strip ───────────────────────────────────────────────────────────

interface ApodItem {
  date: string;
  title: string;
  explanation: string;
  url: string;
  hdurl: string;
  copyright: string | null;
}

function ApodStrip() {
  const items = (apodJson as { items: ApodItem[] }).items;
  if (!items?.length) return null;

  const tile = (item: ApodItem, keySuffix: string) => (
    <a
      key={item.date + keySuffix}
      href={`https://apod.nasa.gov/apod/ap${item.date.replace(/-/g, "").slice(2)}.html`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={item.title}
      style={{
        flexShrink: 0, display: "block", position: "relative",
        height: 200, width: 300, overflow: "hidden", background: "#0a0a1a",
      }}
    >
      <img
        src={item.url}
        alt={item.title}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        onError={(e) => { (e.currentTarget.closest("a") as HTMLElement).style.display = "none"; }}
      />
      <div className="ps-caption">
        <span style={{ fontSize: 9, color: "#fff", fontFamily: "'Space Mono', monospace", lineHeight: 1.5 }}>
          {item.title}{item.copyright ? ` · © ${item.copyright}` : " · NASA/APOD"}
        </span>
      </div>
    </a>
  );

  return (
    <div style={{ marginBottom: 0, marginLeft: -16, marginRight: -16, overflow: "hidden" }}>
      <div className="apod-strip-track">
        {items.map(p => tile(p, "-a"))}
        {items.map(p => tile(p, "-b"))}
      </div>
    </div>
  );
}

export default function TechnologyView() {
  const [companyCategoryFilter, setCompanyCategoryFilter] = useState<string | null>(null);
  const [spotlightCityFilter, setSpotlightCityFilter] = useState<string | null>(null);

  const sortedCompanies = [...TECH_COMPANIES]
    .filter((c) => companyCategoryFilter === null || c.category === companyCategoryFilter)
    .sort((a, b) => b.sccEmployeesK - a.sccEmployeesK);

  const filteredSpotlight = spotlightCityFilter === null
    ? SCC_SPOTLIGHT
    : SCC_SPOTLIGHT.filter((c) => c.city === spotlightCityFilter);

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
      {/* ── APOD Strip ── */}
      <ApodStrip />

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

      {/* ── Weekly Tech Briefing ── */}
      {techBriefingJson?.summary && (
        <div
          style={{
            margin: "0 0 20px",
            padding: "14px 16px",
            background: "var(--sb-cream, #fdf8f0)",
            border: "1px solid var(--sb-border-light)",
            borderLeft: "4px solid #7c3aed",
            borderRadius: 6,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              marginBottom: 8,
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                fontFamily: "'Space Mono', monospace",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "#7c3aed",
              }}
            >
              This Week in South Bay Tech
            </span>
            <span
              style={{
                fontSize: 10,
                color: "var(--sb-muted)",
                fontFamily: "'Space Mono', monospace",
              }}
            >
              {techBriefingJson.weekLabel}
            </span>
          </div>
          <p
            style={{
              margin: 0,
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--sb-ink)",
            }}
          >
            {techBriefingJson.summary}
          </p>
        </div>
      )}

      {/* ── This Week in SV History ── */}
      <SvHistorySection />

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

      {/* ── Recently Funded ── */}
      <RecentlyFundedSection />

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
        <div className="tech-filter-strip">
          {COMPANY_CATEGORY_FILTERS.map((f) => (
            <button
              key={String(f.key)}
              className={`tech-filter-pill${companyCategoryFilter === f.key ? " tech-filter-pill--active" : ""}`}
              onClick={() => setCompanyCategoryFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
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
          <span className="tech-section-note">Notable SCC companies beyond the top employers · {SCC_SPOTLIGHT.length} companies</span>
        </div>
        <div className="tech-filter-strip">
          {SPOTLIGHT_CITY_FILTERS.map((f) => (
            <button
              key={String(f.key)}
              className={`tech-filter-pill${spotlightCityFilter === f.key ? " tech-filter-pill--active" : ""}`}
              onClick={() => setSpotlightCityFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="tech-spotlight-grid">
          {filteredSpotlight.map((company) => (
            <SpotlightCard key={company.id} company={company} />
          ))}
          {filteredSpotlight.length === 0 && (
            <p className="tech-filter-empty">No companies in {spotlightCityFilter} yet.</p>
          )}
        </div>
      </div>

      {/* ── Tech Events Near You ── */}
      <TechEventsSection />

      {/* ── Annual Tech Conferences ── */}
      <AnnualConferencesSection />

      {/* ── Gov × Tech callout ── */}
      <GovTechCallout />

      {/* ── Footer note ── */}
      <div className="tech-footer-note">
        Employment figures are Santa Clara County estimates as of Q1 2026, derived from campus headcount reports,
        company filings, EDD data, and news coverage. Global headcounts are much larger. South Bay Signal is not
        affiliated with any company listed and this is not investment advice.
      </div>
    </div>
  );
}
