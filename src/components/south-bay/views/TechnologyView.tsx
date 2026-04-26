import { useState, useEffect } from "react";
import { CompanyLogo } from "../CompanyLogo";
import { urlToDomain, LOGO_DOMAIN_BY_ID, LOGO_URL_BY_ID } from "../../../lib/south-bay/tech-logos";
import techBriefingJson from "../../../data/south-bay/tech-briefing.json";
import upcomingMeetingsJson from "../../../data/south-bay/upcoming-meetings.json";
import {
  TECH_COMPANIES,
  TECH_PULSE,
  CATEGORY_LABELS,
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

// ── Logo resolvers per data type ───────────────────────────────────────────
// Returns both the cascade domain and an optional pinned high-res URL. The
// directUrl wins over the cascade when set (used for hard-to-resolve brands).

interface LogoInfo {
  domain: string;
  directUrl?: string;
}

function logoForCompany(c: TechCompany): LogoInfo {
  return {
    domain: LOGO_DOMAIN_BY_ID[c.id] || urlToDomain(c.careersUrl),
    directUrl: LOGO_URL_BY_ID[c.id],
  };
}
function logoForSpotlight(c: SccTechSpotlight): LogoInfo {
  return {
    domain: LOGO_DOMAIN_BY_ID[c.id] || urlToDomain(c.url),
    directUrl: LOGO_URL_BY_ID[c.id],
  };
}
function logoForFunded(c: RecentlyFunded): LogoInfo {
  return {
    domain: LOGO_DOMAIN_BY_ID[c.id] || urlToDomain(c.url),
    directUrl: LOGO_URL_BY_ID[c.id],
  };
}
function logoForMilestone(m: TechMilestone): LogoInfo {
  return {
    domain: LOGO_DOMAIN_BY_ID[m.id] || urlToDomain(m.url),
    directUrl: LOGO_URL_BY_ID[m.id],
  };
}
function logoForConference(c: TechConference): LogoInfo {
  return {
    domain: LOGO_DOMAIN_BY_ID[c.id] || urlToDomain(c.url),
    directUrl: LOGO_URL_BY_ID[c.id],
  };
}

// ── Trend badge ────────────────────────────────────────────────────────────

function TrendBadge({ trend }: { trend: TechTrend }) {
  if (trend === "up") return <span className="tech-trend tech-trend--up">▲ Growing</span>;
  if (trend === "down") return <span className="tech-trend tech-trend--down">▼ Shrinking</span>;
  return <span className="tech-trend tech-trend--flat">— Stable</span>;
}

// ── Top Employers Leaderboard (replaces recharts bar chart) ────────────────

function TopEmployersLeaderboard() {
  const top = [...TECH_COMPANIES]
    .sort((a, b) => b.sccEmployeesK - a.sccEmployeesK)
    .slice(0, 12);
  const max = Math.max(...top.map((c) => c.sccEmployeesK));

  return (
    <div className="tech-leaderboard">
      {top.map((c, i) => {
        const widthPct = (c.sccEmployeesK / max) * 100;
        const trendArrow = c.trend === "up" ? "▲" : c.trend === "down" ? "▼" : "—";
        const trendColor = c.trend === "up" ? "#15803d" : c.trend === "down" ? "#b91c1c" : "#9ca3af";
        const isLink = !!c.careersUrl;
        const innerContent = (
          <>
            <span className="tech-leaderboard-rank">{String(i + 1).padStart(2, "0")}</span>
            <CompanyLogo
              {...logoForCompany(c)}
              name={c.name}
              size={36}
              fallbackColor={c.color}
              borderRadius={6}
            />
            <div className="tech-leaderboard-info">
              <div className="tech-leaderboard-name">
                {c.name}
                {isLink && <span className="tech-leaderboard-arrow-out">↗</span>}
              </div>
              <div className="tech-leaderboard-meta">
                {c.city} · {CATEGORY_LABELS[c.category]}
              </div>
            </div>
            <div className="tech-leaderboard-bar-wrap" aria-hidden="true">
              <div
                className="tech-leaderboard-bar"
                style={{
                  width: `${widthPct}%`,
                  background: c.color,
                  opacity: c.trend === "down" ? 0.5 : 0.85,
                }}
              />
            </div>
            <div className="tech-leaderboard-num">
              <span className="tech-leaderboard-num-value">{c.sccEmployeesK.toLocaleString()}K</span>
              <span className="tech-leaderboard-arrow" style={{ color: trendColor }}>
                {trendArrow}
              </span>
            </div>
          </>
        );
        return isLink ? (
          <a
            key={c.id}
            href={c.careersUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="tech-leaderboard-row"
          >
            {innerContent}
          </a>
        ) : (
          <div key={c.id} className="tech-leaderboard-row">
            {innerContent}
          </div>
        );
      })}
      <div className="tech-leaderboard-footnote">
        SCC local jobs only — global headcount is much larger. Bar widths scaled to top employer.
      </div>
    </div>
  );
}

// ── Company card (All Companies grid) ─────────────────────────────────────

function CompanyCard({ company }: { company: TechCompany }) {
  return (
    <div className="tech-card" style={{ borderTop: `3px solid ${company.color}` }}>
      <div className="tech-card-header">
        <CompanyLogo
          {...logoForCompany(company)}
          name={company.name}
          size={52}
          fallbackColor={company.color}
          borderRadius={10}
        />
        <div className="tech-card-id">
          <div className="tech-card-name-row">
            <span className="tech-card-name">{company.name}</span>
            {company.ticker && company.ticker !== "MSFT" && company.ticker !== "HPE" && (
              <span className="tech-card-ticker">{company.ticker}</span>
            )}
          </div>
          <div className="tech-card-meta">
            <span className="tech-card-city">{company.city}</span>
            <span className="tech-card-dot">·</span>
            <span className="tech-card-category">{CATEGORY_LABELS[company.category]}</span>
          </div>
        </div>
        <TrendBadge trend={company.trend} />
      </div>

      <div className="tech-card-stat">
        <span className="tech-card-stat-value">{company.sccEmployeesK.toLocaleString()}K</span>
        <span className="tech-card-stat-label">SCC jobs (est.)</span>
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

// ── Spotlight card (More South Bay Tech) ──────────────────────────────────

const STAGE_LABELS: Record<SccTechSpotlight["stage"], string> = {
  public: "Public",
  growth: "Growth",
  startup: "Startup",
};

function SpotlightCard({ company }: { company: SccTechSpotlight }) {
  const stageColor =
    company.stage === "startup"
      ? "#92400e"
      : company.stage === "growth"
        ? "#1e40af"
        : "#374151";
  const stageBg =
    company.stage === "startup"
      ? "#fef3c7"
      : company.stage === "growth"
        ? "#dbeafe"
        : "#f3f4f6";
  return (
    <a
      href={company.url}
      target="_blank"
      rel="noopener noreferrer"
      className="tech-spotlight-card"
      style={{ borderTop: `3px solid ${company.color}` }}
    >
      <div className="tech-spotlight-header">
        <CompanyLogo
          {...logoForSpotlight(company)}
          name={company.name}
          size={44}
          fallbackColor={company.color}
        />
        <div className="tech-spotlight-id">
          <div className="tech-spotlight-name">
            {company.name} <span className="tech-spotlight-arrow">↗</span>
          </div>
          <div className="tech-spotlight-meta">{company.city}</div>
        </div>
        <span
          className="tech-spotlight-stage"
          style={{ background: stageBg, color: stageColor }}
        >
          {STAGE_LABELS[company.stage]}
        </span>
      </div>
      <p className="tech-spotlight-tagline">{company.tagline}</p>
      <div className="tech-spotlight-employees">{company.employeesNote}</div>
    </a>
  );
}

// ── Hiring Pulse row ──────────────────────────────────────────────────────

function HiringRow({ company }: { company: TechCompany }) {
  const isUp = company.trend === "up";
  const isDown = company.trend === "down";
  const statusColor = isUp ? "#16a34a" : isDown ? "#dc2626" : "#6b7280";
  const statusBg = isUp ? "#f0fdf4" : isDown ? "#fef2f2" : "#f9fafb";
  const statusLabel = isUp ? "▲ Hiring" : isDown ? "▼ Reduced" : "→ Selective";

  const content = (
    <>
      <CompanyLogo
        {...logoForCompany(company)}
        name={company.name}
        size={32}
        fallbackColor={company.color}
        borderRadius={6}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: 13,
              color: "var(--sb-ink)",
              fontFamily: "var(--sb-sans)",
            }}
          >
            {company.name}
            {company.careersUrl ? " ↗" : ""}
          </span>
          <span style={{ fontSize: 11, color: "var(--sb-muted)" }}>{company.city}</span>
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--sb-muted)",
            marginTop: 1,
            lineHeight: 1.4,
          }}
        >
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
    </>
  );

  const baseStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 0",
    borderBottom: "1px solid var(--sb-border-light)",
    textDecoration: "none",
    color: "inherit",
  };

  return company.careersUrl ? (
    <a
      href={company.careersUrl}
      target="_blank"
      rel="noopener noreferrer"
      style={baseStyle}
    >
      {content}
    </a>
  ) : (
    <div style={baseStyle}>{content}</div>
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
    const cityName = cityId
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
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
        <span className="tech-section-note">
          Tech-relevant items on upcoming council agendas
        </span>
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

// ── Tech Events Near You ──────────────────────────────────────────────────

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
  const isTechTitle =
    TECH_EVENT_KEYWORDS.test(e.title) && !TECH_EVENT_EXCLUDES.test(e.title);
  return isChm || isTechTitle;
}

