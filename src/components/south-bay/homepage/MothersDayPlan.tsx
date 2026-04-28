// ---------------------------------------------------------------------------
// Mother's Day Plan — Mother's Day weekend teaser, surfaced on the Today tab.
// ---------------------------------------------------------------------------
// Pulls events explicitly themed for Mother's Day from upcoming-events.json
// (matches "mother", "mom", "mum" in the title/blurb), filters to the
// weekend leading up to and including Mother's Day, and renders them in
// the same row vocabulary as JustOpened / SummerCampsCountdown so the
// home tab reads as one voice. Counts down to Mother's Day so residents
// know how much runway is left to book brunch / tickets. Auto-hides the
// day after Mother's Day so the card retires without manual edits.
// ---------------------------------------------------------------------------

import upcomingEventsJson from "../../../data/south-bay/upcoming-events.json";

interface Event {
  id: string;
  title: string;
  date: string;
  time?: string | null;
  venue?: string | null;
  city?: string | null;
  category?: string | null;
  url?: string | null;
  blurb?: string | null;
  description?: string | null;
}

const data = upcomingEventsJson as { events: Event[] };

const CITY_LABEL: Record<string, string> = {
  "san-jose": "San José",
  "santa-clara": "Santa Clara",
  "sunnyvale": "Sunnyvale",
  "mountain-view": "Mountain View",
  "palo-alto": "Palo Alto",
  "los-altos": "Los Altos",
  "cupertino": "Cupertino",
  "campbell": "Campbell",
  "saratoga": "Saratoga",
  "los-gatos": "Los Gatos",
  "milpitas": "Milpitas",
  "santa-cruz": "Santa Cruz",
  "santa-clara-county": "South Bay",
};

// Same palette as JustOpened / SummerCampsCountdown / CityHallThisWeek.
const CITY_ACCENT: Record<string, string> = {
  "campbell":           "#1d4ed8",
  "los-gatos":          "#b45309",
  "saratoga":           "#065F46",
  "cupertino":          "#6d28d9",
  "sunnyvale":          "#0891b2",
  "mountain-view":      "#0369a1",
  "san-jose":           "#be123c",
  "santa-clara":        "#b45309",
  "palo-alto":          "#1d4ed8",
  "milpitas":           "#4d7c0f",
  "los-altos":          "#7c3aed",
  "santa-cruz":         "#0e7490",
  "santa-clara-county": "#1A1A1A",
};

const MAX_ROWS = 5;
// Day-of-week 0=Sunday … 6=Saturday. Mother's Day is the second Sunday of May.
const MAY = 4;

function findMothersDay(year: number): string {
  // Second Sunday of May.
  const may1 = new Date(Date.UTC(year, MAY, 1));
  const dow = may1.getUTCDay();
  const firstSunday = 1 + ((7 - dow) % 7);
  const day = firstSunday + 7;
  return `${year}-05-${String(day).padStart(2, "0")}`;
}

function daysBetween(fromIso: string, toIso: string): number {
  const fromMs = Date.parse(fromIso + "T00:00:00");
  const toMs = Date.parse(toIso + "T00:00:00");
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return 0;
  return Math.round((toMs - fromMs) / 86_400_000);
}

function formatDate(iso: string): string {
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatDayLabel(iso: string, mothersDayIso: string): string {
  if (iso === mothersDayIso) return "Sun, Mother's Day";
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

const MOM_RE = /\bmother'?s?\b|\bmoms?\b|\bmum'?s?\b/i;

function pickEvents(mothersDayIso: string): Event[] {
  const saturday = isoOffset(mothersDayIso, -1);
  const allowed = new Set([saturday, mothersDayIso]);
  const matches = data.events.filter((e) => {
    if (!e.date || !allowed.has(e.date)) return false;
    const text = `${e.title ?? ""} ${e.blurb ?? ""} ${e.description ?? ""}`;
    return MOM_RE.test(text);
  });

  // Sort: Mother's Day itself first, then earlier in the day before later;
  // within a day, prefer San Jose / South Bay venues over outliers.
  const southBayCities = new Set([
    "san-jose", "santa-clara", "sunnyvale", "mountain-view", "palo-alto",
    "los-altos", "cupertino", "campbell", "saratoga", "los-gatos", "milpitas",
  ]);
  matches.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const aSouth = southBayCities.has(a.city ?? "") ? 0 : 1;
    const bSouth = southBayCities.has(b.city ?? "") ? 0 : 1;
    if (aSouth !== bSouth) return aSouth - bSouth;
    return (a.time ?? "").localeCompare(b.time ?? "");
  });

  return matches.slice(0, MAX_ROWS);
}

