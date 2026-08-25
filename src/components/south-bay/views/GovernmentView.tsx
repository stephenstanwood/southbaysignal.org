import { useState, useCallback, useMemo } from "react";
import type { DigestData } from "../cards/DigestCard";
import CouncilDigestTurnstile from "../cards/CouncilDigestTurnstile";
import MinutesSearchCard from "../cards/MinutesSearchCard";
import type { City } from "../../../lib/south-bay/types";
import { getCityName } from "../../../lib/south-bay/cities";
import digestsJson from "../../../data/south-bay/digests.json";
import upcomingMeetingsJson from "../../../data/south-bay/upcoming-meetings.json";
import PageHero from "../PageHero";

interface Props {
  selectedCities: Set<City>;
}

interface AgendaItem {
  title: string;
  sequence: number;
}

interface UpcomingMeeting {
  date: string;
  displayDate: string;
  /** 24-hour local "HH:MM" of the first block readers may attend, or null when
   * the portal posts no start time. */
  startTime?: string | null;
  /** Set when the entry's posted hour was a closed session and `startTime` had
   * to be moved past it (Sunnyvale opens most sittings this way). */
  closedSessionStart?: string | null;
  bodyName: string;
  location: string | null;
  /** Closed/non-televised sitting — nothing a resident can attend or watch. */
  closedSession?: boolean;
  url: string;
  agendaItems?: AgendaItem[];
}

const staticDigests = digestsJson as Record<string, DigestData>;
const upcomingMeetings = (upcomingMeetingsJson as { meetings: Record<string, UpcomingMeeting> }).meetings;

// ── Date helpers (Pacific Time) ─────────────────────────────────────────────

function todayPT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
}

function dayPill(iso: string, todayIso: string, tomorrowIso: string): string {
  if (iso === todayIso) return "TODAY";
  if (iso === tomorrowIso) return "TOMORROW";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
}

