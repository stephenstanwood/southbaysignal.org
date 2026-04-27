// ---------------------------------------------------------------------------
// School Year Endgame — final-stretch milestones for South Bay parents.
// ---------------------------------------------------------------------------
// Pulls AP exams, finals, graduations, and last-day-of-school dates from
// school-calendar.json and surfaces them on the Today tab during the spring
// run-out. Groups events that share a date+label across districts so a single
// row reads "AP Exams · 5 HS Districts · May 4–May 15" instead of 5 rows.
// ---------------------------------------------------------------------------

import schoolCalendarJson from "../../../data/south-bay/school-calendar.json";

interface District {
  id: string;
  name: string;
  fullName: string;
  color: string;
  bg: string;
  cities: string[];
}

type EventType = "holiday" | "break" | "testing" | "finals" | "graduation" | "lastday";

interface SchoolEvent {
  id: string;
  districtId: string;
  label: string;
  type: EventType;
  startDate: string;
  endDate: string;
}

interface CalendarData {
  updatedAt: string;
  schoolYear: string;
  districts: District[];
  events: SchoolEvent[];
}

const data = schoolCalendarJson as unknown as CalendarData;

const HS_DISTRICT_IDS = new Set(["sjusd", "pausd", "fuhsd", "lgsuhsd", "mvla"]);
const FOCUS_TYPES = new Set<EventType>(["testing", "finals", "graduation", "lastday"]);

const TYPE_ACCENT: Record<EventType, string> = {
  testing: "#1d4ed8",
  finals: "#be123c",
  graduation: "#b45309",
  lastday: "#15803d",
  holiday: "#6b7280",
  break: "#6b7280",
};

const TYPE_TAG: Record<EventType, string> = {
  testing: "TESTING",
  finals: "FINALS",
  graduation: "GRADUATION",
  lastday: "LAST DAY",
  holiday: "HOLIDAY",
  break: "BREAK",
};

function daysBetween(fromIso: string, toIso: string): number {
  const fromMs = Date.parse(fromIso + "T00:00:00");
  const toMs = Date.parse(toIso + "T00:00:00");
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return 0;
  return Math.round((toMs - fromMs) / 86_400_000);
}

function formatRange(start: string, end: string): string {
  const startDate = new Date(start + "T12:00:00");
  const endDate = new Date(end + "T12:00:00");
  if (start === end) {
    return startDate.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  const sameMonth = startDate.getMonth() === endDate.getMonth();
  const startStr = startDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endStr = sameMonth
    ? endDate.toLocaleDateString("en-US", { day: "numeric" })
    : endDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${startStr}–${endStr}`;
}

function formatRelative(start: string, end: string, todayIso: string): string {
  if (start === end) {
    if (start === todayIso) return "Today";
    const days = daysBetween(todayIso, start);
    if (days === 1) return "Tomorrow";
    if (days >= 2 && days <= 6) {
      return new Date(start + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
    }
  }
  return formatRange(start, end);
}

function formatDistricts(districts: District[]): string {
  if (districts.length === 0) return "";
  if (districts.length === data.districts.length) return "All Districts";
  const ids = new Set(districts.map((d) => d.id));
  if (ids.size === HS_DISTRICT_IDS.size && [...HS_DISTRICT_IDS].every((id) => ids.has(id))) {
    return "All HS Districts";
  }
  if (districts.length <= 3) return districts.map((d) => d.name).join(", ");
  return `${districts.slice(0, 2).map((d) => d.name).join(", ")} +${districts.length - 2} more`;
}

interface MilestoneRow {
  key: string;
  startDate: string;
  endDate: string;
  label: string;
  type: EventType;
  districts: District[];
}

function buildMilestones(todayIso: string): MilestoneRow[] {
  const districtById = new Map(data.districts.map((d) => [d.id, d] as const));
  const todayMs = Date.parse(todayIso + "T00:00:00");

  const inWindow = data.events.filter((e) => {
    const endMs = Date.parse(e.endDate + "T23:59:59");
    if (Number.isNaN(endMs) || endMs < todayMs) return false;
    if (FOCUS_TYPES.has(e.type)) return true;
    return false;
  });

  const grouped = new Map<string, MilestoneRow>();
  for (const e of inWindow) {
    const district = districtById.get(e.districtId);
    if (!district) continue;
    const key = `${e.startDate}|${e.endDate}|${e.label}|${e.type}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.districts.push(district);
    } else {
      grouped.set(key, {
        key,
        startDate: e.startDate,
        endDate: e.endDate,
        label: e.label,
        type: e.type,
        districts: [district],
      });
    }
  }

  return Array.from(grouped.values()).sort((a, b) => {
    if (a.startDate !== b.startDate) return a.startDate.localeCompare(b.startDate);
    return a.label.localeCompare(b.label);
  });
}

