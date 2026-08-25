import { useState, useMemo } from "react";
import {
  CAMPS,
  SUMMER_WEEKS,
  SHORT_WEEK_NUM,
  DATA_VERIFIED_AT,
  type Camp,
  type CampType,
  type CampWeek,
} from "../../../data/south-bay/camps-data";
import PageHero from "../PageHero";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Drop summer weeks that have already ended so the week picker and planner
// never offer a week you can't attend. SignalApp is client:only, so this
// `new Date()` is the viewer's real clock — no SSR/hydration mismatch. Pin the
// date to Pacific anyway: the camps run here, and cityCamps.ts reads the same
// boundary off a PT-pinned TODAY_ISO, so an unpinned viewer clock could put
// the two out of step by a day.
// Once every week is past (summer's over) we fall back to the full set so the
// planner never renders an empty week list.
const TODAY_ISO = new Date().toLocaleDateString("en-CA", {
  timeZone: "America/Los_Angeles",
});
const UPCOMING_WEEKS = SUMMER_WEEKS.filter((w) => w.endDate >= TODAY_ISO);
const ACTIVE_WEEKS = UPCOMING_WEEKS.length > 0 ? UPCOMING_WEEKS : SUMMER_WEEKS;
// True while at least one summer week is still ahead. Once summer's fully over
// we stop hiding finished camps so the tab keeps showing the full lineup
// off-season (mirrors the ACTIVE_WEEKS fallback above).
const SEASON_ACTIVE = UPCOMING_WEEKS.length > 0;

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
  "multi":         "#1a1a1a",
};

const TYPE_FILTERS: { id: CampType | "all"; label: string }[] = [
  { id: "all",       label: "All"       },
  { id: "general",   label: "General"   },
  { id: "sports",    label: "Sports"    },
  { id: "arts",      label: "Arts"      },
  { id: "stem",      label: "STEM"      },
  { id: "nature",    label: "Nature"    },
  { id: "specialty", label: "Specialty" },
  { id: "academic",  label: "Academic"  },
];

const TYPE_COLORS: Record<CampType, string> = {
  general:   "#565f6e",
  sports:    "#1d4ed8",
  arts:      "#9333ea",
  stem:      "#0369a1",
  nature:    "#0f6b33",
  specialty: "#92400e",
  academic:  "#92400e",
};

const ALL_ORG_TYPES: { id: string; label: string }[] = [
  { id: "all",        label: "All"              },
  { id: "city",       label: "City Programs"    },
  { id: "nonprofit",  label: "Nonprofits"       },
  { id: "private",    label: "Private"          },
  { id: "university", label: "College Programs" },
];

const PRICE_TIERS: { id: string; label: string }[] = [
  { id: "all",     label: "All"             },
  { id: "budget",  label: "Budget (<$250)"  },
  { id: "mid",     label: "Mid ($250–$400)" },
  { id: "premium", label: "Premium ($400+)" },
];

const ALL_CITIES = Array.from(new Set(CAMPS.map((c) => c.cityId))).sort();

function getCityLabel(cityId: string): string {
  if (cityId === "multi") return "Multi-city";
  return CAMPS.find((c) => c.cityId === cityId)?.cityName ?? cityId;
}

// Camp has a given week number
function campHasWeek(camp: Camp, weekNum: number): boolean {
  return camp.weeks.some((w) => w.weekNum === weekNum);
}

// Camp still has at least one session a kid could attend. Camps with no dated
// weeks (year-round / undated programs) are always considered current.
function campHasUpcomingWeek(camp: Camp): boolean {
  if (camp.weeks.length === 0) return true;
  return camp.weeks.some((w) => w.endDate >= TODAY_ISO);
}

