import HealthScoresCard from "../cards/HealthScoresCard";
import upcomingJson from "../../../data/south-bay/upcoming-events.json";
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

const allUpcoming = (upcomingJson as { events: UpcomingEvent[] }).events ?? (upcomingJson as UpcomingEvent[]);

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

export default function FoodView() {
  return (
    <>
      <FarmersMarkets />
      <HealthScoresCard />
    </>
  );
}