function buildHeadline(todayIso: string): string | null {
  const upcomingLastDays = data.events
    .filter((e) => e.type === "lastday" && e.startDate >= todayIso)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (upcomingLastDays.length === 0) return null;

  const earliest = upcomingLastDays[0];
  const days = daysBetween(todayIso, earliest.startDate);
  const earliestLabel = new Date(earliest.startDate + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  if (days <= 0) return "Final week of school";
  if (days === 1) return "First district lets out tomorrow";
  if (days <= 14) return `${days} days until the first district lets out (${earliestLabel})`;
  return `Final stretch · first district lets out ${earliestLabel}`;
}

interface Props {
  onSeeAll?: () => void;
}

export default function SchoolYearEndgame({ onSeeAll }: Props) {
  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  const milestones = buildMilestones(todayIso).slice(0, 6);
  if (milestones.length === 0) return null;

  const headline = buildHeadline(todayIso);

  const handleSeeAll = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (onSeeAll) {
      e.preventDefault();
      onSeeAll();
    }
  };

  return (
    <section
      aria-label="School Year Endgame"
      style={{
        marginTop: 36,
        paddingTop: 28,
        borderTop: "1px solid #eee",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 26, fontWeight: 900, margin: 0, letterSpacing: -1, color: "#000", lineHeight: 1.05 }}>
          School Year Endgame
        </h2>
        {headline && (
          <p style={{ fontSize: 13, color: "#666", margin: "4px 0 0", fontWeight: 500 }}>
            {headline}
          </p>
        )}
      </header>

      <ul className="sye-list">
        {milestones.map((row) => (
          <li key={row.key} className="sye-row" style={{ borderLeftColor: TYPE_ACCENT[row.type] }}>
            <div className="sye-meta">
              <span className="sye-tag" style={{ color: TYPE_ACCENT[row.type] }}>
                {TYPE_TAG[row.type]}
              </span>
              <span className="sye-dot">·</span>
              <span className="sye-date">{formatRelative(row.startDate, row.endDate, todayIso)}</span>
            </div>
            <div className="sye-title">{row.label}</div>
            <div className="sye-districts">{formatDistricts(row.districts)}</div>
          </li>
        ))}
      </ul>

      {onSeeAll && (
        <a href="/events" onClick={handleSeeAll} className="sye-cta">
          See more events →
        </a>
      )}

      <style>{`
        .sye-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .sye-row {
          background: #fff;
          border: 1px solid #eee;
          border-left: 4px solid #1A1A1A;
          border-radius: 8px;
          padding: 10px 14px;
          transition: transform 0.15s ease-out, box-shadow 0.15s ease-out;
        }
        .sye-row:hover {
          transform: translateX(2px);
          box-shadow: 0 2px 6px rgba(0,0,0,0.06);
        }
        .sye-meta {
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
        .sye-tag { font-weight: 800; }
        .sye-dot { color: #bbb; }
        .sye-date { color: #555; }
        .sye-title {
          font-size: 14px;
          font-weight: 700;
          color: #1A1A1A;
          line-height: 1.35;
        }
        .sye-districts {
          font-size: 12px;
          color: #666;
          font-weight: 500;
          margin-top: 2px;
        }
        .sye-cta {
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
        .sye-cta:hover {
          color: #15803d;
          border-color: #15803d;
        }
      `}</style>
    </section>
  );
}
