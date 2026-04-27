// ---------------------------------------------------------------------------
// City Hall This Week — upcoming council agenda items, surfaced on the home.
// ---------------------------------------------------------------------------
// Pulls noteworthy agenda items from upcoming-meetings.json (next ~7 days),
// filters out procedural / ceremonial items, and shows what residents could
// actually weigh in on at their nearest council meeting.
// ---------------------------------------------------------------------------

import upcomingMeetingsJson from "../../../data/south-bay/upcoming-meetings.json";

interface AgendaItem {
  title: string;
  sequence: number;
}

interface UpcomingMeeting {
  date: string;
  displayDate: string;
  bodyName: string;
  location: string | null;
  url: string;
  agendaItems?: AgendaItem[];
}

const meetings = (upcomingMeetingsJson as { meetings: Record<string, UpcomingMeeting | undefined> }).meetings;

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
};

const CITY_ACCENT: Record<string, string> = {
  campbell:        "#1d4ed8",
  "los-gatos":     "#b45309",
  saratoga:        "#065F46",
  cupertino:       "#6d28d9",
  sunnyvale:       "#0891b2",
  "mountain-view": "#0369a1",
  "san-jose":      "#be123c",
  "santa-clara":   "#b45309",
  "palo-alto":     "#1d4ed8",
  milpitas:        "#4d7c0f",
  "los-altos":     "#7c3aed",
};

// Items that show up on every agenda but say nothing about what's actually
// being decided — meeting logistics, roll-call placeholders, etc. Anything
// matching these gets dropped before we surface the row.
const PROCEDURAL_PATTERNS: RegExp[] = [
  /^public participation/i,
  /^adjourn/i,
  /^closed session/i,
  /^board and commission interviews?$/i,
  /^special (council )?meeting$/i,
  /^study session$/i,
  /^\d+\s*[ap]\.?\s*m\.?\s/i,            // "5 P.M. SPECIAL MEETING ..."
  /^(call to order|roll call|agenda review)/i,
  /^announcements?$/i,
  /^minutes? approval$/i,
  /^consent calendar$/i,
];

function isInteresting(item: AgendaItem): boolean {
  const t = item.title.trim();
  if (t.length < 18) return false;
  return !PROCEDURAL_PATTERNS.some((re) => re.test(t));
}

function shortenTitle(t: string): string {
  // Strip parenthetical case codes ("H23-040, T23-027 & ER23-251 - ") that
  // dominate land-use items so the human-readable part shows up first.
  let out = t.replace(/^[A-Z]\d{1,3}-\d{1,3}(?:\s*[,&]\s*[A-Z]+\d{1,3}-\d{1,3})*\s*-\s*/, "");
  // Drop trailing process notes the council clerk adds to nudge the order.
  out = out.replace(/\s*-\s*TO BE HEARD.*/i, "");
  // Collapse the trailing period — looks tidier in a single-line row.
  out = out.replace(/\.$/, "");
  return out.trim();
}

function isWithinNextDays(iso: string, days: number, todayIso: string): boolean {
  if (!iso || iso < todayIso) return false;
  const todayMs = Date.parse(todayIso + "T00:00:00");
  const targetMs = Date.parse(iso + "T00:00:00");
  if (Number.isNaN(todayMs) || Number.isNaN(targetMs)) return false;
  return targetMs - todayMs <= days * 86_400_000;
}

