import sccFoodOpeningsJson from "../../../data/south-bay/scc-food-openings.json";
import restaurantRadarJson from "../../../data/south-bay/restaurant-radar.json";
import { SOUTH_BAY_EVENTS, type SBEvent } from "../../../data/south-bay/events-data";
import PageHero from "../PageHero";

const DAY_NAMES = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"] as const;
const DAY_LABEL  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const CITY_DISPLAY: Record<string, string> = {
  "san-jose": "San José",
  "mountain-view": "Mountain View",
  "sunnyvale": "Sunnyvale",
  "santa-clara": "Santa Clara",
  "cupertino": "Cupertino",
  "milpitas": "Milpitas",
  "campbell": "Campbell",
  "saratoga": "Saratoga",
  "los-gatos": "Los Gatos",
  "los-altos": "Los Altos",
  "palo-alto": "Palo Alto",
};

function cityFor(cityId: string | null | undefined, fallback?: string): string {
  if (cityId && CITY_DISPLAY[cityId]) return CITY_DISPLAY[cityId];
  if (fallback) {
    return fallback.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return "";
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Openings, inspections, and coming soon ─────────────────────────────────

type FoodItem = {
  id: string;
  name: string;
  address: string | null;
  cityId: string | null;
  cityName: string;
  date?: string | null;
  inspectionDate?: string | null;
  status: "opened" | "inspection-complete" | "coming-soon";
  blurb?: string | null;
  photoRef?: string | null;
  image?: string | null;
};

function FoodTile({ item }: { item: FoodItem }) {
  const isOpen = item.status === "opened";
  const isInspection = item.status === "inspection-complete";
  const tone = isOpen ? "open" : isInspection ? "inspection" : "soon";
  // Tier 1: real Google Places photo. Tier 2: Recraft food illustration.
  // Tier 3: status-themed gradient.
  const photo = item.photoRef
    ? `/api/place-photo?ref=${encodeURIComponent(item.photoRef)}&w=480&h=480`
    : item.image
      ? item.image
      : null;
  const city = cityFor(item.cityId, item.cityName);
  const mapsQuery = encodeURIComponent(
    [item.name, item.address, city].filter(Boolean).join(" "),
  );
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`;
  const dateLabel = formatShortDate(isInspection ? item.inspectionDate ?? null : item.date ?? null);

  return (
    <a
      href={mapsHref}
      target="_blank"
      rel="noopener noreferrer"
      className={`food-tile food-tile-${tone}${photo ? "" : " food-tile--no-photo"}`}
    >
      {photo && (
        <img
          src={photo}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(e) => {
            const img = e.currentTarget;
            if (item.image && img.dataset.fallbackApplied !== "true") {
              img.dataset.fallbackApplied = "true";
              img.src = item.image;
              return;
            }
            img.hidden = true;
            img.closest(".food-tile")?.classList.add("food-tile--no-photo");
          }}
        />
      )}
      <div className="food-tile-shade" />
      <div className="food-tile-top">
        <span className="food-pill food-pill-light">{city}</span>
        <span className={`food-pill food-pill-${tone}`}>
          {isOpen ? "OPENED" : isInspection ? "INSPECTED" : "COMING SOON"}
        </span>
      </div>
      <div className="food-tile-bottom">
        <div className="food-tile-name">{item.name}</div>
        {item.blurb && <div className="food-tile-blurb">{item.blurb}</div>}
        <div className="food-tile-meta">
          {item.address && <span className="food-tile-addr">{item.address}</span>}
          {dateLabel && (
            <span>
              {isOpen ? `Opened ${dateLabel}` : isInspection ? `Final inspection ${dateLabel}` : `Permit ${dateLabel}`}
            </span>
          )}
        </div>
      </div>
    </a>
  );
}

function NewAndComingSoon() {
  const data = sccFoodOpeningsJson as {
    generatedAt: string;
    opened: FoodItem[];
    inspections: FoodItem[];
    comingSoon: FoodItem[];
  };
  const openedAll = (data.opened ?? []).filter((i) => i.name && i.cityId);
  const inspectionsAll = (data.inspections ?? []).filter((i) => i.name && i.cityId);
  const comingSoonAll = (data.comingSoon ?? []).filter((i) => i.name && i.cityId);
  const opened = openedAll.slice(0, 8);
  const inspections = inspectionsAll.slice(0, 8);
  const comingSoon = comingSoonAll.slice(0, 8);
  if (opened.length === 0 && inspections.length === 0 && comingSoon.length === 0) return null;

  const updated = formatShortDate(data.generatedAt.slice(0, 10));

  return (
    <section className="food-section">
      <header className="food-section-head">
        <h2 className="food-h2">Food Openings &amp; Permits</h2>
        <p className="food-sub">
          Verified openings, final inspections + permits
          {updated && <> · Updated {updated}</>}
        </p>
      </header>

      {opened.length > 0 && (
        <>
          <div className="food-eyebrow food-eyebrow-open">Verified Openings</div>
          <div className="food-tile-grid">
            {opened.map((item) => <FoodTile key={item.id} item={item} />)}
          </div>
        </>
      )}

      {inspections.length > 0 && (
        <>
          <div className="food-eyebrow food-eyebrow-inspection" style={{ marginTop: opened.length > 0 ? 28 : 0 }}>
            Recent Final Inspections
          </div>
          <div className="food-tile-grid">
            {inspections.map((item) => <FoodTile key={item.id} item={item} />)}
          </div>
        </>
      )}

      {comingSoon.length > 0 && (
        <>
          <div className="food-eyebrow food-eyebrow-soon" style={{ marginTop: opened.length > 0 || inspections.length > 0 ? 28 : 0 }}>
            Coming Soon
          </div>
          <div className="food-tile-grid">
            {comingSoon.map((item) => <FoodTile key={item.id} item={item} />)}
          </div>
        </>
      )}

      <p className="food-tile-note">
        Sourced from Santa Clara County health-permit records · Tap a tile to find it on Google Maps
      </p>
    </section>
  );
}

// ── Permit Pulse ─────────────────────────────────────────────────────────────

type RadarSignal = "closing" | "opening" | "activity";

type RadarItem = {
  id: string;
  city: string;
  address: string;
  name: string | null;
  description?: string;
  workType?: string;
  signal: RadarSignal;
  label: string;
  valuation?: number;
  date: string;
  blurb?: string | null;
};

function formatValuation(v: number | undefined): string | null {
  if (!v || v < 50_000) return null;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M build`;
  return `$${Math.round(v / 1000)}K build`;
}

function PermitPulseRow({ item }: { item: RadarItem }) {
  const isClose = item.signal === "closing";
  const city = cityFor(item.city);
  const dateLabel = formatShortDate(item.date);
  const valLabel = formatValuation(item.valuation);
  const mapsQuery = encodeURIComponent(
    [item.name, item.address, city].filter(Boolean).join(" "),
  );
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`;
  const icon = isClose ? "⚠" : item.signal === "opening" ? "✦" : "•";

  return (
    <a
      href={mapsHref}
      target="_blank"
      rel="noopener noreferrer"
      className={`pulse-row pulse-row-${item.signal}`}
    >
      <div className="pulse-icon" aria-hidden="true">{icon}</div>
      <div className="pulse-body">
        <div className="pulse-head">
          <span className="pulse-name">{item.name ?? "Unnamed permit"}</span>
          <span className={`pulse-pill pulse-pill-${item.signal}`}>{item.label}</span>
        </div>
        {item.blurb && <div className="pulse-blurb">{item.blurb}</div>}
        <div className="pulse-meta">
          <span className="pulse-addr">{item.address} · {city}</span>
          {valLabel && <span className="pulse-dot">·</span>}
          {valLabel && <span>{valLabel}</span>}
          {dateLabel && <span className="pulse-dot">·</span>}
          {dateLabel && <span>Permit {dateLabel}</span>}
        </div>
      </div>
    </a>
  );
}

function PermitPulse() {
  const data = restaurantRadarJson as {
    generatedAt: string;
    windowDays?: number;
    items: RadarItem[];
  };
  // De-dupe against scc-food-openings (already shown above) by lowercase name.
  const sccData = sccFoodOpeningsJson as {
    opened: Array<{ name?: string }>;
    inspections: Array<{ name?: string }>;
    comingSoon: Array<{ name?: string }>;
  };
  const sccNames = new Set<string>([
    ...(sccData.opened ?? []).map((i) => (i.name ?? "").trim().toLowerCase()).filter(Boolean),
    ...(sccData.inspections ?? []).map((i) => (i.name ?? "").trim().toLowerCase()).filter(Boolean),
    ...(sccData.comingSoon ?? []).map((i) => (i.name ?? "").trim().toLowerCase()).filter(Boolean),
  ]);

  // Render-time staleness guard: if the regen falls behind, drop items older
  // than the source's stated window so a Feb permit doesn't linger into May.
  const windowDays = data.windowDays ?? 60;
  const cutoffMs = Date.now() - windowDays * 86400_000;

  const items = (data.items ?? [])
    .filter((it) => it.name)
    .filter((it) => !sccNames.has(it.name!.trim().toLowerCase()))
    .filter((it) => {
      if (!it.date) return true;
      const t = new Date(it.date + "T12:00:00").getTime();
      return Number.isFinite(t) && t >= cutoffMs;
    });

  if (items.length === 0) return null;

  // Closures first, then openings, then activity. Within each, recent first.
  const order: Record<RadarSignal, number> = { closing: 0, opening: 1, activity: 2 };
  items.sort((a, b) => {
    const oa = order[a.signal] ?? 3;
    const ob = order[b.signal] ?? 3;
    if (oa !== ob) return oa - ob;
    return b.date.localeCompare(a.date);
  });
  const visibleItems = items.slice(0, 8);

  const updated = formatShortDate(data.generatedAt.slice(0, 10));

  return (
    <section className="food-section">
      <header className="food-section-head">
        <h2 className="food-h2">Opening Signals</h2>
        <p className="food-sub">
          Building-permit hints before they turn into public opening records
          {updated && <> · Updated {updated}</>}
        </p>
      </header>
      <div className="pulse-list">
        {visibleItems.map((item) => <PermitPulseRow key={item.id} item={item} />)}
      </div>
      <p className="food-tile-note">
        Sourced from San José &amp; Palo Alto building permits · Tap a row to find it on Google Maps
      </p>
    </section>
  );
}

// ── Farmers Markets ─────────────────────────────────────────────────────────

function FarmersMarkets() {
  // Pin to Pacific — the markets are here, and an unpinned viewer clock rolls
  // both the "today" ordering and the in-season month over a day early for
  // anyone browsing from east of PT.
  const [ptYear, ptMonth, ptDay] = new Date()
    .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })
    .split("-")
    .map(Number);
  const todayIdx = new Date(ptYear!, ptMonth! - 1, ptDay!).getDay();
  const month = ptMonth!;

  const markets = SOUTH_BAY_EVENTS.filter((e) => e.category === "market");
  const inSeason = (e: SBEvent) => !e.months || e.months.includes(month);

  // Bucket by day-of-week so the schedule reads like a weekly calendar.
  const byDay: SBEvent[][] = [[], [], [], [], [], [], []];
  for (const m of markets) {
    if (!inSeason(m)) continue;
    if (!m.days) continue;
    for (const d of m.days) {
      const idx = DAY_NAMES.indexOf(d as typeof DAY_NAMES[number]);
      if (idx >= 0) byDay[idx].push(m);
    }
  }

  // Re-order so today is first; trailing empty days get dropped.
  const orderedDays = Array.from({ length: 7 }, (_, i) => (todayIdx + i) % 7);
  const visibleDays = orderedDays.filter((d) => byDay[d].length > 0);
  if (visibleDays.length === 0) return null;

  return (
    <section className="food-section food-section-markets">
      <header className="food-section-head">
        <h2 className="food-h2">Farmers Markets</h2>
        <p className="food-sub">
          Weekly schedule across the South Bay, ordered from today onward
        </p>
      </header>

      <div className="market-week">
        {visibleDays.map((dayIdx) => {
          // Match on the actual weekday, not list position: market-free days
          // are dropped from visibleDays, so the first card is only "Today"
          // when today genuinely has a market. South Bay Mondays and Tuesdays
          // never do.
          const isToday = dayIdx === todayIdx;
          const label = isToday ? "Today" : DAY_LABEL[dayIdx];
          return (
            <div key={dayIdx} className={`market-day ${isToday ? "market-day-active" : ""}`}>
              <div className="market-day-head">{label}</div>
              <div className="market-day-items">
                {byDay[dayIdx].map((m) => {
                  const inner = (
                    <>
                      <span className="market-emoji">{m.emoji ?? "🥕"}</span>
                      <div className="market-row-body">
                        <div className="market-name">{m.title}</div>
                        <div className="market-meta">
                          {m.venue} · {cityFor(m.city)}
                          {m.time ? ` · ${m.time}` : ""}
                        </div>
                      </div>
                    </>
                  );
                  return m.url ? (
                    <a
                      key={m.id}
                      href={m.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="market-row"
                    >
                      {inner}
                    </a>
                  ) : (
                    <div key={m.id} className="market-row">{inner}</div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── View ────────────────────────────────────────────────────────────────────

function FoodHero() {
  const openings = sccFoodOpeningsJson as {
    generatedAt: string;
    opened: FoodItem[];
    inspections: FoodItem[];
    comingSoon: FoodItem[];
  };
  const updated = formatShortDate(openings.generatedAt.slice(0, 10));

  return (
    <PageHero
      eyebrow="South Bay / Food Desk"
      title="Food"
      description="Verified openings, recent final inspections, promising buildouts, and farmers markets across the South Bay."
      note={`Health-permit refresh ${updated || "recently"}`}
      // --sb-coral (#F43F7C) is only ~3.6:1 on the hero background as text —
      // darkened within the same coral/rose family to #BE123C (~6.3:1) for the kicker.
      accent="#BE123C"
      stats={[
        { value: openings.opened?.length ?? 0, label: "Verified openings" },
        { value: openings.inspections?.length ?? 0, label: "Final inspections" },
        { value: openings.comingSoon?.length ?? 0, label: "Coming soon" },
      ]}
    />
  );
}

export default function FoodView() {
  return (
    <div className="food-view">
      <FoodHero />
      <NewAndComingSoon />
      <div className="food-lower-grid">
        <PermitPulse />
        <FarmersMarkets />
      </div>
      <FoodViewStyles />
    </div>
  );
}

function FoodViewStyles() {
  return (
    <style>{`
      .food-view {
        display: flex;
        flex-direction: column;
        gap: 30px;
        font-family: 'Inter', sans-serif;
      }
      .food-kicker {
        color: var(--sb-muted);
        font-family: 'Space Mono', monospace;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .food-hero {
        padding-bottom: 24px;
        border-bottom: 3px double var(--sb-border);
      }
      .food-hero h1 {
        margin: 6px 0 10px;
        color: var(--sb-ink);
        font-family: var(--sb-serif);
        font-size: 42px;
        line-height: 1;
      }
      .food-hero p {
        max-width: 680px;
        margin: 0;
        color: var(--sb-muted);
        font-size: 15px;
        line-height: 1.65;
      }
      .food-hero-note {
        margin-top: 10px;
        color: var(--sb-light);
        font-size: 11px;
        letter-spacing: 0.03em;
      }
      .food-stat-row {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        margin-top: 22px;
        border: 1px solid var(--sb-border-light);
        background: var(--sb-card);
      }
      .food-stat-row > div {
        padding: 15px 16px;
        border-left: 1px solid var(--sb-border-light);
      }
      .food-stat-row > div:first-child { border-left: none; }
      .food-stat-row strong {
        display: block;
        color: var(--sb-ink);
        font-family: var(--sb-serif);
        font-size: 28px;
        line-height: 1;
      }
      .food-stat-row span {
        display: block;
        margin-top: 5px;
        color: var(--sb-muted);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .food-section { min-width: 0; }
      .food-section-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 18px;
        margin-bottom: 16px;
        border-bottom: 1px solid var(--sb-border);
        padding-bottom: 8px;
      }
      .food-h2 {
        margin: 0;
        color: var(--sb-ink);
        font-family: var(--sb-serif);
        font-size: 24px;
        font-weight: 800;
        line-height: 1.05;
      }
      .food-sub {
        max-width: 420px;
        margin: 0;
        color: var(--sb-muted);
        font-size: 12px;
        font-weight: 500;
        line-height: 1.45;
      }

      .food-eyebrow {
        font-size: 10px; font-weight: 800; font-family: 'Space Mono', monospace;
        letter-spacing: 0.12em; text-transform: uppercase;
        margin-bottom: 10px;
      }
      .food-eyebrow-open { color: #16a34a; }
      .food-eyebrow-inspection { color: #7c3aed; }
      .food-eyebrow-soon { color: #2563eb; }

      .food-tile-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }
      .food-tile {
        position: relative;
        display: block;
        aspect-ratio: 4 / 3;
        border-radius: 8px;
        overflow: hidden;
        text-decoration: none;
        color: #fff;
        background: #0f172a;
        border: 1px solid rgba(0,0,0,0.06);
        transition: transform 0.18s ease-out, box-shadow 0.18s ease-out;
        cursor: pointer;
      }
      .food-tile-open.food-tile--no-photo {
        background: linear-gradient(135deg, #0f766e 0%, #1d4ed8 100%);
      }
      .food-tile-inspection.food-tile--no-photo {
        background: linear-gradient(145deg, #581c87, #7c3aed 55%, #a855f7);
      }
      .food-tile-soon.food-tile--no-photo {
        background: linear-gradient(135deg, #4338ca 0%, #0f766e 100%);
      }
      .food-tile img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        filter: brightness(0.9) saturate(0.96);
      }
      .food-tile:hover {
        transform: translateY(-2px);
        box-shadow: 0 10px 22px rgba(0,0,0,0.14);
      }
      .food-tile-shade {
        position: absolute; inset: 0;
        background: linear-gradient(
          to bottom,
          rgba(0,0,0,0.18) 0%,
          rgba(0,0,0,0.18) 30%,
          rgba(0,0,0,0.58) 58%,
          rgba(0,0,0,0.86) 82%,
          rgba(0,0,0,0.96) 100%
        );
        pointer-events: none;
      }
      .food-tile-top {
        position: absolute; top: 8px; left: 8px; right: 8px;
        display: flex; justify-content: space-between; gap: 6px;
        z-index: 2;
      }
      .food-pill {
        font-size: 9px; font-weight: 800;
        letter-spacing: 0.04em; line-height: 1;
        padding: 4px 7px; border-radius: 999px;
        text-transform: uppercase; white-space: nowrap;
        max-width: 60%; overflow: hidden; text-overflow: ellipsis;
      }
      .food-pill-light { background: rgba(255,255,255,0.95); color: #111; }
      .food-pill-open  { background: #15803d; color: #fff; }
      .food-pill-inspection { background: #7c3aed; color: #fff; }
      .food-pill-soon  { background: #2563eb; color: #fff; }
      .food-tile-bottom {
        position: absolute; left: 12px; right: 12px; bottom: 10px;
        z-index: 2;
      }
      .food-tile-name {
        font-size: 14px; font-weight: 800;
        line-height: 1.2; color: #fff;
        text-shadow: 0 2px 5px rgba(0,0,0,0.85);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        margin-bottom: 3px;
      }
      .food-tile-blurb {
        font-size: 11px; font-weight: 650;
        color: rgba(255,255,255,0.98);
        line-height: 1.3;
        text-shadow: 0 2px 4px rgba(0,0,0,0.8);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        margin-bottom: 4px;
      }
      .food-tile-meta {
        display: flex; flex-wrap: wrap; gap: 6px;
        font-size: 10px; font-weight: 750;
        color: rgba(255,255,255,0.9);
        text-shadow: 0 2px 4px rgba(0,0,0,0.8);
      }
      .food-tile-addr {
        max-width: 100%;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .food-tile-note {
        margin-top: 14px; font-size: 11px; color: #aaa;
        text-align: right;
      }

      .food-lower-grid {
        display: flex;
        flex-direction: column;
        gap: 34px;
      }

      .pulse-list {
        display: flex; flex-direction: column;
        border: 1px solid var(--sb-border-light, #eee);
        border-radius: 8px;
        overflow: hidden;
        background: #fff;
      }
      .pulse-row {
        display: grid;
        grid-template-columns: 36px 1fr;
        gap: 12px;
        padding: 12px 14px;
        text-decoration: none;
        color: inherit;
        border-bottom: 1px solid var(--sb-border-light, #f1f1f1);
        transition: background 0.15s;
      }
      .pulse-row:last-child { border-bottom: none; }
      .pulse-row:hover { background: #fafafa; }
      .pulse-row:hover .pulse-name { color: var(--sb-accent, #2563eb); }
      .pulse-icon {
        display: flex; align-items: center; justify-content: center;
        width: 36px; height: 36px;
        border-radius: 8px;
        font-size: 16px;
        font-weight: 800;
        flex-shrink: 0;
        margin-top: 1px;
      }
      .pulse-row-closing .pulse-icon {
        background: #fef2f2; color: #b91c1c;
      }
      .pulse-row-opening .pulse-icon {
        background: #f0fdf4; color: #15803d;
      }
      .pulse-row-activity .pulse-icon {
        background: #eff6ff; color: #1d4ed8;
      }
      .pulse-body { min-width: 0; flex: 1; }
      .pulse-head {
        display: flex; align-items: center; gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 3px;
      }
      .pulse-name {
        font-size: 14px; font-weight: 700;
        color: var(--sb-ink, #111);
        line-height: 1.25;
        transition: color 0.15s;
      }
      .pulse-pill {
        font-size: 9px; font-weight: 800;
        font-family: 'Space Mono', monospace;
        letter-spacing: 0.06em;
        padding: 3px 7px; border-radius: 4px;
        text-transform: uppercase; line-height: 1;
        white-space: nowrap;
      }
      .pulse-pill-closing { background: #b91c1c; color: #fff; }
      .pulse-pill-opening { background: #15803d; color: #fff; }
      .pulse-pill-activity { background: #1d4ed8; color: #fff; }
      .pulse-blurb {
        font-size: 12.5px; font-weight: 500;
        color: var(--sb-ink-soft, #444);
        line-height: 1.4;
        margin-bottom: 4px;
      }
      .pulse-meta {
        display: flex; flex-wrap: wrap; gap: 4px;
        font-size: 11px; font-weight: 500;
        color: var(--sb-muted, #777);
      }
      .pulse-addr {
        max-width: 100%;
      }
      .pulse-dot { color: #ccc; }

      .market-week {
        display: flex; flex-direction: column; gap: 14px;
        border: 1px solid var(--sb-border-light);
        border-radius: 8px;
        padding: 12px;
        background: var(--sb-card);
      }
      .market-day {
        display: grid;
        grid-template-columns: 64px 1fr;
        gap: 14px;
        padding: 10px 0 10px 0;
        border-top: 1px solid var(--sb-border-light, #eee);
      }
      .market-day:first-child { border-top: none; padding-top: 0; }
      .market-day-active .market-day-head {
        color: var(--sb-accent, #2563eb);
      }
      .market-day-head {
        font-size: 11px; font-weight: 800;
        font-family: 'Space Mono', monospace;
        letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--sb-muted, #666);
        padding-top: 4px;
      }
      .market-day-items {
        display: flex; flex-direction: column; gap: 1px;
      }
      .market-row {
        display: flex; align-items: baseline; gap: 10px;
        padding: 6px 0;
        text-decoration: none;
        color: inherit;
        border-bottom: 1px solid var(--sb-border-light, #f1f1f1);
      }
      .market-row:last-child { border-bottom: none; }
      .market-row:hover .market-name {
        color: var(--sb-accent, #2563eb);
      }
      .market-emoji { font-size: 18px; line-height: 1; flex-shrink: 0; }
      .market-row-body { flex: 1; min-width: 0; }
      .market-name {
        font-size: 13px; font-weight: 600;
        color: var(--sb-ink, #111);
        transition: color 0.15s;
      }
      .market-meta {
        font-size: 11px; color: var(--sb-muted, #666);
        margin-top: 1px;
      }

      @media (max-width: 760px) {
        .food-hero h1 { font-size: 34px; }
        .food-stat-row { grid-template-columns: 1fr; }
        .food-stat-row > div {
          border-left: none;
          border-top: 1px solid var(--sb-border-light);
        }
        .food-stat-row > div:first-child { border-top: none; }
        .food-section-head { display: block; }
        .food-sub { margin-top: 4px; }
        .food-tile-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
        .food-tile { aspect-ratio: 1 / 1; }
        .food-tile-name { font-size: 13px; }
        .food-tile-blurb { -webkit-line-clamp: 2; }
        .market-day { grid-template-columns: 56px 1fr; gap: 10px; }
        .pulse-row { grid-template-columns: 30px 1fr; gap: 10px; padding: 10px 12px; }
        .pulse-icon { width: 30px; height: 30px; font-size: 14px; border-radius: 8px; }
        .pulse-name { font-size: 13px; }
      }
    `}</style>
  );
}