function filterTechEvents(allEvents: UpcomingEvent[]): UpcomingEvent[] {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const chmExhibits = allEvents
    .filter(
      (e) => e.venue?.toLowerCase().includes("computer history") && e.ongoing
    )
    .filter(
      (e) =>
        !["2026 Fellow Awards Ceremony", "Read Me", "To Infinity and Beyond"].includes(
          e.title
        )
    );

  const upcoming = allEvents
    .filter((e) => !e.ongoing && e.date >= today && e.date <= cutoff && isTechEvent(e))
    .sort((a, b) => a.date.localeCompare(b.date));

  return [...chmExhibits.slice(0, 5), ...upcoming.slice(0, 5)];
}

function TechEventsSection() {
  const [allEvents, setAllEvents] = useState<UpcomingEvent[]>([]);
  useEffect(() => {
    fetch("/api/south-bay/upcoming-events")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAllEvents(d?.events ?? []))
      .catch(() => {});
  }, []);
  const events = filterTechEvents(allEvents);
  if (events.length === 0) return null;

  const chmEvents = events.filter((e) =>
    e.venue?.toLowerCase().includes("computer history")
  );
  const upcomingEvents = events.filter(
    (e) => !e.venue?.toLowerCase().includes("computer history")
  );

  return (
    <div className="tech-section">
      <div className="tech-section-head">
        <h3 className="tech-section-title">Tech Events Near You</h3>
        <span className="tech-section-note">
          South Bay · Computer History Museum · upcoming talks
        </span>
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
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--sb-muted)",
                    fontWeight: 400,
                    marginTop: 3,
                  }}
                >
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
                {new Date(e.date + "T12:00:00").toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
                {e.time ? (
                  <>
                    <br />
                    {e.time}
                  </>
                ) : null}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    fontFamily: "var(--sb-sans)",
                    lineHeight: 1.3,
                  }}
                >
                  {e.title} ↗
                </div>
                {e.venue && (
                  <div style={{ fontSize: 11, color: "var(--sb-muted)", marginTop: 2 }}>
                    {e.venue}
                    {e.city &&
                      ` · ${e.city
                        .replace(/-/g, " ")
                        .replace(/\b\w/g, (c) => c.toUpperCase())}`}
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

// ── Recently Funded ───────────────────────────────────────────────────────

const ROUND_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  Seed: { bg: "#fef3c7", color: "#92400e", border: "#fcd34d" },
  "Pre-Seed": { bg: "#fef3c7", color: "#92400e", border: "#fcd34d" },
  "Series A": { bg: "#dbeafe", color: "#1e40af", border: "#93c5fd" },
  "Series A1": { bg: "#dbeafe", color: "#1e40af", border: "#93c5fd" },
  "Series B": { bg: "#f3e8ff", color: "#6b21a8", border: "#c4b5fd" },
  "Series C": { bg: "#fce7f3", color: "#9d174d", border: "#f9a8d4" },
  "Series D": { bg: "#fff7ed", color: "#9a3412", border: "#fdba74" },
  "Series E": { bg: "#ecfdf5", color: "#065f46", border: "#6ee7b7" },
  "Series F": { bg: "#fdf4ff", color: "#581c87", border: "#d8b4fe" },
  "Series F+": { bg: "#fdf4ff", color: "#581c87", border: "#d8b4fe" },
  Strategic: { bg: "#f0fdf4", color: "#166534", border: "#86efac" },
  Convertible: { bg: "#f0f9ff", color: "#0369a1", border: "#7dd3fc" },
  Acquired: { bg: "#f0fdfa", color: "#0f766e", border: "#5eead4" },
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
  const dateLabel = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <a
      href={company.url}
      target="_blank"
      rel="noopener noreferrer"
      className="tech-funded-row"
    >
      <CompanyLogo
        {...logoForFunded(company)}
        name={company.name}
        size={44}
        fallbackColor={company.color}
        borderRadius={8}
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
          <span
            style={{
              fontWeight: 700,
              fontSize: 14,
              color: "var(--sb-ink)",
              fontFamily: "var(--sb-sans)",
            }}
          >
            {company.name} ↗
          </span>
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
          <span>
            {CATEGORY_LABELS[company.category as keyof typeof CATEGORY_LABELS] ?? company.category}
          </span>
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
    </a>
  );
}