function isoOffset(iso: string, days: number): string {
  const ms = Date.parse(iso + "T00:00:00") + days * 86_400_000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

interface Props {
  /** Hook for the "see all" link — opens the Events tab. */
  onSeeAll?: () => void;
}

export default function MothersDayPlan({ onSeeAll }: Props) {
  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const year = parseInt(todayIso.slice(0, 4), 10);
  const mothersDayIso = findMothersDay(year);

  const daysToMD = daysBetween(todayIso, mothersDayIso);
  // Show the card from ~3 weeks out through Mother's Day itself; retire the
  // morning after so the home tab moves on. If today is past this year's
  // Mother's Day, peek at next year (won't fire until April).
  if (daysToMD > 21) return null;
  if (daysToMD < 0) return null;

  const picks = pickEvents(mothersDayIso);
  if (picks.length === 0) return null;

  const headline = (() => {
    if (daysToMD > 1) return `${daysToMD} days until Mother's Day (Sun, ${formatDate(mothersDayIso)})`;
    if (daysToMD === 1) return `Mother's Day is tomorrow (${formatDate(mothersDayIso)})`;
    return `Mother's Day is today`;
  })();

  const handleSeeAll = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (onSeeAll) {
      e.preventDefault();
      onSeeAll();
    }
  };

  return (
    <section
      aria-label="Mother's Day Plan"
      style={{
        marginTop: 36,
        paddingTop: 28,
        borderTop: "1px solid #eee",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 26, fontWeight: 900, margin: 0, letterSpacing: -1, color: "#000", lineHeight: 1.05 }}>
          Mother's Day Plan
        </h2>
        <p style={{ fontSize: 13, color: "#666", margin: "4px 0 0", fontWeight: 500 }}>
          {headline} · {picks.length} pick{picks.length === 1 ? "" : "s"} for the weekend
        </p>
      </header>

      <ul className="md-list">
        {picks.map((evt) => {
          const cityId = evt.city ?? "santa-clara-county";
          const accent = CITY_ACCENT[cityId] ?? "#1A1A1A";
          const cityLabel = CITY_LABEL[cityId] ?? cityId;
          const dayLabel = formatDayLabel(evt.date, mothersDayIso);
          const time = evt.time ?? "";
          return (
            <li key={evt.id} className="md-row" style={{ borderLeftColor: accent }}>
              <a
                href={evt.url ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="md-link"
              >
                <div className="md-meta">
                  <span className="md-city" style={{ color: accent }}>{cityLabel}</span>
                  <span className="md-dot">·</span>
                  <span className="md-day">{dayLabel}</span>
                  {time && (
                    <>
                      <span className="md-dot">·</span>
                      <span className="md-time">{time}</span>
                    </>
                  )}
                </div>
                <div className="md-title">{evt.title}</div>
                {evt.blurb && <div className="md-blurb">{evt.blurb}</div>}
                {evt.venue && <div className="md-venue">{evt.venue}</div>}
              </a>
            </li>
          );
        })}
      </ul>

      {onSeeAll && (
        <a href="/events" onClick={handleSeeAll} className="md-cta">
          See all events →
        </a>
      )}

      <style>{`
        .md-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .md-row {
          background: #fff;
          border: 1px solid #eee;
          border-left: 4px solid #1A1A1A;
          border-radius: 8px;
          overflow: hidden;
          transition: transform 0.15s ease-out, box-shadow 0.15s ease-out;
        }
        .md-row:hover {
          transform: translateX(2px);
          box-shadow: 0 2px 6px rgba(0,0,0,0.06);
        }
        .md-link {
          display: block;
          padding: 10px 14px;
          text-decoration: none;
          color: inherit;
        }
        .md-meta {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          font-weight: 800;
          font-family: 'Space Mono', monospace;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 4px;
          flex-wrap: wrap;
        }
        .md-city { font-weight: 800; }
        .md-dot { color: #bbb; }
        .md-day { color: #555; }
        .md-time { color: #555; }
        .md-title {
          font-size: 14px;
          font-weight: 700;
          color: #1A1A1A;
          line-height: 1.35;
        }
        .md-blurb {
          font-size: 12px;
          color: #666;
          font-weight: 500;
          line-height: 1.4;
          margin-top: 2px;
        }
        .md-venue {
          font-size: 11px;
          color: #888;
          font-weight: 500;
          margin-top: 2px;
          font-family: 'Space Mono', monospace;
        }
        .md-cta {
          display: inline-block;
          margin-top: 12px;
          font-size: 12px;
          font-weight: 800;
          font-family: 'Space Mono', monospace;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: #1A1A1A;
          text-decoration: none;
          border-bottom: 2px solid #1A1A1A;
          padding-bottom: 1px;
        }
        .md-cta:hover {
          color: #be123c;
          border-color: #be123c;
        }
      `}</style>
    </section>
  );
}
