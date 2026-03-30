import { useState, useMemo } from "react";
import {
  CAMPS,
  SUMMER_WEEKS,
  type Camp,
  type CampType,
  type CampWeek,
} from "../../../data/south-bay/camps-data";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CITY_ACCENT: Record<string, string> = {
  "san-jose":      "#be123c",
  "mountain-view": "#0369a1",
  "sunnyvale":     "#0891b2",
  "santa-clara":   "#b45309",
  "cupertino":     "#6d28d9",
  "campbell":      "#1d4ed8",
  "milpitas":      "#4d7c0f",
  "los-gatos":     "#b45309",
  "palo-alto":     "#1d4ed8",
  "saratoga":      "#065F46",
  "los-altos":     "#7c3aed",
};

const TYPE_FILTERS: { id: CampType | "all"; label: string }[] = [
  { id: "all",       label: "All"       },
  { id: "general",   label: "General"   },
  { id: "sports",    label: "Sports"    },
  { id: "arts",      label: "Arts"      },
  { id: "stem",      label: "STEM"      },
  { id: "nature",    label: "Nature"    },
  { id: "specialty", label: "Specialty" },
];

const TYPE_COLORS: Record<CampType, string> = {
  general:   "#6b7280",
  sports:    "#1d4ed8",
  arts:      "#9333ea",
  stem:      "#0369a1",
  nature:    "#15803d",
  specialty: "#b45309",
};

const ALL_CITIES = Array.from(new Set(CAMPS.map((c) => c.cityId))).sort();

function getCityLabel(cityId: string): string {
  return CAMPS.find((c) => c.cityId === cityId)?.cityName ?? cityId;
}

// Camp has a given week number
function campHasWeek(camp: Camp, weekNum: number): boolean {
  return camp.weeks.some((w) => w.weekNum === weekNum);
}

// Get camp week data for a specific week number
function getCampWeek(camp: Camp, weekNum: number): CampWeek | undefined {
  return camp.weeks.find((w) => w.weekNum === weekNum);
}

// Price range label for a camp
function priceRange(camp: Camp): string {
  const prices = camp.weeks
    .map((w) => w.residentPrice)
    .filter((p): p is number => p !== null);
  if (!prices.length) return "Contact for pricing";
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? `$${min}/wk` : `$${min}–$${max}/wk`;
}