const ROUNDS_2026 = RECENTLY_FUNDED.filter((r) => r.date >= "2026-01-01").length;
const EARLY_STAGES = new Set(["Seed", "Pre-Seed", "Series A", "Series A1"]);

// Most-recent N rounds — fed into the live-scrolling "Latest Funding" ticker.
function getLatestFundedRounds(n = 20): RecentlyFunded[] {
  return [...RECENTLY_FUNDED].sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
}

function FundingTicker() {
  const latest = getLatestFundedRounds(20);

  const renderItem = (r: RecentlyFunded, dupKey: string) => (
    <a
      key={r.id + r.date + dupKey}
      href={r.url}
      target="_blank"
      rel="noopener noreferrer"
      className="tech-ticker-item"
      aria-hidden={dupKey === "dup" ? "true" : undefined}
      tabIndex={dupKey === "dup" ? -1 : 0}
    >
      <CompanyLogo
        {...logoForFunded(r)}
        name={r.name}
        size={28}
        fallbackColor={r.color}
        borderRadius={5}
        bordered={false}
      />
      <div className="tech-ticker-text">
        <div className="tech-ticker-name">{r.name}</div>
        <div className="tech-ticker-meta">
          <span className="tech-ticker-amount">{r.amount}</span>
          <span className="tech-ticker-round">{r.round}</span>
        </div>
      </div>
    </a>
  );

  return (
    <div className="tech-ticker">
      <div className="tech-ticker-label">Latest funding ↘</div>
      <div className="tech-ticker-viewport">
        <div className="tech-ticker-track">
          {latest.map((r) => renderItem(r, "a"))}
          {latest.map((r) => renderItem(r, "dup"))}
        </div>
      </div>
    </div>
  );
}