function meetingDateLabel(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function countMeetingsInWindow(selectedCities: Set<City>): number {
  const start = todayPT();
  const end = addDays(start, 7);
  return Object.entries(upcomingMeetings).filter(([cityId, meeting]) => {
    if (!meeting?.date) return false;
    if (!selectedCities.has(cityId as City)) return false;
    return meeting.date >= start && meeting.date <= end;
  }).length;
}

// ── This Week in Council ───────────────────────────────────────────────────
// Cross-city pulse of council meetings happening in the next 7 days. Helps
// residents see at a glance which meetings to watch or attend, without
// having to flip through the digest turnstile city by city.

interface WeekAheadRow {
  city: City;
  meeting: UpcomingMeeting;
}

function CouncilWeekAhead({ selectedCities }: { selectedCities: Set<City> }) {
  const todayIso = todayPT();
  const tomorrowIso = addDays(todayIso, 1);
  const horizonIso = addDays(todayIso, 7);

  const rows = useMemo<WeekAheadRow[]>(() => {
    const out: WeekAheadRow[] = [];
    for (const [cityId, meeting] of Object.entries(upcomingMeetings)) {
      if (!meeting?.date) continue;
      if (!selectedCities.has(cityId as City)) continue;
      if (meeting.date < todayIso || meeting.date > horizonIso) continue;
      out.push({ city: cityId as City, meeting });
    }
    out.sort((a, b) => {
      if (a.meeting.date !== b.meeting.date) return a.meeting.date.localeCompare(b.meeting.date);
      return getCityName(a.city).localeCompare(getCityName(b.city));
    });
    return out;
  }, [selectedCities, todayIso, horizonIso]);

  if (rows.length === 0) return null;

  return (
    <section style={{ marginBottom: 32 }}>
      <div className="sb-section-header" style={{ marginBottom: 4 }}>
        <span className="sb-section-title">This Week in Council</span>
      </div>
      <p className="gov-section-blurb">
        Council meetings happening in the next 7 days across {selectedCities.size === 1 ? "your city" : "your selected cities"} — tap a row to open the agenda.
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          background: "var(--sb-card)",
          border: "1px solid var(--sb-border-light)",
        }}
      >
        {rows.map(({ city, meeting }, i) => {
          const pill = dayPill(meeting.date, todayIso, tomorrowIso);
          const isUrgent = meeting.date === todayIso || meeting.date === tomorrowIso;
          const items = (meeting.agendaItems ?? []).slice(0, 2);
          return (
            <a
              key={`${city}-${meeting.date}-${meeting.url}`}
              href={meeting.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "grid",
                gridTemplateColumns: "72px 1fr",
                gap: 14,
                padding: "14px 16px",
                borderTop: i === 0 ? "none" : "1px solid var(--sb-border-light)",
                color: "var(--sb-ink)",
                textDecoration: "none",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--sb-accent-light, #fafafa)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                <span
                  style={{
                    display: "inline-block",
                    padding: "2px 8px",
                    background: isUrgent ? "var(--sb-ink)" : "transparent",
                    color: isUrgent ? "var(--sb-card)" : "var(--sb-ink)",
                    border: `1px solid ${isUrgent ? "var(--sb-ink)" : "var(--sb-border)"}`,
                    fontFamily: "'Space Mono', monospace",
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    borderRadius: 100,
                  }}
                >
                  {pill}
                </span>
                <span style={{ fontSize: 11, color: "var(--sb-muted)", marginTop: 4 }}>
                  {meetingDateLabel(meeting.date).split(",")[1]?.trim() ?? meeting.date}
                </span>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--sb-serif)", fontSize: 16, fontWeight: 700 }}>
                    {getCityName(city)}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--sb-light)",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      fontWeight: 600,
                    }}
                  >
                    {meeting.bodyName}
                  </span>
                </div>
                {items.length > 0 ? (
                  <ul
                    style={{
                      margin: "6px 0 0",
                      padding: 0,
                      listStyle: "none",
                      fontSize: 13,
                      lineHeight: 1.45,
                      color: "var(--sb-muted)",
                    }}
                  >
                    {items.map((item) => (
                      <li
                        key={item.sequence}
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        · {item.title}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div style={{ fontSize: 13, color: "var(--sb-light)", marginTop: 6 }}>
                    Agenda not yet posted — tap to check the city's calendar.
                  </div>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}

// Canonical city order in the turnstile when "all" are selected. San José leads
// (largest by population), then a rough north-to-south sweep.
const CITY_ORDER: City[] = [
  "san-jose",
  "santa-clara",
  "sunnyvale",
  "mountain-view",
  "palo-alto",
  "los-altos",
  "cupertino",
  "campbell",
  "saratoga",
  "los-gatos",
  "milpitas",
];

// Where "View agendas →" sends a resident when there's no specific next-meeting
// URL. Every entry below was fetched and confirmed to load; several used to
// point at hosts that had gone 404, stopped resolving, or frozen into an
// archive while still answering 200. Re-verify before editing.
const AGENDA_URLS: Record<string, string> = {
  // Campbell moved to eScribe in late 2025; the old Agenda Center is frozen at
  // 2025-10-07 and must not be linked as current.
  "campbell": "https://pub-campbell.escribemeetings.com/",
  "saratoga": "https://www.saratoga.ca.us/AgendaCenter/City-Council-13",
  // Los Altos moved to CivicClerk; losaltosca.gov/AgendaCenter now titles
  // itself "Archived Agenda Center" and stops at 2025-04-22.
  "los-altos": "https://losaltosca.portal.civicclerk.com/",
  // Los Gatos: municodemeetings.com is the only agenda source losgatosca.gov
  // links to. It refuses our automated requests, so we can't verify it the way
  // the others were verified — kept because it's the town's own published link.
  "los-gatos": "https://losgatos-ca.municodemeetings.com/",
  "san-jose": "https://sanjose.legistar.com/Calendar.aspx",
  "mountain-view": "https://mountainview.legistar.com/Calendar.aspx",
  "sunnyvale": "https://sunnyvale.legistar.com/Calendar.aspx",
  "cupertino": "https://cupertino.legistar.com/Calendar.aspx",
  "santa-clara": "https://santaclara.legistar.com/Calendar.aspx",
  // ci.milpitas.ca.gov no longer serves; the city is on milpitas.gov.
  "milpitas": "https://www.milpitas.gov/129/Agendas-Minutes",
  // cityofpaloalto.org/Government/City-Clerk/... 404s; this is the page the
  // city's own City Council page links to.
  "palo-alto": "https://www.paloalto.gov/City-Hall/City-Council/Council-Agendas-Minutes",
};

export default function GovernmentView({ selectedCities }: Props) {
  const [digests, setDigests] = useState<Map<string, DigestData>>(() => {
    const map = new Map<string, DigestData>();
    for (const [city, digest] of Object.entries(staticDigests)) {
      map.set(city, digest);
    }
    return map;
  });
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());

  const refreshDigest = useCallback(async (city: City) => {
    setLoading((prev) => new Set(prev).add(city));
    setErrors((prev) => {
      const next = new Map(prev);
      next.delete(city);
      return next;
    });
    try {
      const res = await fetch(`/api/south-bay/digest?city=${city}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? `Failed (${res.status})`);
      }
      const digest: DigestData = await res.json();
      setDigests((prev) => new Map(prev).set(city, digest));
    } catch (e) {
      setErrors((prev) =>
        new Map(prev).set(
          city,
          e instanceof Error ? e.message : "Failed to load",
        ),
      );
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(city);
        return next;
      });
    }
  }, []);

  // Show only cities we actually have a digest for. Stoa coverage gaps (e.g.
  // Los Altos, where the API has nothing in the City Council slot) shouldn't
  // result in an empty turnstile card.
  const orderedCities = useMemo(
    () => CITY_ORDER.filter((c) => selectedCities.has(c) && digests.has(c)),
    [selectedCities, digests],
  );
  const meetingCount = useMemo(
    () => countMeetingsInWindow(selectedCities),
    [selectedCities],
  );
  const selectedGovCityCount = useMemo(
    () => CITY_ORDER.filter((c) => selectedCities.has(c)).length,
    [selectedCities],
  );
  const missingDigestCount = Math.max(0, selectedGovCityCount - orderedCities.length);

  return (
    <div className="gov-view">
      <PageHero
        eyebrow="South Bay / Civic Desk"
        title="Local Government"
        description="Council meetings, searchable records, and plain-English summaries for the cities you follow. Built for quick civic context, not municipal scavenger hunts."
        accent="var(--sb-accent)"
        stats={[
          { value: meetingCount, label: "Meetings this week" },
          { value: orderedCities.length, label: "With digests" },
          { value: missingDigestCount, label: "Awaiting digest" },
        ]}
      />

      <section className="gov-section">
        <CouncilWeekAhead selectedCities={selectedCities} />
      </section>

      <section className="gov-section gov-records-section">
        <MinutesSearchCard selectedCities={selectedCities} />
      </section>

      <section className="gov-section">
        <div className="sb-section-header" style={{ marginBottom: 4 }}>
          <span className="sb-section-title">Council Digests</span>
        </div>
        <p className="gov-section-blurb">
          Recent council meetings in plain English: what was discussed, what was decided,
          and what is coming next.
        </p>
        <CouncilDigestTurnstile
          cities={orderedCities}
          digests={digests}
          upcomingMeetings={upcomingMeetings as Record<string, UpcomingMeeting | undefined>}
          agendaUrls={AGENDA_URLS}
          onRefresh={refreshDigest}
          loading={loading}
          errors={errors}
        />
      </section>

      <GovernmentViewStyles />
    </div>
  );
}

function GovernmentViewStyles() {
  return (
    <style>{`
      .gov-view {
        display: flex;
        flex-direction: column;
        gap: 30px;
      }
      .gov-kicker {
        color: var(--sb-muted);
        font-family: 'Space Mono', monospace;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .gov-hero {
        padding-bottom: 24px;
        border-bottom: 3px double var(--sb-border);
      }
      .gov-hero h1 {
        margin: 6px 0 10px;
        color: var(--sb-ink);
        font-family: var(--sb-serif);
        font-size: 42px;
        line-height: 1;
      }
      .gov-hero p {
        max-width: 700px;
        margin: 0;
        color: var(--sb-muted);
        font-size: 15px;
        line-height: 1.65;
      }
      .gov-stat-row {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        margin-top: 22px;
        border: 1px solid var(--sb-border-light);
        background: var(--sb-card);
      }
      .gov-stat-row > div {
        padding: 15px 16px;
        border-left: 1px solid var(--sb-border-light);
      }
      .gov-stat-row > div:first-child { border-left: none; }
      .gov-stat-row strong {
        display: block;
        color: var(--sb-ink);
        font-family: var(--sb-serif);
        font-size: 28px;
        line-height: 1;
      }
      .gov-stat-row span {
        display: block;
        margin-top: 5px;
        color: var(--sb-muted);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .gov-section {
        min-width: 0;
      }
      .gov-section > section {
        margin-bottom: 0 !important;
      }
      .gov-records-section > div {
        margin-bottom: 0 !important;
      }
      .gov-view .sb-section-title {
        font-size: 20px;
      }
      @media (max-width: 680px) {
        .gov-hero h1 { font-size: 34px; }
        .gov-stat-row { grid-template-columns: 1fr; }
        .gov-stat-row > div {
          border-left: none;
          border-top: 1px solid var(--sb-border-light);
        }
        .gov-stat-row > div:first-child { border-top: none; }
      }
    `}</style>
  );
}
