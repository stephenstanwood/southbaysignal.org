import HealthScoresCard from "../cards/HealthScoresCard";
import upcomingJson from "../../../data/south-bay/upcoming-events.json";
import restaurantRadarJson from "../../../data/south-bay/restaurant-radar.json";
import { SOUTH_BAY_EVENTS } from "../../../data/south-bay/events-data";

type UpcomingEvent = {
  id: string;
  title: string;
  date: string;
  displayDate: string;
  time: string | null;
  venue: string;
  city: string;
  category: string;
  cost: string;
  description: string;
  url: string | null;
};

const allUpcoming: UpcomingEvent[] = (upcomingJson as { events: UpcomingEvent[] }).events ?? (upcomingJson as unknown as UpcomingEvent[]);

const TODAY = new Date().toISOString().split("T")[0];
const NINETY_DAYS = new Date(Date.now() + 90 * 86400000).toISOString().split("T")[0];

function cityLabel(city: string) {
  return city.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function FarmersMarkets() {
  // From recurring events-data
  const today = new Date();
  const dayName = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][today.getDay()];
  const month = today.getMonth() + 1;

  const markets = SOUTH_BAY_EVENTS.filter((e) => e.category === "market");
  const todayMarkets = markets.filter((e) => {
    if (e.months && !e.months.includes(month)) return false;
    if (!e.days) return true;
    return e.days.includes(dayName as any);
  });
  const upcomingMarkets = markets.filter((e) => !todayMarkets.includes(e));

  // Also pull market events from upcoming-events.json
  const upcomingFoodEvents = allUpcoming
    .filter((e) => e.category === "market" || e.category === "food")
    .filter((e) => e.date >= TODAY && e.date <= NINETY_DAYS)
    .slice(0, 6);

  return (
    <div style={{ marginBottom: 28 }}>
      <div className="sb-section-header" style={{ marginBottom: 12 }}>
        <span className="sb-section-title">🛒 Farmers Markets</span>
      </div>

      {todayMarkets.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
            letterSpacing: "0.1em", textTransform: "uppercase",
            color: "var(--sb-accent)", marginBottom: 8,
          }}>
            Today
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {todayMarkets.map((e) => (
              <div key={e.id} style={{
                display: "flex", alignItems: "baseline", gap: 10,
                padding: "8px 0",
                borderBottom: "1px solid var(--sb-border-light)",
              }}>
                <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>{e.emoji}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--sb-ink)" }}>{e.title}</div>
                  <div style={{ fontSize: 11, color: "var(--sb-muted)" }}>
                    {e.venue} · {cityLabel(e.city)}{e.time ? ` · ${e.time}` : ""}
                  </div>
                </div>
                <span style={{ fontSize: 11, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace", flexShrink: 0 }}>FREE</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {upcomingMarkets.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
            letterSpacing: "0.1em", textTransform: "uppercase",
            color: "var(--sb-muted)", marginBottom: 8,
          }}>
            Weekly
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {upcomingMarkets.map((e) => (
              <div key={e.id} style={{
                display: "flex", alignItems: "baseline", gap: 10,
                padding: "8px 0",
                borderBottom: "1px solid var(--sb-border-light)",
              }}>
                <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>{e.emoji}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--sb-ink)" }}>{e.title}</div>
                  <div style={{ fontSize: 11, color: "var(--sb-muted)" }}>
                    {e.venue} · {cityLabel(e.city)}{e.time ? ` · ${e.time}` : ""}{e.days ? ` · ${e.days.map((d) => d[0].toUpperCase() + d.slice(1)).join(", ")}` : ""}
                  </div>
                </div>
                <span style={{ fontSize: 11, color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace", flexShrink: 0 }}>FREE</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {upcomingFoodEvents.length > 0 && (
        <div>
          <div style={{
            fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono', monospace",
            letterSpacing: "0.1em", textTransform: "uppercase",
            color: "var(--sb-muted)", marginBottom: 8,
          }}>
            Upcoming Food Events
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {upcomingFoodEvents.map((e) => (
              <div key={e.id} style={{
                display: "flex", alignItems: "baseline", gap: 10,
                padding: "8px 0",
                borderBottom: "1px solid var(--sb-border-light)",
              }}>
                <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>🥗</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--sb-ink)" }}>{e.title}</div>
                  <div style={{ fontSize: 11, color: "var(--sb-muted)" }}>
                    {e.venue} · {cityLabel(e.city)} · {e.displayDate}{e.time ? ` · ${e.time}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Restaurant Radar ────────────────────────────────────────────────────────

type RadarItem = {
  id: string;
  city?: string;
  address: string;
  name: string | null;
  blurb?: string | null;
  description: string;
  workType: string;
  signal: "opening" | "closing" | "activity";
  label: string;
  valuation: number;
  date: string;
};

const SIGNAL_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  "New Build":      { bg: "#dcfce7", color: "#166534", border: "#86efac" },
  "Major Buildout": { bg: "#dbeafe", color: "#1e40af", border: "#93c5fd" },
  "New Buildout":   { bg: "#dbeafe", color: "#1e40af", border: "#93c5fd" },
  "Renovation":     { bg: "#fef3c7", color: "#92400e", border: "#fcd34d" },
  "Possible Closure": { bg: "#fee2e2", color: "#991b1b", border: "#fca5a5" },
  "Permit Activity": { bg: "#f3f4f6", color: "#374151", border: "#d1d5db" },
};

const CITY_LABELS: Record<string, string> = {
  "san-jose": "San José",
  "palo-alto": "Palo Alto",
};

function RestaurantRadar() {
  const data = restaurantRadarJson as { items: RadarItem[]; cities?: string[]; city?: string; generatedAt: string };
  const items = data.items;
  if (!items || items.length === 0) return null;

  // Only show opening/closing signals (skip generic "Permit Activity" unless named)
  const notable = items.filter((it) => it.label !== "Permit Activity" || it.name);
  if (notable.length === 0) return null;

  const updatedDate = new Date(restaurantRadarJson.generatedAt).toLocaleDateString("en-US", {
    month: "short", day: "numeric",
  });

  const cityList = data.cities ? data.cities.join(" · ") : (data.city ?? "San Jose");

  return (
    <div style={{ marginBottom: 28 }}>
      <div className="sb-section-header" style={{ marginBottom: 4 }}>
        <span className="sb-section-title">🍽 Restaurant Radar</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--sb-muted)", marginBottom: 12 }}>
        New buildouts &amp; permit activity · {cityList} · Updated {updatedDate}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {notable.map((item) => {
          const styles = SIGNAL_STYLES[item.label] ?? SIGNAL_STYLES["Permit Activity"];
          const dateLabel = new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
            month: "short", day: "numeric",
          });
          const cityLabel = item.city ? CITY_LABELS[item.city] ?? item.city : null;
          return (
            <div
              key={item.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "10px 0",
                borderBottom: "1px solid var(--sb-border-light)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginBottom: 3,
                }}>
                  <span style={{
                    fontWeight: 600, fontSize: 13, fontFamily: "var(--sb-sans)",
                    color: "var(--sb-ink)",
                  }}>
                    {item.name ?? item.address}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace",
                    background: styles.bg, color: styles.color, border: `1px solid ${styles.border}`,
                    borderRadius: 3, padding: "2px 6px", whiteSpace: "nowrap",
                  }}>
                    {item.label}
                  </span>
                </div>
                {item.blurb && (
                  <div style={{ fontSize: 12, color: "var(--sb-muted)", lineHeight: 1.5, marginBottom: 4 }}>
                    {item.blurb}
                  </div>
                )}
                <div style={{ fontSize: 11, color: "var(--sb-muted)", display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span>{item.address}</span>
                  {cityLabel && (
                    <>
                      <span style={{ color: "var(--sb-border)" }}>·</span>
                      <span>{cityLabel}</span>
                    </>
                  )}
                  <span style={{ color: "var(--sb-border)" }}>·</span>
                  <span>{item.workType}</span>
                  {item.valuation > 0 && (
                    <>
                      <span style={{ color: "var(--sb-border)" }}>·</span>
                      <span>${item.valuation.toLocaleString()}</span>
                    </>
                  )}
                  <span style={{ color: "var(--sb-border)" }}>·</span>
                  <span>{dateLabel}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: "var(--sb-muted)", marginTop: 8, fontStyle: "italic" }}>
        Based on building permits issued by San José and Palo Alto. A permit doesn't mean open yet — it means construction is underway.
      </div>
    </div>
  );
}

export default function FoodView() {
  return (
    <>
      <RestaurantRadar />
      <FarmersMarkets />
      <HealthScoresCard />
    </>
  );
}