function RecentlyFundedSection() {
  const [stageFilter, setStageFilter] = useState<"all" | "early">("all");
  const sorted = [...RECENTLY_FUNDED].sort((a, b) => b.date.localeCompare(a.date));
  const earlyCount = sorted.filter((r) => EARLY_STAGES.has(r.round)).length;
  const filtered =
    stageFilter === "early" ? sorted.filter((r) => EARLY_STAGES.has(r.round)) : sorted;
  return (
    <div className="tech-section">
      <div className="tech-section-head">
        <h3 className="tech-section-title">Recently Funded</h3>
        <span className="tech-section-note">
          South Bay startups · Q4 2025 – Q2 2026 · {RECENTLY_FUNDED.length} rounds
        </span>
      </div>

      {/* 2026 YTD Recap */}
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
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              fontFamily: "'Space Mono', monospace",
              color: "#581c87",
              lineHeight: 1,
            }}
          >
            $6B+
          </div>
          <div
            style={{
              fontSize: 10,
              color: "#6b21a8",
              fontFamily: "'Space Mono', monospace",
              marginTop: 4,
              letterSpacing: "0.04em",
            }}
          >
            2026 YTD RAISED
          </div>
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
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              fontFamily: "'Space Mono', monospace",
              color: "#4c1d95",
              lineHeight: 1,
            }}
          >
            {ROUNDS_2026}
          </div>
          <div
            style={{
              fontSize: 10,
              color: "#5b21b6",
              fontFamily: "'Space Mono', monospace",
              marginTop: 4,
              letterSpacing: "0.04em",
            }}
          >
            2026 ROUNDS
          </div>
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
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--sb-ink)",
              fontFamily: "var(--sb-sans)",
              marginBottom: 3,
            }}
          >
            Q1–Q2 2026 — South Bay VC surge
          </div>
          <div style={{ fontSize: 11, color: "var(--sb-muted)", lineHeight: 1.5 }}>
            SiFive ($400M Series G), Aria Networks ($125M), and Genspark ($110M) kick off Q2.
            Chips, robotics, and AI networking keep dominating deal flow.
          </div>
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
          <RecentlyFundedCard key={company.id + company.date} company={company} />
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

