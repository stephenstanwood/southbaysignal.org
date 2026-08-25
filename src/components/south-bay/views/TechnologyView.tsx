import { useState, useEffect } from "react";
import { CompanyLogo } from "../CompanyLogo";
import PageHero from "../PageHero";
import { urlToDomain, LOGO_DOMAIN_BY_ID, LOGO_URL_BY_ID } from "../../../lib/south-bay/tech-logos";
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

// RECENTLY_FUNDED widens its category to include "medtech" and "eda" — labels
// not present in CATEGORY_LABELS would render as raw lowercase keys.
const EXTRA_CATEGORY_LABELS: Record<string, string> = {
  medtech: "Medtech",
  eda: "EDA",
};

function labelForCategory(c: string): string {
  return (
    (CATEGORY_LABELS as Record<string, string>)[c] ??
    EXTRA_CATEGORY_LABELS[c] ??
    c
  );
}

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
            {company.ticker && (
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
  const statusColor = isUp ? "#15803d" : isDown ? "#92400e" : "#565f6e";
  const statusBg = isUp ? "#f0fdf4" : isDown ? "#fffbeb" : "#f9fafb";
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

// Event `date` values are Pacific calendar dates, so the window bounds have to
// be Pacific too. `toISOString()` is UTC: from 5 PM PT onward it already reads
// tomorrow, which silently dropped tonight's talks off the list every evening.
function todayInPt(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
}

function filterTechEvents(allEvents: UpcomingEvent[]): UpcomingEvent[] {
  const today = todayInPt();
  const cutoff = todayInPt(30 * 24 * 60 * 60 * 1000);

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
                href={e.url ?? "#"}
                onClick={(ev) => !e.url && ev.preventDefault()}
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
              href={e.url ?? "#"}
              onClick={(ev) => !e.url && ev.preventDefault()}
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
  Growth: { bg: "#e0e7ff", color: "#3730a3", border: "#a5b4fc" },
  Venture: { bg: "#f1f5f9", color: "#334155", border: "#cbd5e1" },
  Strategic: { bg: "#f0fdf4", color: "#166534", border: "#86efac" },
  Convertible: { bg: "#f0f9ff", color: "#0369a1", border: "#7dd3fc" },
  Acquired: { bg: "#f0fdfa", color: "#0f766e", border: "#5eead4" },
};

// Resolve a funding-round label to a ROUND_COLORS key. The funding cron coins
// many variants ("Series A ext.", "Series A-1", "Series C+", "Strategic
// Investment", "Series G", "Venture Round"); without normalization they fall
// through to the flat gray default, so "Series A" gets a blue badge while
// "Series A ext." right beside it goes gray. Map each variant onto its stage
// family so future spellings auto-resolve too. (Display still shows the raw
// label — only the color is normalized.)
function roundColorKey(round: string): string {
  const r = round.trim();
  if (ROUND_COLORS[r]) return r;
  const series = r.match(/^Series\s+([A-Z])/i);
  if (series) {
    const letter = series[1].toUpperCase();
    // Anything past Series F shares the deepest-purple "Series F+" styling.
    return letter >= "G" ? "Series F+" : `Series ${letter}`;
  }
  if (/^Pre-Series/i.test(r)) return "Pre-Seed";
  if (/^Seed/i.test(r)) return "Seed"; // "Seed ext.", "Seed + Series A", etc.
  if (/Strategic/i.test(r)) return "Strategic";
  if (/Venture/i.test(r)) return "Venture";
  if (/Growth/i.test(r)) return "Growth";
  return r; // unknown → default gray
}

function RoundBadge({ round }: { round: string }) {
  const style = ROUND_COLORS[roundColorKey(round)] ?? { bg: "#f3f4f6", color: "#374151", border: "#d1d5db" };
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
  const daysAgo = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const isFresh = daysAgo >= 0 && daysAgo <= 14;
  const dateLabel =
    daysAgo >= 0 && daysAgo <= 30
      ? daysAgo === 0
        ? "today"
        : daysAgo === 1
          ? "yesterday"
          : daysAgo < 7
            ? `${daysAgo}d ago`
            : `${Math.round(daysAgo / 7)}w ago`
      : d.toLocaleDateString("en-US", {
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
          {isFresh && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 800,
                fontFamily: "'Space Mono', monospace",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "#fff",
                background: "#dc2626",
                padding: "2px 6px",
                borderRadius: 3,
                lineHeight: 1.1,
              }}
              title={`Closed ${daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`}`}
            >
              NEW
            </span>
          )}
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
            {labelForCategory(company.category)}
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

// Parse "$143M" / "$1.5B" / "$200M+" / "~$7M raised" → millions of USD.
// Returns null for "Undisclosed" or anything we can't read.
function parseFundingAmount(raw: string): number | null {
  if (!raw) return null;
  const m = raw.match(/\$\s*([\d.]+)\s*([MB])/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  if (!Number.isFinite(val)) return null;
  return m[2].toUpperCase() === "B" ? val * 1000 : val;
}

// Format millions as "$7.1B" / "$925M" — used in YTD recap.
function formatFundingTotal(millions: number): string {
  if (millions >= 1000) {
    const b = millions / 1000;
    return `$${b >= 10 ? b.toFixed(0) : b.toFixed(1)}B`;
  }
  return `$${Math.round(millions)}M`;
}

const RAISED_2026_MILLIONS = RECENTLY_FUNDED
  .filter((r) => r.date >= "2026-01-01")
  .reduce((sum, r) => sum + (parseFundingAmount(r.amount) ?? 0), 0);
const RAISED_2026_LABEL = formatFundingTotal(RAISED_2026_MILLIONS);

// Top categories among the year-to-date 2026 rounds — feeds the pulse strip recap so
// the "what's hot" callout never lies about what residents are actually seeing
// in the funding list below.
const Q1Q2_FUNDED = RECENTLY_FUNDED.filter((r) => r.date >= "2026-01-01");
// Period label for the year-to-date funding stats — spans Q1 through the
// quarter of the latest tracked 2026 round, derived from the data so it never
// claims a quarter the list doesn't actually cover and never silently goes
// stale once Q3+ rounds land. (The employment-snapshot labels elsewhere in
// this view are a genuine static data vintage and intentionally stay
// hardcoded — don't make those dynamic.)
const FUNDING_PERIOD_LABEL = (() => {
  const latestDate = Q1Q2_FUNDED.reduce(
    (max, r) => (r.date > max ? r.date : max),
    "2026-01-01",
  );
  const quarter = Math.ceil(parseInt(latestDate.slice(5, 7), 10) / 3);
  return quarter <= 1 ? "Q1 2026" : `Q1–Q${quarter} 2026`;
})();
const Q1Q2_CATEGORY_COUNTS = Q1Q2_FUNDED.reduce<Record<string, number>>(
  (acc, r) => {
    acc[r.category] = (acc[r.category] ?? 0) + 1;
    return acc;
  },
  {},
);
// Lowercase labels for the prose join below — CATEGORY_LABELS is title-case
// (used in chips/filters), and "medtech"/"eda" don't appear there at all.
const PULSE_CATEGORY_PROSE: Record<string, string> = {
  chip: "chips",
  cloud: "cloud",
  software: "software",
  network: "networking",
  ecommerce: "e-commerce",
  fintech: "fintech",
  security: "security",
  social: "social",
  hardware: "hardware",
  saas: "SaaS",
  robotics: "robotics",
  ai: "AI",
  medtech: "medtech",
  eda: "EDA",
};
const Q1Q2_TOP_CATEGORIES = Object.entries(Q1Q2_CATEGORY_COUNTS)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 5)
  .map(([cat]) => PULSE_CATEGORY_PROSE[cat] ?? cat);
const Q1Q2_TOP_CATEGORIES_NOTE = Q1Q2_TOP_CATEGORIES.join(", ");
const PULSE_RAISED_STAT = {
  value: RAISED_2026_LABEL,
  label: `Raised in ${FUNDING_PERIOD_LABEL}`,
  note: `${ROUNDS_2026} South Bay startup rounds · ${Q1Q2_TOP_CATEGORIES_NOTE} led the way`,
};
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

// ── This Week in SV History ───────────────────────────────────────────────

const WINDOW_DAYS = 8;

// The calendar year whose occurrence of this milestone's month/day sits
// closest to `now`. Checking only the current year misses anniversaries that
// fall just across a year boundary (e.g. HP on Jan 1 viewed in late December),
// so consider the adjacent years too.
function nearestOccurrenceYear(m: TechMilestone, now: Date): number {
  let bestYear = now.getFullYear();
  let bestDiff = Infinity;
  for (const yr of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
    const diff = Math.abs(new Date(yr, m.month - 1, m.day).getTime() - now.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      bestYear = yr;
    }
  }
  return bestYear;
}

function getActiveMilestones(): TechMilestone[] {
  const now = new Date();
  return TECH_MILESTONES.filter((m) => {
    const mDate = new Date(nearestOccurrenceYear(m, now), m.month - 1, m.day);
    const diff = Math.abs(mDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return diff <= WINDOW_DAYS;
  });
}

function getNextMilestone(): {
  milestone: TechMilestone;
  daysUntil: number;
  occurrenceYear: number;
} | null {
  const now = new Date();
  const nowMs = now.getTime();
  let best: {
    milestone: TechMilestone;
    daysUntil: number;
    occurrenceYear: number;
  } | null = null;
  for (const m of TECH_MILESTONES) {
    for (const yearOffset of [0, 1]) {
      const occurrenceYear = now.getFullYear() + yearOffset;
      const mDate = new Date(occurrenceYear, m.month - 1, m.day);
      const diffMs = mDate.getTime() - nowMs;
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays > WINDOW_DAYS) {
        if (!best || diffDays < best.daysUntil) {
          best = { milestone: m, daysUntil: Math.ceil(diffDays), occurrenceYear };
        }
        break;
      }
    }
  }
  return best;
}

function milestoneAge(m: TechMilestone): number {
  return nearestOccurrenceYear(m, new Date()) - m.foundedYear;
}

// Anniversary notes may embed live counts so they never go stale year-over-year:
//   {years}   → the integer age (e.g. "33")
//   {ordinal} → the ordinal age (e.g. "33rd")
function expandMilestoneNote(note: string, age: number): string {
  return note
    .replaceAll("{years}", String(age))
    .replaceAll("{ordinal}", ordinal(age));
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
    const { milestone: m, daysUntil, occurrenceYear } = next;
    const age = occurrenceYear - m.foundedYear;
    const mDate = new Date(occurrenceYear, m.month - 1, m.day);
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
                <p className="tech-milestone-note">{expandMilestoneNote(m.anniversaryNote, age)}</p>
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
): { label: string; sortMs: number; isUpcoming: boolean; isHappeningNow: boolean } {
  const startMonth = conf.typicalMonth;
  const endMonth = conf.typicalEndMonth ?? startMonth;
  const endDayForBound = conf.typicalEndDay ?? conf.typicalDay ?? 15;
  // Roll to next year once the conference has actually ENDED (end-of-day on the
  // last day has passed) — not when the start date slips by. Keying the rollover
  // and "upcoming" flag off the end date keeps a multi-day event visible while
  // it's happening, but stops an already-finished conference (e.g. WWDC the week
  // after it wraps) from lingering under "Coming Up" with a past date.
  const thisYearEndMs = new Date(now.getFullYear(), endMonth - 1, endDayForBound, 23, 59, 59).getTime();
  const yearOffset = thisYearEndMs < now.getTime() ? 1 : 0;
  const year = now.getFullYear() + yearOffset;
  const startMonthName = MONTH_NAMES_FULL[startMonth - 1];
  const endMonthName = MONTH_NAMES_FULL[endMonth - 1];
  const approxDay = conf.typicalDay ?? 15;
  const targetMs = new Date(year, startMonth - 1, approxDay).getTime();
  const endMsForYear = new Date(year, endMonth - 1, endDayForBound, 23, 59, 59).getTime();
  const diffDays = (targetMs - now.getTime()) / (1000 * 60 * 60 * 24);
  // Upcoming = starts within the next 90 days AND hasn't ended yet (so it stays
  // highlighted while in progress, then drops out the moment it's over).
  const isUpcoming = diffDays <= 90 && endMsForYear >= now.getTime();
  // Happening now = we know the real start day (not the month-only fallback) and
  // today falls inside the run. Without an explicit typicalDay the start is a
  // guess, and calling a conference underway on a guessed date would be a
  // fabricated fact — those stay under "Coming Up".
  const isHappeningNow =
    conf.typicalDay !== undefined &&
    targetMs <= now.getTime() &&
    endMsForYear >= now.getTime();
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
  return { label, sortMs: targetMs, isUpcoming, isHappeningNow };
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

type ConferenceStatus = "now" | "soon" | "plain";

const CONFERENCE_STATUS_ACCENT: Record<Exclude<ConferenceStatus, "plain">, string> = {
  now: "#6d28d9",
  soon: "#16a34a",
};

function ConferenceRow({
  conf,
  dateLabel,
  status,
}: {
  conf: TechConference;
  dateLabel: string;
  status: ConferenceStatus;
}) {
  const accent = status === "plain" ? null : CONFERENCE_STATUS_ACCENT[status];
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
            color: accent ?? "var(--sb-muted)",
            fontWeight: accent ? 700 : 400,
            lineHeight: 1.3,
          }}
        >
          {dateLabel}
        </div>
        {accent && (
          <div
            style={{
              fontSize: 9,
              fontFamily: "'Space Mono', monospace",
              color: accent,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginTop: 2,
            }}
          >
            {status === "now" ? "Happening now" : "Coming up"}
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

const CONFERENCE_GROUP_HEAD_STYLE = {
  fontSize: 10,
  fontWeight: 700,
  fontFamily: "'Space Mono', monospace",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  marginBottom: 10,
  paddingBottom: 6,
  borderBottom: "2px solid var(--sb-border-light)",
} as const;

function AnnualConferencesSection() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const withDates = TECH_CONFERENCES.map((conf) => ({
    conf,
    ...getConferenceNextDate(conf, now),
  })).sort((a, b) => a.sortMs - b.sortMs);

  const happeningNow = withDates.filter((c) => c.isHappeningNow);
  const upcoming = withDates.filter((c) => c.isUpcoming && !c.isHappeningNow);
  const laterThisYear = withDates.filter(
    (c) => !c.isUpcoming && new Date(c.sortMs).getFullYear() === currentYear,
  );
  const nextYear = withDates.filter(
    (c) => !c.isUpcoming && new Date(c.sortMs).getFullYear() > currentYear,
  );

  const hasAny =
    happeningNow.length + upcoming.length + laterThisYear.length + nextYear.length > 0;

  return (
    <div className="tech-section">
      <div className="tech-section-head">
        <h3 className="tech-section-title">Annual Tech Conferences</h3>
        <span className="tech-section-note">
          Major SV events · South Bay and nearby · typical annual timing
        </span>
      </div>

      {happeningNow.length > 0 && (
        <>
          <div style={{ ...CONFERENCE_GROUP_HEAD_STYLE, color: "#6d28d9" }}>Happening Now</div>
          {happeningNow.map(({ conf, label }) => (
            <ConferenceRow key={conf.id} conf={conf} dateLabel={label} status="now" />
          ))}
        </>
      )}

      {upcoming.length > 0 && (
        <>
          <div
            style={{
              ...CONFERENCE_GROUP_HEAD_STYLE,
              color: "#16a34a",
              marginTop: happeningNow.length > 0 ? 16 : 0,
            }}
          >
            Coming Up
          </div>
          {upcoming.map(({ conf, label }) => (
            <ConferenceRow key={conf.id} conf={conf} dateLabel={label} status="soon" />
          ))}
        </>
      )}

      {laterThisYear.length > 0 && (
        <>
          <div
            style={{
              ...CONFERENCE_GROUP_HEAD_STYLE,
              color: "#6b7280",
              marginTop: happeningNow.length + upcoming.length > 0 ? 16 : 0,
            }}
          >
            Later This Year
          </div>
          {laterThisYear.map(({ conf, label }) => (
            <ConferenceRow key={conf.id} conf={conf} dateLabel={label} status="plain" />
          ))}
        </>
      )}

      {nextYear.length > 0 && (
        <>
          <div
            style={{
              ...CONFERENCE_GROUP_HEAD_STYLE,
              color: "#6b7280",
              marginTop:
                happeningNow.length + upcoming.length + laterThisYear.length > 0 ? 16 : 0,
            }}
          >
            Next Year
          </div>
          {nextYear.map(({ conf, label }) => (
            <ConferenceRow key={conf.id} conf={conf} dateLabel={label} status="plain" />
          ))}
        </>
      )}

      {hasAny && (
        <div style={{ fontSize: 10, color: "var(--sb-muted)", marginTop: 8, fontStyle: "italic" }}>
          Dates are typical annual timing — confirm on the organizer's website before making plans.
        </div>
      )}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────

function FundingHighlightsSection() {
  const latest = [...RECENTLY_FUNDED]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 8);

  return (
    <div className="tech-section">
      <div className="tech-section-head">
        <h3 className="tech-section-title">Recently Funded</h3>
        <span className="tech-section-note">
          Latest public rounds · South Bay startups
        </span>
      </div>
      <div className="tech-funding-summary">
        <div>
          <strong>{RAISED_2026_LABEL}</strong>
          <span>Raised in {FUNDING_PERIOD_LABEL}</span>
        </div>
        <p>
          {ROUNDS_2026} tracked rounds this year, led by {Q1Q2_TOP_CATEGORIES_NOTE}.
          The list below keeps the latest notable announcements close without turning
          the page into a funding archive.
        </p>
      </div>
      <div>
        {latest.map((company) => (
          <RecentlyFundedCard key={company.id + company.date} company={company} />
        ))}
      </div>
    </div>
  );
}

function HiringSnapshot({ groups }: {
  groups: Array<{ label: string; note: string; companies: TechCompany[] }>;
}) {
  return (
    <div className="tech-section">
      <div className="tech-section-head">
        <h3 className="tech-section-title">Hiring Pulse</h3>
        <span className="tech-section-note">A quick read, not every open role</span>
      </div>
      <div className="tech-hiring-grid">
        {groups.map((group) => (
          <div key={group.label} className="tech-hiring-column">
            <div className="tech-hiring-label">{group.label}</div>
            <p>{group.note}</p>
            {group.companies.slice(0, 4).map((company) => (
              <HiringRow key={company.id} company={company} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// "Smaller, But Notable" is the startup/growth showcase — the public mega-caps
// (Intuit, Broadcom, Fortinet, …) already get the Anchor Employers leaderboard
// and Major Company Profiles up top, so leading with them here both buries the
// actual startups and contradicts the section's own "growth companies and
// startups" promise. Drop public-stage entries and surface startups first.
const SPOTLIGHT_STAGE_ORDER: Record<SccTechSpotlight["stage"], number> = {
  startup: 0,
  growth: 1,
  public: 2,
};

function SpotlightHighlightsSection() {
  const spotlight = [...SCC_SPOTLIGHT]
    .filter((c) => c.stage !== "public")
    .sort((a, b) => SPOTLIGHT_STAGE_ORDER[a.stage] - SPOTLIGHT_STAGE_ORDER[b.stage])
    .slice(0, 12);
  return (
    <div className="tech-section">
      <div className="tech-section-head">
        <h3 className="tech-section-title">Smaller, But Notable</h3>
        <span className="tech-section-note">
          A curated sample of growth companies and startups
        </span>
      </div>
      <div className="tech-spotlight-grid tech-spotlight-grid--compact">
        {spotlight.map((company) => (
          <SpotlightCard key={company.id} company={company} />
        ))}
      </div>
    </div>
  );
}

export default function TechnologyView() {
  const topCompanies = [...TECH_COMPANIES]
    .sort((a, b) => b.sccEmployeesK - a.sccEmployeesK)
    .slice(0, 8);

  const hiringGroups = [
    {
      label: "Actively Hiring",
      note: "Growing headcount — AI hardware demand lifting chipmakers and server builders, with security and SaaS also expanding",
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
      note: "Shrinking or restructuring locally — limited openings, cautious on headcount",
      companies: TECH_COMPANIES.filter((c) => c.trend === "down").sort(
        (a, b) => b.sccEmployeesK - a.sccEmployeesK
      ),
    },
  ];
  const pulseStats = [TECH_PULSE[0], TECH_PULSE[1], PULSE_RAISED_STAT, TECH_PULSE[2]];

  return (
    <div className="tech-view">
      <PageHero
        eyebrow="South Bay / Tech Desk"
        title="Technology"
        description="A readable snapshot of the companies, jobs, and funding rounds shaping the local tech economy."
        // The Q1–Q2 vintage belongs to the employment estimates only — the
        // funding stat beside it is derived live and already runs into Q3, so
        // say which number the date applies to instead of stamping the whole page.
        note="Santa Clara County employment estimates · Q1–Q2 2026 · Funding tracked through today · Not affiliated with any company listed"
        // --sb-teal (#22C6D3) is only ~2.1:1 on the hero background as text —
        // darkened within the same teal family to #0E7490 (~5.4:1) for the kicker.
        accent="#0E7490"
        stats={pulseStats.map((stat) => ({
          value: stat.value,
          label: stat.label,
          note: stat.note,
        }))}
      />

      <div className="tech-section">
        <div className="tech-section-head">
          <h3 className="tech-section-title">Anchor Employers</h3>
          <span className="tech-section-note">
            Ranked by Santa Clara County local jobs · Q1–Q2 2026
          </span>
        </div>
        <TopEmployersLeaderboard />
      </div>

      <FundingHighlightsSection />

      <div className="tech-section">
        <div className="tech-section-head">
          <h3 className="tech-section-title">Major Company Profiles</h3>
          <span className="tech-section-note">The largest local employers, trimmed to the essentials</span>
        </div>
        <div className="tech-grid">
          {topCompanies.map((company) => (
            <CompanyCard key={company.id} company={company} />
          ))}
        </div>
      </div>

      <HiringSnapshot groups={hiringGroups} />
      <SpotlightHighlightsSection />

      <div className="tech-footer-note">
        Employment figures are Santa Clara County estimates as of Q1–Q2 2026, derived from campus
        headcount reports, company filings, EDD data, and news coverage. Global headcounts are
        much larger. South Bay Today is not affiliated with any company listed and this is not
        investment advice.
      </div>
      <TechnologyViewStyles />
    </div>
  );
}

function TechnologyViewStyles() {
  return (
    <style>{`
      .tech-funding-summary {
        display: grid;
        grid-template-columns: minmax(140px, 220px) 1fr;
        gap: 18px;
        align-items: center;
        border: 1px solid var(--sb-border-light);
        background: var(--sb-card);
        padding: 16px;
      }
      .tech-funding-summary strong {
        display: block;
        color: var(--sb-ink);
        font-family: var(--sb-serif);
        font-size: 30px;
        line-height: 1;
      }
      .tech-funding-summary span {
        display: block;
        margin-top: 5px;
        color: var(--sb-muted);
        font-family: 'Space Mono', monospace;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .tech-funding-summary p {
        margin: 0;
        color: var(--sb-muted);
        font-size: 13px;
        line-height: 1.6;
      }
      .tech-hiring-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 22px;
      }
      .tech-hiring-column {
        min-width: 0;
      }
      .tech-hiring-label {
        border-bottom: 2px solid var(--sb-border-light);
        color: var(--sb-ink);
        font-family: 'Space Mono', monospace;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.08em;
        margin-bottom: 7px;
        padding-bottom: 7px;
        text-transform: uppercase;
      }
      .tech-hiring-column p {
        margin: 0 0 8px;
        color: var(--sb-muted);
        font-size: 11px;
        font-style: italic;
        line-height: 1.45;
      }
      .tech-spotlight-grid--compact {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      @media (max-width: 760px) {
        .tech-funding-summary,
        .tech-hiring-grid,
        .tech-spotlight-grid--compact {
          grid-template-columns: 1fr;
        }
      }
    `}</style>
  );
}