function dateLabel(iso: string, todayIso: string): string {
  if (iso === todayIso) return "Today";
  const todayMs = Date.parse(todayIso + "T00:00:00");
  const targetMs = Date.parse(iso + "T00:00:00");
  if (!Number.isNaN(todayMs) && !Number.isNaN(targetMs)) {
    const days = Math.round((targetMs - todayMs) / 86_400_000);
    if (days === 1) return "Tomorrow";
  }
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

interface SurfacedItem {
  cityId: string;
  cityLabel: string;
  accent: string;
  date: string;
  dateLabel: string;
  url: string;
  title: string;
  bodyName: string;
}

interface Props {
  /** External navigation hook — opens the Government tab. */
  onSeeAll?: () => void;
}

export default function CityHallThisWeek({ onSeeAll }: Props) {
  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  const cityRows: SurfacedItem[] = [];
  let totalCities = 0;
  let totalItems = 0;

  for (const [cityId, mtg] of Object.entries(meetings)) {
    if (!mtg) continue;
    if (!isWithinNextDays(mtg.date, 7, todayIso)) continue;
    totalCities += 1;
    const items = (mtg.agendaItems ?? []).filter(isInteresting);
    totalItems += items.length;
    if (items.length === 0) continue;

    // One row per city — pick the first interesting item so the list stays
    // diverse across the South Bay instead of getting steamrolled by SJ.
    const top = items[0];
    cityRows.push({
      cityId,
      cityLabel: CITY_LABEL[cityId] ?? cityId,
      accent: CITY_ACCENT[cityId] ?? "#1A1A1A",
      date: mtg.date,
      dateLabel: dateLabel(mtg.date, todayIso),
      url: mtg.url,
      title: shortenTitle(top.title),
      bodyName: mtg.bodyName,
    });
  }

  // Sooner meetings first, ties broken by city alpha so the order is stable.
  cityRows.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.cityLabel.localeCompare(b.cityLabel);
  });

  const visible = cityRows.slice(0, 5);
  if (visible.length === 0) return null;

  const summary = (() => {
    const meetingsLabel = `${totalCities} council meeting${totalCities === 1 ? "" : "s"} this week`;
    if (totalItems > 0) return `${meetingsLabel} · ${totalItems} agenda item${totalItems === 1 ? "" : "s"} on the docket`;
    return meetingsLabel;
  })();

  const handleSeeAll = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (onSeeAll) {
      e.preventDefault();
      onSeeAll();
    }
  };

  return (
    <section
      aria-label="City Hall This Week"
      style={{
        marginTop: 36,
        paddingTop: 28,
        borderTop: "1px solid #eee",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 26, fontWeight: 900, margin: 0, letterSpacing: -1, color: "#000", lineHeight: 1.05 }}>
          City Hall This Week
        </h2>
        <p style={{ fontSize: 13, color: "#666", margin: "4px 0 0", fontWeight: 500 }}>
          {summary}
        </p>
      </header>

      <ul className="chtw-list">
        {visible.map((row) => (
          <li key={`${row.cityId}-${row.date}`} className="chtw-row" style={{ borderLeftColor: row.accent }}>
            <a
              href={row.url}
              target="_blank"
              rel="noopener noreferrer"
              className="chtw-link"
            >
              <div className="chtw-meta">
                <span className="chtw-city" style={{ color: row.accent }}>{row.cityLabel}</span>
                <span className="chtw-dot">·</span>
                <span className="chtw-date">{row.dateLabel}</span>
              </div>
              <div className="chtw-title">{row.title}</div>
            </a>
          </li>
        ))}
      </ul>

      <a
        href="/gov"
        onClick={handleSeeAll}
        className="chtw-cta"
      >
        See all agendas on Gov →
      </a>

      <style>{`
        .chtw-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .chtw-row {
          background: #fff;
          border: 1px solid #eee;
          border-left: 4px solid #1A1A1A;
          border-radius: 8px;
          overflow: hidden;
          transition: transform 0.15s ease-out, box-shadow 0.15s ease-out;
        }
        .chtw-row:hover {
          transform: translateX(2px);
          box-shadow: 0 2px 6px rgba(0,0,0,0.06);
        }
        .chtw-link {
          display: block;
          padding: 10px 14px;
          text-decoration: none;
          color: inherit;
        }
        .chtw-meta {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          font-weight: 800;
          font-family: 'Space Mono', monospace;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 4px;
        }
        .chtw-city { font-weight: 800; }
        .chtw-dot { color: #bbb; }
        .chtw-date { color: #555; }
        .chtw-title {
          font-size: 14px;
          font-weight: 600;
          color: #1A1A1A;
          line-height: 1.35;
        }
        .chtw-cta {
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
        .chtw-cta:hover {
          color: #be123c;
          border-color: #be123c;
        }
      `}</style>
    </section>
  );
}