// ── This Week in SV History ───────────────────────────────────────────────

const WINDOW_DAYS = 8;

function getActiveMilestones(): TechMilestone[] {
  const now = new Date();
  return TECH_MILESTONES.filter((m) => {
    const mDate = new Date(now.getFullYear(), m.month - 1, m.day);
    const diff = Math.abs(mDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return diff <= WINDOW_DAYS;
  });
}

function getNextMilestone(): { milestone: TechMilestone; daysUntil: number } | null {
  const now = new Date();
  const nowMs = now.getTime();
  let best: { milestone: TechMilestone; daysUntil: number } | null = null;
  for (const m of TECH_MILESTONES) {
    for (const yearOffset of [0, 1]) {
      const mDate = new Date(now.getFullYear() + yearOffset, m.month - 1, m.day);
      const diffMs = mDate.getTime() - nowMs;
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays > WINDOW_DAYS) {
        if (!best || diffDays < best.daysUntil) {
          best = { milestone: m, daysUntil: Math.ceil(diffDays) };
        }
        break;
      }
    }
  }
  return best;
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

  if (milestones.length === 0) {
    const next = getNextMilestone();
    if (!next) return null;
    const { milestone: m, daysUntil } = next;
    const age = new Date().getFullYear() - m.foundedYear;
    const mDate = new Date(new Date().getFullYear(), m.month - 1, m.day);
    const monthLabel = mDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return (
      <div className="tech-section">
        <div className="tech-section-head">
          <h3 className="tech-section-title">Coming Up in SV History</h3>
          <span className="tech-section-note">
            Next local milestone in {daysUntil} day{daysUntil === 1 ? "" : "s"}
          </span>
        </div>
        <div className="tech-milestone tech-milestone--upcoming">
          <CompanyLogo
            {...logoForMilestone(m)}
            name={m.company}
            size={48}
            borderRadius={8}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tech-milestone-top">
              <span className="tech-milestone-name">{m.company}</span>
              <span className="tech-milestone-pill tech-milestone-pill--gray">
                {monthLabel} · {ordinal(age)} anniversary
              </span>
              <span className="tech-milestone-loc">
                {m.city} · est. {m.foundedYear}
              </span>
            </div>
            <p className="tech-milestone-note">{m.tagline}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tech-section">
      <div className="tech-section-head">
        <h3 className="tech-section-title">This Week in SV History</h3>
        <span className="tech-section-note">
          Local company milestones happening right now
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {milestones.map((m) => {
          const age = milestoneAge(m);
          return (
            <div key={m.id} className="tech-milestone tech-milestone--active">
              <CompanyLogo
                {...logoForMilestone(m)}
                name={m.company}
                size={56}
                borderRadius={10}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="tech-milestone-top">
                  <span className="tech-milestone-name">{m.company}</span>
                  <span className="tech-milestone-pill tech-milestone-pill--amber">
                    {m.defunct ? `${age} years ago` : `${ordinal(age)} anniversary`}
                  </span>
                  <span className="tech-milestone-loc">
                    {m.city} · est. {m.foundedYear}
                  </span>
                </div>
                <p className="tech-milestone-note">{m.anniversaryNote}</p>
                {m.chmExhibit && (
                  <div className="tech-milestone-chm">
                    <span>🏛️</span>
                    <span>
                      Computer History Museum: <strong>{m.chmExhibit}</strong>
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

// ── Annual Tech Conferences ───────────────────────────────────────────────

const MONTH_NAMES_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function getConferenceNextDate(
  conf: TechConference,
  now: Date
): { label: string; sortMs: number; isUpcoming: boolean } {
  const startMonth = conf.typicalMonth;
  const endMonth = conf.typicalEndMonth ?? startMonth;
  const endDayForBound = conf.typicalEndDay ?? conf.typicalDay ?? 15;
  const thisYearEndMs = new Date(now.getFullYear(), endMonth - 1, endDayForBound).getTime();
  const yearOffset = (thisYearEndMs - now.getTime()) / 86400000 < -7 ? 1 : 0;
  const year = now.getFullYear() + yearOffset;
  const startMonthName = MONTH_NAMES_FULL[startMonth - 1];
  const endMonthName = MONTH_NAMES_FULL[endMonth - 1];
  const approxDay = conf.typicalDay ?? 15;
  const targetMs = new Date(year, startMonth - 1, approxDay).getTime();
  const diffDays = (targetMs - now.getTime()) / (1000 * 60 * 60 * 24);
  const isUpcoming = diffDays >= -7 && diffDays <= 90;
  let label = `${startMonthName} ${year}`;
  if (conf.typicalDay) {
    if (conf.typicalEndDay && endMonth !== startMonth) {
      label = `${startMonthName} ${conf.typicalDay} – ${endMonthName} ${conf.typicalEndDay}, ${year}`;
    } else if (conf.typicalEndDay) {
      label = `${startMonthName} ${conf.typicalDay}–${conf.typicalEndDay}, ${year}`;
    } else {
      label = `${startMonthName} ${conf.typicalDay}, ${year}`;
    }
  }
  return { label, sortMs: targetMs, isUpcoming };
}

function getDeadlineBadge(deadline?: string): { label: string; urgent: boolean } | null {
  if (!deadline) return null;
  const days = Math.ceil((new Date(deadline).getTime() - Date.now()) / 86400000);
  if (days < 0 || days > 14) return null;
  const d = new Date(deadline);
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
  const label =
    days === 0 ? `Apply today — ${mon} ${d.getDate()}` :
    days === 1 ? `Apply by ${mon} ${d.getDate()} — tomorrow` :
    `Apply by ${mon} ${d.getDate()} — ${days} days`;
  return { label, urgent: days <= 5 };
}

function ConferenceRow({
  conf,
  dateLabel,
  highlight,
}: {
  conf: TechConference;
  dateLabel: string;
  highlight: boolean;
}) {
  const scaleStyle =
    conf.scale === "global"
      ? { bg: "#eff6ff", color: "#1e40af", border: "#bfdbfe", text: "Global" }
      : { bg: "#f0fdf4", color: "#166534", border: "#bbf7d0", text: "Regional" };
  const deadlineBadge = getDeadlineBadge(conf.applicationDeadline);
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
        <div
          style={{
            fontSize: 11,
            fontFamily: "'Space Mono', monospace",
            color: highlight ? "#16a34a" : "var(--sb-muted)",
            fontWeight: highlight ? 700 : 400,
            lineHeight: 1.3,
          }}
        >
          {dateLabel}
        </div>
        {highlight && (
          <div
            style={{
              fontSize: 9,
              fontFamily: "'Space Mono', monospace",
              color: "#16a34a",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginTop: 2,
            }}
          >
            Coming up
          </div>
        )}
      </div>
      <CompanyLogo
        {...logoForConference(conf)}
        name={conf.organizer}
        size={36}
        borderRadius={6}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 3,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "var(--sb-sans)",
              color: "var(--sb-ink)",
            }}
          >
            {conf.name} ↗
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              fontFamily: "'Space Mono', monospace",
              background: scaleStyle.bg,
              color: scaleStyle.color,
              border: `1px solid ${scaleStyle.border}`,
              borderRadius: 3,
              padding: "2px 6px",
              whiteSpace: "nowrap",
            }}
          >
            {scaleStyle.text}
          </span>
          {deadlineBadge && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                fontFamily: "'Space Mono', monospace",
                background: deadlineBadge.urgent ? "#fef2f2" : "#fff7ed",
                color: deadlineBadge.urgent ? "#b91c1c" : "#c2410c",
                border: `1px solid ${deadlineBadge.urgent ? "#fecaca" : "#fed7aa"}`,
                borderRadius: 3,
                padding: "2px 6px",
                whiteSpace: "nowrap",
              }}
            >
              ⚡ {deadlineBadge.label}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: "var(--sb-muted)", marginBottom: 4 }}>
          {conf.venue} · {conf.city}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "#374151",
            lineHeight: 1.5,
            fontFamily: "var(--sb-sans)",
          }}
        >
          {conf.description}
        </div>
      </div>
    </a>
  );
}