// Weeks label: "Wks 1–8" or similar
function weeksLabel(camp: Camp): string {
  const nums = camp.weeks.map((w) => w.weekNum).sort((a, b) => a - b);
  if (!nums.length) return "";
  if (nums.length === 1) return `Wk ${nums[0]}`;
  return `Wks ${nums[0]}–${nums[nums.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Camp card (Browse mode)
// ---------------------------------------------------------------------------

function CampCard({ camp }: { camp: Camp }) {
  const accent = CITY_ACCENT[camp.cityId] ?? "#555";
  const typeColor = TYPE_COLORS[camp.type];

  return (
    <div style={{
      background: "var(--sb-card)",
      border: "1px solid var(--sb-border-light)",
      borderLeft: `3px solid ${accent}`,
      borderRadius: "var(--sb-radius)",
      padding: "16px 18px",
    }}>
      {/* Badges row */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 3,
          background: accent + "18", color: accent,
          letterSpacing: "0.04em",
        }}>
          {camp.cityName}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 3,
          background: typeColor + "18", color: typeColor,
          letterSpacing: "0.04em", textTransform: "uppercase",
        }}>
          {camp.type}
        </span>
        {camp.featured && (
          <span style={{ fontSize: 10, color: "#b45309", fontWeight: 700, marginLeft: "auto" }}>
            ★ Featured
          </span>
        )}
      </div>

      {/* Name */}
      <div style={{
        fontFamily: "var(--sb-serif)",
        fontWeight: 700,
        fontSize: 16,
        color: "var(--sb-ink)",
        lineHeight: 1.3,
        marginBottom: 5,
      }}>
        {camp.name}
      </div>

      {/* Description */}
      <p style={{
        fontSize: 13,
        color: "var(--sb-muted)",
        lineHeight: 1.55,
        margin: "0 0 10px",
      }}>
        {camp.description}
      </p>

      {/* Details grid */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
        <div>
          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block" }}>Ages</span>
          <span style={{ fontSize: 12, color: "var(--sb-ink)" }}>{camp.ageMin}–{camp.ageMax}</span>
        </div>
        <div>
          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block" }}>Hours</span>
          <span style={{ fontSize: 12, color: "var(--sb-ink)" }}>{camp.hours}</span>
        </div>
        <div>
          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block" }}>Price</span>
          <span style={{ fontSize: 12, color: "var(--sb-ink)", fontWeight: 600 }}>{priceRange(camp)}</span>
        </div>
        <div>
          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block" }}>Coverage</span>
          <span style={{ fontSize: 12, color: "var(--sb-ink)" }}>{weeksLabel(camp)}</span>
        </div>
      </div>

      {/* Locations */}
      <div style={{ fontSize: 11, color: "var(--sb-muted)", marginBottom: 10 }}>
        📍 {camp.locations.join(" · ")}
      </div>

      {/* Week chips */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12 }}>
        {SUMMER_WEEKS.map((sw) => {
          const has = campHasWeek(camp, sw.weekNum);
          return (
            <span key={sw.weekNum} style={{
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 100,
              border: `1px solid ${has ? accent : "var(--sb-border-light)"}`,
              background: has ? accent + "18" : "transparent",
              color: has ? accent : "var(--sb-light, #888)",
              fontFamily: "'Space Mono', monospace",
              fontWeight: has ? 700 : 400,
            }}>
              W{sw.weekNum}
            </span>
          );
        })}
      </div>

      {/* Tags */}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 12 }}>
        {camp.tags.map((tag) => (
          <span key={tag} style={{
            fontSize: 10,
            padding: "2px 7px",
            borderRadius: 100,
            border: "1px solid var(--sb-border-light)",
            color: "var(--sb-muted)",
          }}>
            {tag}
          </span>
        ))}
      </div>

      {camp.notes && (
        <div style={{
          fontSize: 11, color: "var(--sb-muted)", fontStyle: "italic",
          marginBottom: 12, lineHeight: 1.5,
          padding: "6px 8px", background: "var(--sb-bg)", borderRadius: "var(--sb-radius)",
        }}>
          {camp.notes}
        </div>
      )}

      <a
        href={camp.registerUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-block",
          padding: "7px 14px",
          background: accent,
          color: "#fff",
          fontSize: 11,
          fontWeight: 700,
          textDecoration: "none",
          borderRadius: "var(--sb-radius)",
          letterSpacing: "0.04em",
        }}
      >
        Register →
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browse mode
// ---------------------------------------------------------------------------

function BrowseMode() {
  const [selectedCities, setSelectedCities] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<CampType | "all">("all");
  const [ageMin, setAgeMin] = useState<string>("");
  const [ageMax, setAgeMax] = useState<string>("");
  const [weekFilter, setWeekFilter] = useState<number | "all">("all");

  const toggleCity = (cityId: string) => {
    setSelectedCities((prev) => {
      const next = new Set(prev);
      if (next.has(cityId)) next.delete(cityId);
      else next.add(cityId);
      return next;
    });
  };

  const filtered = useMemo(() => {
    return CAMPS.filter((camp) => {
      if (selectedCities.size > 0 && !selectedCities.has(camp.cityId)) return false;
      if (typeFilter !== "all" && camp.type !== typeFilter) return false;
      if (ageMin !== "" && camp.ageMax < parseInt(ageMin)) return false;
      if (ageMax !== "" && camp.ageMin > parseInt(ageMax)) return false;
      if (weekFilter !== "all" && !campHasWeek(camp, weekFilter)) return false;
      return true;
    });
  }, [selectedCities, typeFilter, ageMin, ageMax, weekFilter]);

  return (
    <div>
      {/* City filter */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
          City
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {ALL_CITIES.map((cityId) => {
            const active = selectedCities.has(cityId);
            return (
              <button
                key={cityId}
                onClick={() => toggleCity(cityId)}
                style={{
                  fontSize: 11,
                  padding: "4px 10px",
                  borderRadius: 100,
                  border: active ? `1px solid ${CITY_ACCENT[cityId] ?? "#555"}` : "1px solid var(--sb-border)",
                  background: active ? (CITY_ACCENT[cityId] ?? "#555") + "18" : "transparent",
                  color: active ? (CITY_ACCENT[cityId] ?? "#555") : "var(--sb-muted)",
                  cursor: "pointer",
                  fontWeight: active ? 700 : 400,
                  transition: "all 0.12s",
                }}
              >
                {getCityLabel(cityId)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Type + week + age filters */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 20, alignItems: "flex-end" }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            Type
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {TYPE_FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setTypeFilter(f.id)}
                className={`camps-filter-pill${typeFilter === f.id ? " camps-filter-pill--active" : ""}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            Week
          </div>
          <select
            value={weekFilter === "all" ? "all" : weekFilter}
            onChange={(e) => setWeekFilter(e.target.value === "all" ? "all" : parseInt(e.target.value))}
            style={{
              fontSize: 12,
              padding: "5px 10px",
              border: "1px solid var(--sb-border)",
              borderRadius: "var(--sb-radius)",
              background: "var(--sb-card)",
              color: "var(--sb-ink)",
              cursor: "pointer",
            }}
          >
            <option value="all">All weeks</option>
            {SUMMER_WEEKS.map((sw) => (
              <option key={sw.weekNum} value={sw.weekNum}>
                Week {sw.weekNum} ({sw.label})
              </option>
            ))}
          </select>
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--sb-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            Child's Age
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="number"
              min={4}
              max={17}
              placeholder="Min"
              value={ageMin}
              onChange={(e) => setAgeMin(e.target.value)}
              style={{
                width: 60,
                fontSize: 12,
                padding: "5px 8px",
                border: "1px solid var(--sb-border)",
                borderRadius: "var(--sb-radius)",
                background: "var(--sb-card)",
                color: "var(--sb-ink)",
              }}
            />
            <span style={{ fontSize: 12, color: "var(--sb-muted)" }}>–</span>
            <input
              type="number"
              min={4}
              max={17}
              placeholder="Max"
              value={ageMax}
              onChange={(e) => setAgeMax(e.target.value)}
              style={{
                width: 60,
                fontSize: 12,
                padding: "5px 8px",
                border: "1px solid var(--sb-border)",
                borderRadius: "var(--sb-radius)",
                background: "var(--sb-card)",
                color: "var(--sb-ink)",
              }}
            />
          </div>
        </div>
      </div>

      {/* Results */}
      <div style={{
        fontSize: 11,
        color: "var(--sb-muted)",
        marginBottom: 14,
        fontFamily: "'Space Mono', monospace",
      }}>
        {filtered.length} camp{filtered.length !== 1 ? "s" : ""} found
      </div>

      {filtered.length === 0 ? (
        <div style={{
          padding: "40px 20px",
          textAlign: "center",
          color: "var(--sb-muted)",
          border: "1px dashed var(--sb-border)",
          borderRadius: "var(--sb-radius)",
        }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>🏕️</div>
          <div style={{ fontFamily: "var(--sb-serif)", fontSize: 16, marginBottom: 4 }}>No camps match your filters</div>
          <div style={{ fontSize: 13 }}>Try adjusting the age range, week, or city selection.</div>
        </div>
      ) : (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          gap: 14,
        }}>
          {filtered.map((camp) => (
            <CampCard key={camp.id} camp={camp} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summer Builder mode
// ---------------------------------------------------------------------------

interface BuilderSuggestion {
  weekNum: number;
  weekLabel: string;
  options: Array<{ camp: Camp; week: CampWeek }>;
}

function SummerBuilderMode() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [childAge, setChildAge] = useState<string>("");
  const [selectedWeeks, setSelectedWeeks] = useState<Set<number>>(new Set());

  const toggleWeek = (weekNum: number) => {
    setSelectedWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(weekNum)) next.delete(weekNum);
      else next.add(weekNum);
      return next;
    });
  };

  const age = childAge !== "" ? parseInt(childAge) : null;

  const suggestions = useMemo((): BuilderSuggestion[] => {
    if (age === null) return [];
    const sorted = Array.from(selectedWeeks).sort((a, b) => a - b);
    return sorted.map((weekNum) => {
      const matchingCamps = CAMPS.filter(
        (camp) => age >= camp.ageMin && age <= camp.ageMax && campHasWeek(camp, weekNum)
      );
      const options = matchingCamps
        .map((camp) => ({ camp, week: getCampWeek(camp, weekNum)! }))
        .sort((a, b) => {
          const pa = a.week.residentPrice ?? 9999;
          const pb = b.week.residentPrice ?? 9999;
          if (pa !== pb) return pa - pb;
          return a.camp.cityName.localeCompare(b.camp.cityName);
        })
        .slice(0, 3);
      return { weekNum, weekLabel: SUMMER_WEEKS.find((sw) => sw.weekNum === weekNum)?.label ?? `Week ${weekNum}`, options };
    });
  }, [age, selectedWeeks]);

  const suggestedPlan = useMemo(() => {
    return suggestions
      .filter((s) => s.options.length > 0)
      .map((s) => ({ ...s.options[0], weekNum: s.weekNum, weekLabel: s.weekLabel }));
  }, [suggestions]);

  const totalCost = useMemo(() => {
    return suggestedPlan.reduce((sum, item) => {
      return sum + (item.week.residentPrice ?? 0);
    }, 0);
  }, [suggestedPlan]);

  const handleReset = () => {
    setStep(1);
    setChildAge("");
    setSelectedWeeks(new Set());
  };

  // Step 1: Age
  if (step === 1) {
    return (
      <div>
        <div style={{ maxWidth: 420, margin: "0 auto", textAlign: "center", padding: "32px 0 24px" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🏕️</div>
          <h2 style={{
            fontFamily: "var(--sb-serif)",
            fontSize: 22,
            fontWeight: 700,
            color: "var(--sb-ink)",
            marginBottom: 8,
          }}>
            Build your child's summer
          </h2>
          <p style={{ fontSize: 14, color: "var(--sb-muted)", marginBottom: 28, lineHeight: 1.6 }}>
            Tell us your child's age and which weeks you need coverage, and we'll put together a suggested camp plan with estimated costs.
          </p>

          <div style={{ marginBottom: 24 }}>
            <label style={{
              display: "block",
              fontSize: 12,
              fontWeight: 700,
              color: "var(--sb-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 8,
            }}>
              Child's Age
            </label>
            <input
              type="number"
              min={4}
              max={17}
              placeholder="e.g. 8"
              value={childAge}
              onChange={(e) => setChildAge(e.target.value)}
              style={{
                width: "100%",
                maxWidth: 120,
                fontSize: 24,
                fontWeight: 700,
                textAlign: "center",
                padding: "12px 16px",
                border: "2px solid var(--sb-border)",
                borderRadius: "var(--sb-radius)",
                background: "var(--sb-card)",
                color: "var(--sb-ink)",
                fontFamily: "var(--sb-sans)",
              }}
            />
          </div>

          <button
            onClick={() => age !== null && age >= 4 && age <= 17 && setStep(2)}
            disabled={age === null || age < 4 || age > 17}
            style={{
              padding: "10px 28px",
              background: age !== null && age >= 4 && age <= 17 ? "var(--sb-ink)" : "var(--sb-border)",
              color: age !== null && age >= 4 && age <= 17 ? "#fff" : "var(--sb-muted)",
              border: "none",
              borderRadius: "var(--sb-radius)",
              fontSize: 13,
              fontWeight: 700,
              cursor: age !== null && age >= 4 && age <= 17 ? "pointer" : "default",
              letterSpacing: "0.04em",
              transition: "all 0.15s",
            }}
          >
            Next: Pick your weeks →
          </button>
        </div>
      </div>
    );
  }

  // Step 2: Week selection
  if (step === 2) {
    return (
      <div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <button
              onClick={() => setStep(1)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: "var(--sb-muted)", fontSize: 13, padding: 0,
              }}
            >
              ← Back
            </button>
            <span style={{ fontSize: 12, color: "var(--sb-muted)" }}>Age {age}</span>
          </div>
          <h2 style={{
            fontFamily: "var(--sb-serif)",
            fontSize: 20,
            fontWeight: 700,
            color: "var(--sb-ink)",
            marginBottom: 6,
          }}>
            Which weeks need coverage?
          </h2>
          <p style={{ fontSize: 13, color: "var(--sb-muted)", marginBottom: 20 }}>
            Select the weeks you need a camp for. Week 2 is a short week (no Friday — July 4th holiday).
          </p>
        </div>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
          gap: 8,
          marginBottom: 28,
        }}>
          {SUMMER_WEEKS.map((sw) => {
            const selected = selectedWeeks.has(sw.weekNum);
            return (
              <button
                key={sw.weekNum}
                onClick={() => toggleWeek(sw.weekNum)}
                style={{
                  padding: "12px 10px",
                  border: selected ? "2px solid var(--sb-ink)" : "2px solid var(--sb-border-light)",
                  borderRadius: "var(--sb-radius)",
                  background: selected ? "var(--sb-ink)" : "var(--sb-card)",
                  color: selected ? "#fff" : "var(--sb-ink)",
                  cursor: "pointer",
                  textAlign: "center",
                  transition: "all 0.12s",
                }}
              >
                <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, marginBottom: 3 }}>
                  WEEK {sw.weekNum}
                </div>
                <div style={{ fontSize: 12, fontWeight: selected ? 700 : 400 }}>{sw.label}</div>
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={() => selectedWeeks.size > 0 && setStep(3)}
            disabled={selectedWeeks.size === 0}
            style={{
              padding: "10px 24px",
              background: selectedWeeks.size > 0 ? "var(--sb-ink)" : "var(--sb-border)",
              color: selectedWeeks.size > 0 ? "#fff" : "var(--sb-muted)",
              border: "none",
              borderRadius: "var(--sb-radius)",
              fontSize: 13,
              fontWeight: 700,
              cursor: selectedWeeks.size > 0 ? "pointer" : "default",
              letterSpacing: "0.04em",
            }}
          >
            See my plan ({selectedWeeks.size} week{selectedWeeks.size !== 1 ? "s" : ""}) →
          </button>
        </div>
      </div>
    );
  }

  // Step 3: Results
  const weeksWithNoCamps = suggestions.filter((s) => s.options.length === 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button
          onClick={() => setStep(2)}
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--sb-muted)", fontSize: 13, padding: 0,
          }}
        >
          ← Back
        </button>
        <h2 style={{
          fontFamily: "var(--sb-serif)",
          fontSize: 20,
          fontWeight: 700,
          color: "var(--sb-ink)",
          margin: 0,
        }}>
          Your Summer Plan
        </h2>
        <span style={{ fontSize: 12, color: "var(--sb-muted)", marginLeft: "auto" }}>Age {age}</span>
      </div>

      {/* Suggested plan summary */}
      {suggestedPlan.length > 0 && (
        <div style={{
          background: "#f0fdf4",
          border: "1px solid #86efac",
          borderLeft: "3px solid #15803d",
          borderRadius: "var(--sb-radius)",
          padding: "14px 16px",
          marginBottom: 20,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#15803d", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            Suggested Plan — Lowest Cost
          </div>
          {suggestedPlan.map((item) => (
            <div key={item.weekNum} style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 13,
              padding: "4px 0",
              borderBottom: "1px solid #bbf7d0",
            }}>
              <span style={{ color: "var(--sb-muted)", fontFamily: "'Space Mono', monospace", fontSize: 11 }}>
                Wk {item.weekNum}
              </span>
              <span style={{ color: "var(--sb-ink)", fontWeight: 600, flex: 1, marginLeft: 10 }}>
                {item.camp.name}
              </span>
              <span style={{ color: "#15803d", fontWeight: 700, fontSize: 12 }}>
                {item.week.residentPrice !== null ? `$${item.week.residentPrice}` : "—"}
              </span>
            </div>
          ))}
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 8,
            paddingTop: 6,
            borderTop: "2px solid #86efac",
            fontSize: 14,
            fontWeight: 700,
          }}>
            <span style={{ color: "#15803d" }}>Estimated total</span>
            <span style={{ color: "#15803d" }}>${totalCost}</span>
          </div>
          <div style={{ fontSize: 11, color: "#4ade80", marginTop: 6, fontStyle: "italic" }}>
            Resident prices shown. Verify all prices at each city's website.
          </div>
        </div>
      )}

      {/* Week-by-week options */}
      {suggestions.map((suggestion) => (
        <div key={suggestion.weekNum} style={{ marginBottom: 20 }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 10,
            paddingBottom: 6,
            borderBottom: "1px solid var(--sb-border-light)",
          }}>
            <span style={{
              fontFamily: "'Space Mono', monospace",
              fontSize: 11,
              fontWeight: 700,
              background: "var(--sb-ink)",
              color: "#fff",
              padding: "2px 8px",
              borderRadius: 3,
            }}>
              WEEK {suggestion.weekNum}
            </span>
            <span style={{ fontSize: 13, color: "var(--sb-ink)", fontWeight: 600 }}>{suggestion.weekLabel}</span>
            {suggestion.options.length === 0 && (
              <span style={{ fontSize: 11, color: "#b45309", fontWeight: 600 }}>No matches found</span>
            )}
          </div>

          {suggestion.options.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--sb-muted)", padding: "8px 0" }}>
              No camps found for age {age} in week {suggestion.weekNum}. Try checking individual city websites.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {suggestion.options.map((opt, idx) => {
                const accent = CITY_ACCENT[opt.camp.cityId] ?? "#555";
                const isTop = idx === 0;
                return (
                  <div key={opt.camp.id} style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: isTop ? "12px 14px" : "8px 14px",
                    background: isTop ? "var(--sb-card)" : "transparent",
                    border: isTop ? "1px solid var(--sb-border-light)" : "none",
                    borderLeft: isTop ? `3px solid ${accent}` : `2px solid var(--sb-border-light)`,
                    borderRadius: isTop ? "var(--sb-radius)" : 0,
                    marginLeft: isTop ? 0 : 4,
                  }}>
                    {isTop && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#15803d", background: "#f0fdf4", padding: "2px 5px", borderRadius: 3, whiteSpace: "nowrap" }}>
                        Best pick
                      </span>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: isTop ? 700 : 500, fontSize: isTop ? 14 : 13, color: "var(--sb-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {opt.camp.name}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--sb-muted)" }}>
                        {opt.camp.cityName} · Ages {opt.camp.ageMin}–{opt.camp.ageMax} · {opt.camp.hours}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: isTop ? 14 : 12, color: isTop ? "var(--sb-ink)" : "var(--sb-muted)" }}>
                        {opt.week.residentPrice !== null ? `$${opt.week.residentPrice}` : "Contact"}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--sb-muted)" }}>resident</div>
                    </div>
                    {isTop && (
                      <a
                        href={opt.camp.registerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          padding: "6px 12px",
                          background: accent,
                          color: "#fff",
                          fontSize: 11,
                          fontWeight: 700,
                          textDecoration: "none",
                          borderRadius: "var(--sb-radius)",
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                        }}
                      >
                        Register
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}

      {weeksWithNoCamps.length > 0 && (
        <div style={{
          padding: "12px 14px",
          background: "#fffbeb",
          border: "1px solid #fcd34d",
          borderRadius: "var(--sb-radius)",
          fontSize: 13,
          color: "#92400e",
          marginBottom: 16,
        }}>
          Some weeks have no matching camps in our database. Check individual city recreation sites for the latest listings.
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <button
          onClick={handleReset}
          style={{
            padding: "8px 16px",
            background: "none",
            border: "1px solid var(--sb-border)",
            borderRadius: "var(--sb-radius)",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--sb-muted)",
            cursor: "pointer",
          }}
        >
          Start over
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function CampsView() {
  const [mode, setMode] = useState<"browse" | "builder">("browse");

  return (
    <div className="camps-view">
      {/* Header */}
      <div className="dev-header">
        <div className="dev-header-eyebrow">South Bay / Summer 2026</div>
        <h1 className="dev-header-title">Summer Camps</h1>
        <p className="dev-header-subtitle">
          City recreation camps across the South Bay — compare options, check availability by week, and build a full-summer plan for your kids.
        </p>
        <div className="dev-header-note">
          Prices and availability from city recreation departments. Always verify at the city's website before registering.
        </div>
      </div>

      {/* Mode switcher */}
      <div style={{ display: "flex", gap: 4, marginBottom: 24 }}>
        <button
          onClick={() => setMode("browse")}
          style={{
            padding: "7px 18px",
            borderRadius: 100,
            border: "none",
            background: mode === "browse" ? "var(--sb-ink)" : "var(--sb-border-light)",
            color: mode === "browse" ? "#fff" : "var(--sb-muted)",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
            letterSpacing: "0.04em",
            transition: "all 0.15s",
          }}
        >
          Browse Camps
        </button>
        <button
          onClick={() => setMode("builder")}
          style={{
            padding: "7px 18px",
            borderRadius: 100,
            border: "none",
            background: mode === "builder" ? "var(--sb-ink)" : "var(--sb-border-light)",
            color: mode === "builder" ? "#fff" : "var(--sb-muted)",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
            letterSpacing: "0.04em",
            transition: "all 0.15s",
          }}
        >
          🏕️ Summer Builder
        </button>
      </div>

      {mode === "browse" ? <BrowseMode /> : <SummerBuilderMode />}

      {/* Footer disclaimer */}
      <div style={{
        marginTop: 32,
        padding: "12px 16px",
        background: "var(--sb-card)",
        border: "1px solid var(--sb-border-light)",
        borderRadius: "var(--sb-radius)",
        fontSize: 12,
        color: "var(--sb-muted)",
        lineHeight: 1.6,
      }}>
        <strong style={{ color: "var(--sb-ink)" }}>About this data:</strong> Camp listings are based on city recreation programs for Summer 2026. Prices for non-San Jose cities are approximate and should be verified directly with the city before registering. Availability changes quickly — check city websites for current enrollment status.
      </div>
    </div>
  );
}