// Sessions a parent can still register for. During an active season the week
// picker and planner already hide finished weeks, so the card footer should
// match — count only upcoming weeks, not the all-time total. Once the season is
// over (no upcoming weeks) fall back to the full count so the card isn't blank.
function sessionCount(camp: Camp): number {
  const upcoming = camp.weeks.filter((w) => w.endDate >= TODAY_ISO).length;
  return upcoming > 0 ? upcoming : camp.weeks.length;
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

// Price tier helper
function priceTier(camp: Camp): "budget" | "mid" | "premium" {
  const prices = camp.weeks.map((w) => w.residentPrice).filter((p): p is number => p !== null);
  if (!prices.length) return "mid";
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  if (avg < 250) return "budget";
  if (avg <= 400) return "mid";
  return "premium";
}

// ---------------------------------------------------------------------------
// Camp card (Browse mode)
// ---------------------------------------------------------------------------

function CampCard({ camp }: { camp: Camp }) {
  const accent = CITY_ACCENT[camp.cityId] ?? "#555";
  const typeColor = TYPE_COLORS[camp.type];
  const usefulLocations = camp.locations.filter(
    (loc) => !loc.toLowerCase().startsWith("various")
  );
  const orgLabel = ALL_ORG_TYPES.find((o) => o.id === camp.orgType)?.label.replace(" Programs", "") ?? camp.orgType;
  const price = priceRange(camp);
  const locationLabel = usefulLocations.slice(0, 2).join(" · ");

  return (
    <article className="camps-card" style={{ borderTopColor: accent }}>
      <div className="camps-card-top">
        <span className="camps-card-city" style={{ color: accent, background: accent + "14" }}>
          {camp.cityName}
        </span>
        <span className="camps-card-type" style={{ color: typeColor, background: typeColor + "14" }}>
          {TYPE_FILTERS.find((t) => t.id === camp.type)?.label ?? camp.type}
        </span>
      </div>

      <h3 className="camps-card-title">{camp.name}</h3>
      <p className="camps-card-copy">{camp.description}</p>

      <dl className="camps-facts">
        <div>
          <dt>Ages</dt>
          <dd>{camp.ageMin}–{camp.ageMax}</dd>
        </div>
        <div>
          <dt>Weeks</dt>
          <dd>{weeksLabel(camp)}</dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd>{price}</dd>
        </div>
        <div>
          <dt>Hours</dt>
          <dd>{camp.hours}</dd>
        </div>
      </dl>

      <div className="camps-card-meta">
        <span>{orgLabel}</span>
        {locationLabel && <span>{locationLabel}</span>}
      </div>

      {camp.tags.length > 0 && (
        <div className="camps-card-tags">
          {camp.tags.slice(0, 4).map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      )}

      <div className="camps-card-footer">
        {camp.priceNote ? <span>{camp.priceNote}</span> : <span>{sessionCount(camp)} session{sessionCount(camp) !== 1 ? "s" : ""} listed</span>}
        <a
          href={camp.registerUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ background: accent }}
        >
          Register
        </a>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Browse mode
// ---------------------------------------------------------------------------

function BrowseMode() {
  const [cityFilter, setCityFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<CampType | "all">("all");
  const [orgTypeFilter, setOrgTypeFilter] = useState<string>("all");
  const [priceTierFilter, setPriceTierFilter] = useState<string>("all");
  const [ageFilter, setAgeFilter] = useState<string>("");
  const [weekFilter, setWeekFilter] = useState<number | "all">("all");
  const [query, setQuery] = useState<string>("");
  const [showAll, setShowAll] = useState(false);

  const featured = useMemo(
    () =>
      CAMPS.filter(
        (camp) => camp.featured && (!SEASON_ACTIVE || campHasUpcomingWeek(camp)),
      ).slice(0, 3),
    [],
  );
  const featuredIds = useMemo(() => new Set(featured.map((camp) => camp.id)), [featured]);

  const hasFilters =
    cityFilter !== "all" ||
    typeFilter !== "all" ||
    orgTypeFilter !== "all" ||
    priceTierFilter !== "all" ||
    ageFilter !== "" ||
    weekFilter !== "all" ||
    query.trim() !== "";

  const clearFilters = () => {
    setCityFilter("all");
    setTypeFilter("all");
    setOrgTypeFilter("all");
    setPriceTierFilter("all");
    setAgeFilter("");
    setWeekFilter("all");
    setQuery("");
    setShowAll(false);
  };

  const filtered = useMemo(() => {
    const age = ageFilter === "" ? null : parseInt(ageFilter);
    const q = query.trim().toLowerCase();
    const results = CAMPS.filter((camp) => {
      if (!hasFilters && featuredIds.has(camp.id)) return false;
      // Hide camps whose every session has already ended (until summer's over,
      // when we fall back to showing the full lineup).
      if (SEASON_ACTIVE && !campHasUpcomingWeek(camp)) return false;
      if (cityFilter !== "all" && camp.cityId !== cityFilter) return false;
      if (typeFilter !== "all" && camp.type !== typeFilter) return false;
      if (orgTypeFilter !== "all" && camp.orgType !== orgTypeFilter) return false;
      if (priceTierFilter !== "all" && priceTier(camp) !== priceTierFilter) return false;
      if (age !== null && Number.isFinite(age) && (camp.ageMin > age || camp.ageMax < age)) return false;
      if (weekFilter !== "all" && !campHasWeek(camp, weekFilter)) return false;
      if (q) {
        const haystack = [
          camp.name,
          camp.cityName,
          camp.description,
          camp.orgType,
          camp.type,
          ...camp.tags,
          ...camp.locations,
        ].join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    return [...results].sort((a, b) => {
      if (a.featured && !b.featured) return -1;
      if (!a.featured && b.featured) return 1;
      return a.cityName.localeCompare(b.cityName) || a.name.localeCompare(b.name);
    });
  }, [cityFilter, typeFilter, orgTypeFilter, priceTierFilter, ageFilter, weekFilter, query, hasFilters, featuredIds]);
  const visible = hasFilters || showAll ? filtered : filtered.slice(0, 10);
  const hiddenCount = filtered.length - visible.length;
  // Total of camps still browsable (excludes ones whose every session ended).
  const currentCampsCount = useMemo(
    () => CAMPS.filter((camp) => !SEASON_ACTIVE || campHasUpcomingWeek(camp)).length,
    [],
  );
  const shownTotal = hasFilters ? filtered.length : currentCampsCount;

  return (
    <div className="camps-directory">
      {featured.length > 0 && (
        <section className="camps-featured" aria-label="Featured camps">
          <div className="camps-section-head">
            <div>
              <div className="camps-kicker">Start Here</div>
              <h2>Strong first picks</h2>
            </div>
            <p>
              {SEASON_ACTIVE
                ? "Broad programs with clear dates, reliable registration links, and enough weeks to anchor a summer plan."
                : "Broad programs with clear dates and reliable registration links — the names to shortlist first when next summer's schedules go up."}
            </p>
          </div>
          <div className="camps-feature-grid">
            {featured.map((camp) => (
              <CampCard key={camp.id} camp={camp} />
            ))}
          </div>
        </section>
      )}

      <section className="camps-browse">
        <div className="camps-section-head">
          <div>
            <div className="camps-kicker">Directory</div>
            <h2>Browse the full camp list</h2>
          </div>
          <p>Use one or two filters when you need them. Otherwise the directory stays out of your way.</p>
        </div>

        <div className="camps-toolbar">
          <label className="camps-search">
            <span>Search</span>
            <input
              type="search"
              placeholder="Camp name, city, tag"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          <label>
            <span>City</span>
            <select value={cityFilter} onChange={(e) => setCityFilter(e.target.value)}>
              <option value="all">All cities</option>
              {ALL_CITIES.map((cityId) => (
                <option key={cityId} value={cityId}>{getCityLabel(cityId)}</option>
              ))}
            </select>
          </label>

          {SEASON_ACTIVE && (
            <label>
              <span>Week</span>
              <select
                value={weekFilter === "all" ? "all" : String(weekFilter)}
                onChange={(e) => setWeekFilter(e.target.value === "all" ? "all" : parseInt(e.target.value))}
              >
                <option value="all">All weeks</option>
                {ACTIVE_WEEKS.map((sw) => (
                  <option key={sw.weekNum} value={sw.weekNum}>
                    Week {sw.weekNum} · {sw.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label>
            <span>Age</span>
            <input
              type="number"
              min={4}
              max={17}
              placeholder="Any"
              value={ageFilter}
              onChange={(e) => setAgeFilter(e.target.value)}
            />
          </label>

          <label>
            <span>Focus</span>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as CampType | "all")}
            >
              {TYPE_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          </label>

          <label>
            <span>Operator</span>
            <select value={orgTypeFilter} onChange={(e) => setOrgTypeFilter(e.target.value)}>
              {ALL_ORG_TYPES.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          </label>

          <label>
            <span>Price</span>
            <select value={priceTierFilter} onChange={(e) => setPriceTierFilter(e.target.value)}>
              {PRICE_TIERS.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          </label>
        </div>

        {SEASON_ACTIVE && ACTIVE_WEEKS.some((w) => w.weekNum === SHORT_WEEK_NUM) && (
          <p style={{ fontSize: 12, color: "var(--sb-muted)", margin: "10px 0 0" }}>
            * Week {SHORT_WEEK_NUM} is a short week — no camp Fri Jul 3 (July 4th observed).
          </p>
        )}

        <div className="camps-results-head">
          <span>
            Showing {visible.length} of {shownTotal} program{shownTotal !== 1 ? "s" : ""}
          </span>
          {hasFilters && <button onClick={clearFilters}>Clear filters</button>}
        </div>

        {filtered.length === 0 ? (
          <div className="camps-empty">
            <h3>No camps match those filters</h3>
            <p>Try clearing one field or searching by city instead.</p>
          </div>
        ) : (
          <div className="camps-grid">
            {visible.map((camp) => (
              <CampCard key={camp.id} camp={camp} />
            ))}
          </div>
        )}
        {!hasFilters && hiddenCount > 0 && (
          <button className="camps-show-more" onClick={() => setShowAll(true)}>
            Show all {currentCampsCount} programs
          </button>
        )}
      </section>
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
  const [childAges, setChildAges] = useState<string[]>([""]);
  const [selectedWeeks, setSelectedWeeks] = useState<Set<number>>(new Set());

  const toggleWeek = (weekNum: number) => {
    setSelectedWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(weekNum)) next.delete(weekNum);
      else next.add(weekNum);
      return next;
    });
  };

  const addChild = () => setChildAges((prev) => [...prev, ""]);
  const updateChild = (idx: number, val: string) => {
    setChildAges((prev) => prev.map((v, i) => (i === idx ? val : v)));
  };
  const removeChild = (idx: number) => {
    setChildAges((prev) => prev.filter((_, i) => i !== idx));
  };

  const parsedAges = childAges
    .map((a) => (a !== "" ? parseInt(a) : null))
    .filter((a): a is number => a !== null && a >= 4 && a <= 17);

  const allAgesValid = parsedAges.length > 0 && parsedAges.length === childAges.filter((a) => a !== "").length;

  const suggestions = useMemo((): BuilderSuggestion[] => {
    if (parsedAges.length === 0) return [];
    const sorted = Array.from(selectedWeeks).sort((a, b) => a - b);
    return sorted.map((weekNum) => {
      // Camp must work for ALL entered ages
      const matchingCamps = CAMPS.filter((camp) =>
        parsedAges.every((age) => age >= camp.ageMin && age <= camp.ageMax) &&
        campHasWeek(camp, weekNum)
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
  }, [parsedAges.join(","), selectedWeeks]);

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

  // Mix-it-up suggestion: if 3+ weeks all same type, suggest mixing
  const mixItUpSuggestion = useMemo(() => {
    if (suggestedPlan.length < 3) return null;
    const types = suggestedPlan.map((item) => item.camp.type);
    const firstType = types[0];
    if (types.every((t) => t === firstType)) {
      const otherTypes: CampType[] = ["general", "sports", "arts", "stem", "nature", "specialty", "academic"];
      const alternatives = otherTypes.filter((t) => t !== firstType);
      const suggestion = alternatives[0];
      return { dominantType: firstType, suggestedType: suggestion };
    }
    return null;
  }, [suggestedPlan]);

  const handleReset = () => {
    setStep(1);
    setChildAges([""]);
    setSelectedWeeks(new Set());
  };

  // Step 1: Age(s)
  if (step === 1) {
    return (
      <div>
        <div style={{ maxWidth: 480, margin: "0 auto", textAlign: "center", padding: "32px 0 24px" }}>
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
            Tell us your children's ages and which weeks you need coverage, and we'll put together a suggested camp plan with estimated costs.
          </p>

          <div style={{ marginBottom: 24, textAlign: "left" }}>
            <label style={{
              display: "block",
              fontSize: 12,
              fontWeight: 700,
              color: "var(--sb-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 10,
            }}>
              Children's Ages
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
              {childAges.map((age, idx) => (
                <div key={idx} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="number"
                    min={4}
                    max={17}
                    placeholder="Age (4–17)"
                    value={age}
                    onChange={(e) => updateChild(idx, e.target.value)}
                    style={{
                      width: 130,
                      fontSize: 18,
                      fontWeight: 700,
                      textAlign: "center",
                      padding: "10px 12px",
                      border: "2px solid var(--sb-border)",
                      borderRadius: "var(--sb-radius)",
                      background: "var(--sb-card)",
                      color: "var(--sb-ink)",
                      fontFamily: "var(--sb-sans)",
                    }}
                  />
                  {childAges.length > 1 && (
                    <button
                      onClick={() => removeChild(idx)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--sb-muted)",
                        fontSize: 16,
                        padding: "4px 6px",
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={addChild}
                style={{
                  background: "none",
                  border: "1px dashed var(--sb-border)",
                  borderRadius: "var(--sb-radius)",
                  cursor: "pointer",
                  color: "var(--sb-muted)",
                  fontSize: 12,
                  padding: "6px 14px",
                  marginTop: 4,
                }}
              >
                + Add another child
              </button>
            </div>
            {parsedAges.length > 1 && (
              <div style={{ fontSize: 12, color: "var(--sb-muted)", marginTop: 8 }}>
                Will show camps that work for all {parsedAges.length} ages simultaneously.
              </div>
            )}
          </div>

          <button
            onClick={() => allAgesValid && setStep(2)}
            disabled={!allAgesValid}
            style={{
              padding: "10px 28px",
              background: allAgesValid ? "var(--sb-ink)" : "var(--sb-border)",
              color: allAgesValid ? "#fff" : "var(--sb-muted)",
              border: "none",
              borderRadius: "var(--sb-radius)",
              fontSize: 13,
              fontWeight: 700,
              cursor: allAgesValid ? "pointer" : "default",
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
    const ageLabel = parsedAges.length === 1
      ? `Age ${parsedAges[0]}`
      : `Ages ${parsedAges.join(", ")}`;

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
            <span style={{ fontSize: 12, color: "var(--sb-muted)" }}>{ageLabel}</span>
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
          <p style={{ fontSize: 13, color: "var(--sb-muted)", marginBottom: 16 }}>
            Select the weeks you need a camp for.
            {SEASON_ACTIVE && ACTIVE_WEEKS.some((w) => w.weekNum === SHORT_WEEK_NUM) &&
              ` Week ${SHORT_WEEK_NUM} is a short week (Fri Jul 3 is the observed July 4th holiday).`}
          </p>
          <button
            onClick={() => {
              const allNums = ACTIVE_WEEKS.map(sw => sw.weekNum);
              const allSelected = allNums.every(n => selectedWeeks.has(n));
              setSelectedWeeks(allSelected ? new Set() : new Set(allNums));
            }}
            style={{
              padding: "5px 14px",
              borderRadius: 100,
              border: "1px solid var(--sb-border)",
              background: ACTIVE_WEEKS.every(sw => selectedWeeks.has(sw.weekNum)) ? "var(--sb-ink)" : "transparent",
              color: ACTIVE_WEEKS.every(sw => selectedWeeks.has(sw.weekNum)) ? "#fff" : "var(--sb-muted)",
              fontSize: 11, fontWeight: 700, cursor: "pointer", marginBottom: 16,
            }}
          >
            {ACTIVE_WEEKS.every(sw => selectedWeeks.has(sw.weekNum)) ? "Clear all" : `Select all ${ACTIVE_WEEKS.length} weeks`}
          </button>
        </div>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
          gap: 8,
          marginBottom: 28,
        }}>
          {ACTIVE_WEEKS.map((sw) => {
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
  const ageLabel = parsedAges.length === 1
    ? `Age ${parsedAges[0]}`
    : `Ages ${parsedAges.join(", ")}`;

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
        <span style={{ fontSize: 12, color: "var(--sb-muted)", marginLeft: "auto" }}>{ageLabel}</span>
      </div>

      {/* Suggested plan summary */}
      {suggestedPlan.length > 0 && (
        <div style={{
          background: "#f0fdf4",
          border: "1px solid #86efac",
          borderLeft: "3px solid #15803d",
          borderRadius: "var(--sb-radius)",
          padding: "14px 16px",
          marginBottom: 16,
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
            Resident prices shown. Verify all prices at each program's website.
          </div>
        </div>
      )}

      {/* Mix it up suggestion */}
      {mixItUpSuggestion && (
        <div style={{
          background: "#fffbeb",
          border: "1px solid #fde68a",
          borderLeft: "3px solid #d97706",
          borderRadius: "var(--sb-radius)",
          padding: "10px 14px",
          marginBottom: 16,
          fontSize: 13,
          color: "#92400e",
        }}>
          💡 Your plan is all <strong>{mixItUpSuggestion.dominantType}</strong> camps — consider mixing in a <strong>{mixItUpSuggestion.suggestedType}</strong> week for variety.
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
              No camps found for {ageLabel} in week {suggestion.weekNum}. Try checking individual city websites.
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
  // The week-by-week planner only means anything while there are weeks left to
  // cover. Once the last 2026 session ends it would walk a parent through
  // picking expired weeks, so off-season the tab is the directory alone.
  const [mode, setMode] = useState<"browse" | "builder">("browse");
  const cityProgramCount = CAMPS.filter((camp) => camp.orgType === "city").length;
  const nonprofitCount = CAMPS.filter((camp) => camp.orgType === "nonprofit").length;

  const verifiedDisplay = new Date(DATA_VERIFIED_AT + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="camps-view">
      <PageHero
        eyebrow={SEASON_ACTIVE ? "South Bay / Summer 2026" : "South Bay / Planning Ahead"}
        title="Summer Camps"
        description={
          SEASON_ACTIVE
            ? "A calmer guide to city rec programs, specialty camps, sports academies, arts programs, and STEM weeks across the South Bay. Every listing links back to the operator's registration page."
            : "The 2026 season has wrapped, so this is the shortlist for next year: city rec programs, specialty camps, sports academies, arts programs, and STEM weeks across the South Bay. Every listing still links to the operator's own page, which is where new dates and registration go up first."
        }
        note={`Links verified ${verifiedDisplay}`}
        accent="#B45309"
        stats={[
          { value: CAMPS.length, label: "Programs" },
          { value: SUMMER_WEEKS.length, label: SEASON_ACTIVE ? "Summer weeks" : "Weeks in 2026" },
          { value: cityProgramCount, label: "City-run options" },
          { value: nonprofitCount, label: "Nonprofit options" },
        ]}
      />

      {SEASON_ACTIVE && (
        <div className="camps-mode-switch" role="tablist" aria-label="Camp view">
          <button
            id="camps-tab-browse"
            role="tab"
            onClick={() => setMode("browse")}
            className={mode === "browse" ? "is-active" : ""}
            aria-selected={mode === "browse"}
            aria-controls="camps-panel-browse"
          >
            Directory
          </button>
          <button
            id="camps-tab-builder"
            role="tab"
            onClick={() => setMode("builder")}
            className={mode === "builder" ? "is-active" : ""}
            aria-selected={mode === "builder"}
            aria-controls="camps-panel-builder"
          >
            Plan Weeks
          </button>
        </div>
      )}

      {!SEASON_ACTIVE || mode === "browse" ? (
        // Off-season there is no tablist above, so the panel is a plain region —
        // pointing aria-labelledby at a button that isn't rendered would leave
        // the directory unlabeled for screen readers.
        <div
          id="camps-panel-browse"
          role={SEASON_ACTIVE ? "tabpanel" : undefined}
          aria-labelledby={SEASON_ACTIVE ? "camps-tab-browse" : undefined}
        >
          <BrowseMode />
        </div>
      ) : (
        <section id="camps-panel-builder" role="tabpanel" aria-labelledby="camps-tab-builder" className="camps-builder-wrap">
          <SummerBuilderMode />
        </section>
      )}
      <CampsViewStyles />
    </div>
  );
}

function CampsViewStyles() {
  return (
    <style>{`
      .camps-view {
        display: flex;
        flex-direction: column;
        gap: 28px;
      }

      .camps-kicker {
        font-family: 'Space Mono', monospace;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--sb-muted);
      }

      .camps-hero {
        padding-bottom: 24px;
        border-bottom: 3px double var(--sb-border);
      }
      .camps-hero h1 {
        margin: 6px 0 10px;
        font-family: var(--sb-serif);
        font-size: 42px;
        line-height: 1;
        color: var(--sb-ink);
      }
      .camps-hero p {
        max-width: 720px;
        margin: 0;
        color: var(--sb-muted);
        font-size: 15px;
        line-height: 1.65;
      }
      .camps-hero-note {
        margin-top: 10px;
        color: var(--sb-light);
        font-size: 11px;
        letter-spacing: 0.03em;
      }
      .camps-stat-row {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        border: 1px solid var(--sb-border-light);
        margin-top: 22px;
        background: var(--sb-card);
      }
      .camps-stat-row > div {
        padding: 15px 16px;
        border-left: 1px solid var(--sb-border-light);
      }
      .camps-stat-row > div:first-child { border-left: none; }
      .camps-stat-row strong {
        display: block;
        font-family: var(--sb-serif);
        font-size: 28px;
        line-height: 1;
        color: var(--sb-ink);
      }
      .camps-stat-row span {
        display: block;
        margin-top: 5px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--sb-muted);
      }

      .camps-mode-switch {
        display: inline-flex;
        width: max-content;
        max-width: 100%;
        gap: 3px;
        padding: 3px;
        border: 1px solid var(--sb-border-light);
        background: var(--sb-card);
        border-radius: 999px;
      }
      .camps-mode-switch button {
        border: 0;
        border-radius: 999px;
        background: transparent;
        color: var(--sb-muted);
        cursor: pointer;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.05em;
        padding: 8px 18px;
        text-transform: uppercase;
      }
      .camps-mode-switch button.is-active {
        background: var(--sb-ink);
        color: #fff;
      }

      .camps-directory,
      .camps-featured,
      .camps-browse {
        display: flex;
        flex-direction: column;
        gap: 18px;
      }
      .camps-featured {
        padding-bottom: 28px;
        border-bottom: 1px solid var(--sb-border-light);
      }
      .camps-section-head {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(220px, 360px);
        gap: 24px;
        align-items: end;
      }
      .camps-section-head h2 {
        margin: 3px 0 0;
        font-family: var(--sb-serif);
        font-size: 26px;
        line-height: 1.1;
        color: var(--sb-ink);
      }
      .camps-section-head p {
        margin: 0;
        color: var(--sb-muted);
        font-size: 13px;
        line-height: 1.55;
      }

      .camps-feature-grid,
      .camps-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
      }
      .camps-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .camps-toolbar {
        display: grid;
        grid-template-columns: minmax(220px, 1.5fr) repeat(6, minmax(110px, 1fr));
        gap: 8px;
        align-items: end;
        padding: 12px;
        border: 1px solid var(--sb-border-light);
        background: rgba(255,255,255,0.55);
      }
      .camps-toolbar label {
        display: flex;
        flex-direction: column;
        gap: 5px;
        min-width: 0;
      }
      .camps-toolbar label > span {
        font-family: 'Space Mono', monospace;
        color: var(--sb-muted);
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .camps-toolbar input,
      .camps-toolbar select {
        width: 100%;
        min-width: 0;
        border: 1px solid var(--sb-border);
        border-radius: 6px;
        background: var(--sb-card);
        color: var(--sb-ink);
        font-family: var(--sb-sans);
        font-size: 12px;
        padding: 9px 10px;
      }

      .camps-results-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        color: var(--sb-muted);
        font-family: 'Space Mono', monospace;
        font-size: 11px;
      }
      .camps-results-head button {
        border: 1px solid var(--sb-border);
        border-radius: 999px;
        background: transparent;
        color: var(--sb-ink);
        cursor: pointer;
        font-size: 11px;
        font-weight: 700;
        padding: 5px 12px;
      }
      .camps-show-more {
        width: max-content;
        max-width: 100%;
        justify-self: center;
        align-self: center;
        border: 1px solid var(--sb-ink);
        border-radius: 999px;
        background: transparent;
        color: var(--sb-ink);
        cursor: pointer;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.05em;
        padding: 9px 18px;
        text-transform: uppercase;
      }

      .camps-card {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 0;
        background: var(--sb-card);
        border: 1px solid var(--sb-border-light);
        border-top: 3px solid var(--sb-ink);
        border-radius: 8px;
        padding: 17px;
      }
      .camps-card-top,
      .camps-card-meta,
      .camps-card-tags,
      .camps-card-footer {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
        align-items: center;
      }
      .camps-card-city,
      .camps-card-type,
      .camps-card-tags span {
        border-radius: 999px;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.05em;
        padding: 4px 8px;
        text-transform: uppercase;
      }
      .camps-card-tags span {
        border: 1px solid var(--sb-border-light);
        color: var(--sb-muted);
        font-weight: 600;
        text-transform: none;
        letter-spacing: 0;
      }
      .camps-card-title {
        margin: 0;
        font-family: var(--sb-serif);
        font-size: 20px;
        line-height: 1.15;
        color: var(--sb-ink);
      }
      .camps-card-copy {
        margin: 0;
        color: var(--sb-muted);
        font-size: 13px;
        line-height: 1.55;
      }
      .camps-facts {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1px;
        margin: 0;
        background: var(--sb-border-light);
        border: 1px solid var(--sb-border-light);
      }
      .camps-facts div {
        min-width: 0;
        background: var(--sb-bg);
        padding: 9px 10px;
      }
      .camps-facts dt {
        color: var(--sb-light);
        font-family: 'Space Mono', monospace;
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.07em;
        text-transform: uppercase;
      }
      .camps-facts dd {
        margin: 3px 0 0;
        color: var(--sb-ink);
        font-size: 12px;
        font-weight: 700;
        line-height: 1.35;
      }
      .camps-card-meta {
        color: var(--sb-muted);
        font-size: 11px;
        line-height: 1.4;
      }
      .camps-card-meta span + span::before {
        content: "";
        display: inline-block;
        width: 3px;
        height: 3px;
        margin: 0 6px 2px 0;
        border-radius: 999px;
        background: var(--sb-border);
      }
      .camps-card-footer {
        justify-content: space-between;
        gap: 10px;
        margin-top: auto;
        padding-top: 3px;
        color: var(--sb-light);
        font-size: 11px;
      }
      .camps-card-footer a {
        border-radius: 6px;
        color: #fff;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.04em;
        padding: 7px 12px;
        text-decoration: none;
        text-transform: uppercase;
      }

      .camps-empty,
      .camps-builder-wrap {
        border: 1px solid var(--sb-border-light);
        border-radius: 8px;
        background: var(--sb-card);
        padding: 24px;
      }
      .camps-empty h3 {
        margin: 0 0 4px;
        font-family: var(--sb-serif);
        font-size: 20px;
      }
      .camps-empty p {
        margin: 0;
        color: var(--sb-muted);
        font-size: 13px;
      }

      @media (max-width: 980px) {
        .camps-stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .camps-stat-row > div:nth-child(3) { border-left: none; border-top: 1px solid var(--sb-border-light); }
        .camps-stat-row > div:nth-child(4) { border-top: 1px solid var(--sb-border-light); }
        .camps-section-head { grid-template-columns: 1fr; gap: 8px; }
        .camps-feature-grid,
        .camps-grid { grid-template-columns: 1fr; }
        .camps-toolbar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .camps-search { grid-column: 1 / -1; }
      }

      @media (max-width: 560px) {
        .camps-hero h1 { font-size: 34px; }
        .camps-stat-row strong { font-size: 24px; }
        .camps-toolbar { grid-template-columns: 1fr; }
        .camps-mode-switch { width: 100%; }
        .camps-mode-switch button { flex: 1; padding-inline: 10px; }
        .camps-card { padding: 15px; }
      }
    `}</style>
  );
}