function AnnualConferencesSection() {
  const now = new Date();
  const withDates = TECH_CONFERENCES.map((conf) => ({
    conf,
    ...getConferenceNextDate(conf, now),
  })).sort((a, b) => a.sortMs - b.sortMs);

  const upcoming = withDates.filter((c) => c.isUpcoming);
  const later = withDates.filter((c) => !c.isUpcoming);

  return (
    <div className="tech-section">
      <div className="tech-section-head">
        <h3 className="tech-section-title">Annual Tech Conferences</h3>
        <span className="tech-section-note">
          Major SV events · South Bay and nearby · typical annual timing
        </span>
      </div>

      {upcoming.length > 0 && (
        <>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              fontFamily: "'Space Mono', monospace",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#16a34a",
              marginBottom: 10,
              paddingBottom: 6,
              borderBottom: "2px solid var(--sb-border-light)",
            }}
          >
            Coming Up
          </div>
          {upcoming.map(({ conf, label }) => (
            <ConferenceRow key={conf.id} conf={conf} dateLabel={label} highlight />
          ))}
        </>
      )}

      {later.length > 0 && (
        <>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              fontFamily: "'Space Mono', monospace",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#6b7280",
              marginTop: upcoming.length > 0 ? 16 : 0,
              marginBottom: 10,
              paddingBottom: 6,
              borderBottom: "2px solid var(--sb-border-light)",
            }}
          >
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

