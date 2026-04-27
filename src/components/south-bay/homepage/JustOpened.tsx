// ---------------------------------------------------------------------------
// Just Opened — fresh South Bay food spots, surfaced on the home tab.
// ---------------------------------------------------------------------------
// Pulls "opened" entries from scc-food-openings.json (SCC health-permits
// pipeline), keeps the most recent across all cities, and renders them as a
// city-colored row list — same vocabulary as City Hall This Week so the home
// tab reads as a single voice. Falls back to coming-soon items if nothing has
// opened recently.
// ---------------------------------------------------------------------------

import sccFoodOpeningsJson from "../../../data/south-bay/scc-food-openings.json";

interface OpeningItem {
  id: string;
  name: string;
  address: string | null;
  cityId: string | null;
  cityName: string;
  date: string | null;
  status: "opened" | "coming-soon";
  blurb?: string | null;
  photoRef?: string | null;
}

const data = sccFoodOpeningsJson as {
  generatedAt: string;
  opened: OpeningItem[];
  comingSoon: OpeningItem[];
};

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

// Same palette as CityHallThisWeek so the home tab stays color-consistent.
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

const MAX_ROWS = 5;
const RECENT_WINDOW_DAYS = 30;

function daysBetween(fromIso: string, toIso: string): number {
  const fromMs = Date.parse(fromIso + "T00:00:00");
  const toMs = Date.parse(toIso + "T00:00:00");
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return Number.POSITIVE_INFINITY;
  return Math.round((toMs - fromMs) / 86_400_000);
}

function dateLabel(iso: string | null, todayIso: string): string {
  if (!iso) return "";
  if (iso === todayIso) return "Today";
  const days = daysBetween(iso, todayIso);
  if (days === 1) return "Yesterday";
  if (days >= 2 && days <= 6) return `${days} days ago`;
  if (days >= 7 && days <= 13) return "Last week";
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function buildRows(todayIso: string) {
  const opened = (data.opened ?? [])
    .filter((i) => i.name && i.cityId && i.date)
    .filter((i) => daysBetween(i.date as string, todayIso) <= RECENT_WINDOW_DAYS)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  if (opened.length >= 3) {
    return { kind: "opened" as const, items: opened.slice(0, MAX_ROWS) };
  }

  // Quiet week — pad with coming-soon so the section still has signal.
  const comingSoon = (data.comingSoon ?? [])
    .filter((i) => i.name && i.cityId && i.date)
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  const combined: OpeningItem[] = [...opened, ...comingSoon].slice(0, MAX_ROWS);
  if (combined.length === 0) return { kind: "empty" as const, items: [] };
  return { kind: "mixed" as const, items: combined };
}

interface Props {
  /** Hook for the "see all" link — opens the Food tab. */
  onSeeAll?: () => void;
}

export default function JustOpened({ onSeeAll }: Props) {
  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const { kind, items } = buildRows(todayIso);
  if (kind === "empty" || items.length === 0) return null;

  const openedCount = items.filter((i) => i.status === "opened").length;
  const summary = (() => {
    if (kind === "opened") {
      return `${openedCount} new spot${openedCount === 1 ? "" : "s"} welcomed first customers this month`;
    }
    return `${openedCount} just opened · ${items.length - openedCount} coming soon`;
  })();

  const handleSeeAll = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (onSeeAll) {
      e.preventDefault();
      onSeeAll();
    }
  };

  return (
    <section
      aria-label="Just Opened"
      style={{
        marginTop: 36,
        paddingTop: 28,
        borderTop: "1px solid #eee",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 26, fontWeight: 900, margin: 0, letterSpacing: -1, color: "#000", lineHeight: 1.05 }}>
          Just Opened
        </h2>
        <p style={{ fontSize: 13, color: "#666", margin: "4px 0 0", fontWeight: 500 }}>
          {summary}
        </p>
      </header>

      <ul className="jo-list">
        {items.map((item) => {
          const cityId = item.cityId as string;
          const accent = CITY_ACCENT[cityId] ?? "#1A1A1A";
          const cityLabel = CITY_LABEL[cityId] ?? item.cityName;
          const isOpen = item.status === "opened";
          const tag = isOpen ? "NEW" : "COMING SOON";
          const dateStr = dateLabel(item.date, todayIso);
          const mapsQuery = encodeURIComponent(
            [item.name, item.address, cityLabel].filter(Boolean).join(" "),
          );
          const mapsHref = `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`;
          return (
            <li key={item.id} className="jo-row" style={{ borderLeftColor: accent }}>
              <a
                href={mapsHref}
                target="_blank"
                rel="noopener noreferrer"
                className="jo-link"
              >
                <div className="jo-meta">
                  <span className="jo-city" style={{ color: accent }}>{cityLabel}</span>
                  <span className="jo-dot">·</span>
                  <span className={`jo-tag jo-tag--${isOpen ? "open" : "soon"}`}>{tag}</span>
                  {dateStr && (
                    <>
                      <span className="jo-dot">·</span>
                      <span className="jo-date">{dateStr}</span>
                    </>
                  )}
                </div>
                <div className="jo-title">{item.name}</div>
                {item.blurb && <div className="jo-blurb">{item.blurb}</div>}
              </a>
            </li>
          );
        })}
      </ul>

      {onSeeAll && (
        <a href="/food" onClick={handleSeeAll} className="jo-cta">
          See more on Food →
        </a>
      )}

      <style>{`
        .jo-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .jo-row {
          background: #fff;
          border: 1px solid #eee;
          border-left: 4px solid #1A1A1A;
          border-radius: 8px;
          overflow: hidden;
          transition: transform 0.15s ease-out, box-shadow 0.15s ease-out;
        }
        .jo-row:hover {
          transform: translateX(2px);
          box-shadow: 0 2px 6px rgba(0,0,0,0.06);
        }
        .jo-link {
          display: block;
          padding: 10px 14px;
          text-decoration: none;
          color: inherit;
        }
        .jo-meta {
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
        .jo-city { font-weight: 800; }
        .jo-dot { color: #bbb; }
        .jo-tag--open { color: #15803d; }
        .jo-tag--soon { color: #6d28d9; }
        .jo-date { color: #555; }
        .jo-title {
          font-size: 14px;
          font-weight: 700;
          color: #1A1A1A;
          line-height: 1.35;
        }
        .jo-blurb {
          font-size: 12px;
          color: #666;
          font-weight: 500;
          line-height: 1.4;
          margin-top: 2px;
        }
        .jo-cta {
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
        .jo-cta:hover {
          color: #15803d;
          border-color: #15803d;
        }
      `}</style>
    </section>
  );
}