// ── Main view ─────────────────────────────────────────────────────────────

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

export default function TechnologyView() {
  const [companyCategoryFilter, setCompanyCategoryFilter] = useState<string | null>(null);
  const [spotlightCityFilter, setSpotlightCityFilter] = useState<string | null>(null);

  const sortedCompanies = [...TECH_COMPANIES]
    .filter((c) => companyCategoryFilter === null || c.category === companyCategoryFilter)
    .sort((a, b) => b.sccEmployeesK - a.sccEmployeesK);

  const filteredSpotlight =
    spotlightCityFilter === null
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
      {/* ── Header ── */}
      <div className="tech-header">
        <div className="tech-header-eyebrow">South Bay</div>
        <h2 className="tech-header-title">Technology</h2>
        <p className="tech-header-subtitle">
          The companies headquartered in your backyard — and how many people they
          employ right here in Santa Clara County.
        </p>
        <div className="tech-header-note">
          Data snapshot · Q1 2026 · Santa Clara County employment estimates · Not affiliated with any company listed
        </div>
      </div>

      {/* ── Weekly Tech Briefing ── */}
      {techBriefingJson?.summary && (
        <div className="tech-briefing">
          <div className="tech-briefing-head">
            <span className="tech-briefing-eyebrow">This Week in South Bay Tech</span>
            <span className="tech-briefing-week">{techBriefingJson.weekLabel}</span>
          </div>
          <p className="tech-briefing-body">{techBriefingJson.summary}</p>
        </div>
      )}

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

      {/* ── Latest Funding ticker ── */}
      <FundingTicker />

      {/* ── Top Employers Leaderboard ── */}
      <div className="tech-section">
        <div className="tech-section-head">
          <h3 className="tech-section-title">Top Employers</h3>
          <span className="tech-section-note">
            Ranked by Santa Clara County local jobs · Q1 2026
          </span>
        </div>
        <TopEmployersLeaderboard />
      </div>

      {/* ── This Week in SV History ── */}
      <SvHistorySection />

      {/* ── Recently Funded ── */}
      <RecentlyFundedSection />

      {/* ── Hiring Pulse ── */}
      <div className="tech-section">
        <div className="tech-section-head">
          <h3 className="tech-section-title">Hiring Pulse</h3>
          <span className="tech-section-note">
            Q1 2026 · South Bay tech hiring at a glance
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 24,
          }}
        >
          {hiringGroups.map((group) => (
            <div key={group.label}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: "'Space Mono', monospace",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color:
                    group.label === "Actively Hiring"
                      ? "#16a34a"
                      : group.label === "Reduced Hiring"
                        ? "#dc2626"
                        : "#6b7280",
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
          Based on public filings, layoff announcements, and job board activity as of Q1 2026.
          Not investment advice. Career links go to each company's official jobs page.
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
          <span className="tech-section-note">
            Notable SCC companies beyond the top employers · {SCC_SPOTLIGHT.length} companies
          </span>
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
            <p className="tech-filter-empty">
              No companies in {spotlightCityFilter} yet.
            </p>
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
        Employment figures are Santa Clara County estimates as of Q1 2026, derived from campus
        headcount reports, company filings, EDD data, and news coverage. Global headcounts are
        much larger. South Bay Today is not affiliated with any company listed and this is not
        investment advice.
      </div>
    </div>
  );
}
