import { useState, useEffect, useCallback, useRef } from "react";
import type { ParsedGame, LeagueKey } from "../../../lib/south-bay/types";
import {
  SOUTH_BAY_TEAMS,
  LEAGUE_META,
  getEspnPaths,
  espnScoreboardRangeUrl,
  findSouthBayTeam,
  milbScheduleRangeUrl,
  REFRESH_MS,
} from "../../../lib/south-bay/teams";
import type { SouthBayTeam } from "../../../lib/south-bay/types";

// ── ESPN data parsing ──

function parseEspnGames(espnPath: string, data: unknown): ParsedGame[] {
  const events = (data as { events?: unknown[] })?.events ?? [];
  const games: ParsedGame[] = [];

  for (const event of events) {
    const e = event as {
      id?: string;
      date?: string;
      competitions?: Array<{
        competitors?: Array<{
          homeAway?: string;
          score?: string;
          team?: {
            abbreviation?: string;
            displayName?: string;
            logo?: string;
            color?: string;
          };
          records?: Array<{ summary?: string }>;
        }>;
        status?: {
          type?: { state?: string; detail?: string; shortDetail?: string };
        };
        geoBroadcasts?: Array<{
          market?: { type?: string };
          media?: { shortName?: string };
        }>;
      }>;
    };

    const comp = e.competitions?.[0];
    if (!comp?.competitors || comp.competitors.length < 2) continue;

    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    if (!home || !away) continue;

    const homeAbbr = home.team?.abbreviation ?? "";
    const awayAbbr = away.team?.abbreviation ?? "";
    const homeDisplay = home.team?.displayName ?? "";
    const awayDisplay = away.team?.displayName ?? "";

    const sbTeam =
      findSouthBayTeam(espnPath, homeAbbr, homeDisplay) ??
      findSouthBayTeam(espnPath, awayAbbr, awayDisplay);

    if (!sbTeam) continue;

    const leagueKey = sbTeam.league;
    const meta = LEAGUE_META[leagueKey];

    const state = comp.status?.type?.state ?? "pre";
    const broadcasts = (comp.geoBroadcasts ?? [])
      .filter((b) => b.market?.type === "National")
      .map((b) => b.media?.shortName)
      .filter(Boolean) as string[];

    const isSBHome =
      findSouthBayTeam(espnPath, homeAbbr, homeDisplay) != null;

    games.push({
      id: e.id ?? `${homeAbbr}-${awayAbbr}`,
      league: leagueKey,
      leagueLabel: meta?.label ?? leagueKey.toUpperCase(),
      homeTeam: home.team?.displayName ?? homeAbbr,
      awayTeam: away.team?.displayName ?? awayAbbr,
      homeLogo: home.team?.logo,
      awayLogo: away.team?.logo,
      homeAbbr,
      awayAbbr,
      homeScore: home.score != null ? Number(home.score) : undefined,
      awayScore: away.score != null ? Number(away.score) : undefined,
      homeRecord: home.records?.[0]?.summary,
      awayRecord: away.records?.[0]?.summary,
      homeColor: home.team?.color ? `#${home.team.color}` : "#888",
      awayColor: away.team?.color ? `#${away.team.color}` : "#888",
      status: state as "pre" | "in" | "post",
      statusDetail: comp.status?.type?.shortDetail ?? comp.status?.type?.detail ?? "",
      startTime: e.date ?? "",
      broadcasts,
      isSouthBayHome: isSBHome,
      southBayTeamKey: sbTeam.key,
    });
  }

  return games;
}

// ── MiLB Stats API parsing (San Jose Giants) ──

function parseMilbGames(data: unknown): ParsedGame[] {
  const dates = (data as { dates?: unknown[] })?.dates ?? [];
  const games: ParsedGame[] = [];
  const sjTeam = SOUTH_BAY_TEAMS.find((t) => t.key === "sj-giants");
  if (!sjTeam) return games;

  for (const dateEntry of dates) {
    const dayGames = (dateEntry as { games?: unknown[] })?.games ?? [];
    for (const g of dayGames) {
      const game = g as {
        gamePk?: number;
        gameDate?: string;
        status?: { detailedState?: string; abstractGameState?: string };
        teams?: {
          home?: {
            team?: { name?: string; abbreviation?: string };
            score?: number;
            leagueRecord?: { wins?: number; losses?: number };
          };
          away?: {
            team?: { name?: string; abbreviation?: string };
            score?: number;
            leagueRecord?: { wins?: number; losses?: number };
          };
        };
      };

      const home = game.teams?.home;
      const away = game.teams?.away;
      if (!home?.team || !away?.team) continue;

      const abstractState = game.status?.abstractGameState ?? "Preview";
      const status: "pre" | "in" | "post" =
        abstractState === "Live" ? "in" : abstractState === "Final" ? "post" : "pre";

      const homeRec = home.leagueRecord;
      const awayRec = away.leagueRecord;
      const isHome =
        home.team.abbreviation === "SJ" || (home.team.name?.includes("San Jose") ?? false);

      games.push({
        id: `milb-${game.gamePk ?? Math.random()}`,
        league: "milb",
        leagueLabel: "MiLB",
        homeTeam: home.team.name ?? "Home",
        awayTeam: away.team.name ?? "Away",
        homeAbbr: home.team.abbreviation ?? "",
        awayAbbr: away.team.abbreviation ?? "",
        homeScore: home.score,
        awayScore: away.score,
        homeRecord: homeRec ? `${homeRec.wins}-${homeRec.losses}` : undefined,
        awayRecord: awayRec ? `${awayRec.wins}-${awayRec.losses}` : undefined,
        homeColor: isHome ? sjTeam.color : "#888",
        awayColor: !isHome ? sjTeam.color : "#888",
        status,
        statusDetail: game.status?.detailedState ?? "",
        startTime: game.gameDate ?? "",
        broadcasts: [],
        isSouthBayHome: isHome,
        southBayTeamKey: "sj-giants",
      });
    }
  }

  return games;
}

// ── Mini game row (compact schedule style) ──

function formatShortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short", day: "numeric", timeZone: "America/Los_Angeles",
    });
  } catch { return ""; }
}

function formatGameTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Los_Angeles",
    });
  } catch { return ""; }
}

function MiniGameRow({ game }: { game: ParsedGame }) {
  const isLive = game.status === "in";
  const isFinal = game.status === "post";
  const sbHome = game.isSouthBayHome;

  const prefix = sbHome ? "vs" : "@";
  const oppAbbr = sbHome ? game.awayAbbr : game.homeAbbr;
  const opponent = `${prefix} ${oppAbbr}`;

  let result: React.ReactNode;
  if (isLive) {
    result = (
      <span style={{ color: "#ef4444", fontWeight: 700, fontSize: 11 }}>
        ● {game.statusDetail}
      </span>
    );
  } else if (isFinal) {
    const sbScore = sbHome ? game.homeScore : game.awayScore;
    const oppScore = sbHome ? game.awayScore : game.homeScore;
    const won = (sbScore ?? 0) > (oppScore ?? 0);
    result = (
      <span style={{ color: won ? "#16a34a" : "#dc2626", fontWeight: 700, fontSize: 11, fontFamily: "'Space Mono', monospace" }}>
        {won ? "W" : "L"} {sbScore}–{oppScore}
      </span>
    );
  } else {
    result = (
      <span style={{ color: "var(--sb-muted)", fontSize: 11, fontFamily: "'Space Mono', monospace" }}>
        {formatGameTime(game.startTime)}
      </span>
    );
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "5px 0",
      borderBottom: "1px solid var(--sb-border-light)",
      opacity: isFinal ? 0.72 : 1,
    }}>
      <span style={{ fontSize: 10, color: "var(--sb-muted)", minWidth: 46, flexShrink: 0, fontFamily: "'Space Mono', monospace" }}>
        {formatShortDate(game.startTime)}
      </span>
      <span style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--sb-ink)" }}>
        {opponent}
      </span>
      <span>{result}</span>
    </div>
  );
}

// ── Team schedule card ──

function TeamScheduleCard({ team, games }: { team: SouthBayTeam; games: ParsedGame[] }) {
  const todayMs = new Date().setHours(0, 0, 0, 0);

  // Split into past / live / future
  const live = games.filter((g) => g.status === "in");
  const past = games
    .filter((g) => g.status === "post" || (g.status !== "in" && new Date(g.startTime).getTime() < todayMs))
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    .slice(-2); // last 2 results
  const upcoming = games
    .filter((g) => g.status === "pre" && new Date(g.startTime).getTime() >= todayMs)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    .slice(0, 2); // next 2 games

  const displayed = [...past, ...live, ...upcoming];
  const leagueLabel = LEAGUE_META[team.league]?.label ?? team.league.toUpperCase();

  return (
    <div style={{
      background: "var(--sb-card)",
      border: "1px solid var(--sb-border-light)",
      borderRadius: "var(--sb-radius)",
      padding: "12px 14px",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* Team header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 8, paddingBottom: 7,
        borderBottom: `2px solid ${team.color}20`,
      }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: team.color, letterSpacing: "0.02em" }}>
          {team.shortName}
        </span>
        <span style={{ fontSize: 10, fontFamily: "'Space Mono', monospace", color: "var(--sb-muted)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          {leagueLabel}
        </span>
      </div>

      {displayed.length > 0 ? (
        displayed.map((g) => <MiniGameRow key={g.id} game={g} />)
      ) : (
        <div style={{ fontSize: 11, color: "var(--sb-muted)", fontStyle: "italic", padding: "6px 0" }}>
          No games in this window
        </div>
      )}
    </div>
  );
}

// ── Main component ──

export default function SportsView() {
  const [gamesByTeam, setGamesByTeam] = useState<Map<string, ParsedGame[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAllScores = useCallback(async () => {
    try {
      const paths = getEspnPaths();
      const results = await Promise.allSettled(
        paths.map(async (path) => {
          const res = await fetch(espnScoreboardRangeUrl(path, 7, 14));
          if (!res.ok) throw new Error(`ESPN ${path}: ${res.status}`);
          const data = await res.json();
          return parseEspnGames(path, data);
        }),
      );

      // MiLB (San Jose Giants) — date range
      let milbGames: ParsedGame[] = [];
      try {
        const milbRes = await fetch(milbScheduleRangeUrl());
        if (milbRes.ok) milbGames = parseMilbGames(await milbRes.json());
      } catch { /* best-effort */ }

      const allGames: ParsedGame[] = [...milbGames];
      for (const result of results) {
        if (result.status === "fulfilled") allGames.push(...result.value);
      }

      // Group by south bay team key
      const byTeam = new Map<string, ParsedGame[]>();
      for (const g of allGames) {
        const list = byTeam.get(g.southBayTeamKey) ?? [];
        list.push(g);
        byTeam.set(g.southBayTeamKey, list);
      }

      setGamesByTeam(byTeam);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load scores");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAllScores();
    intervalRef.current = setInterval(() => {
      if (!document.hidden) fetchAllScores();
    }, REFRESH_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchAllScores]);

  if (loading) {
    return (
      <div className="sb-loading">
        <div className="sb-spinner" />
        <div className="sb-loading-text">Loading scores...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="sb-empty">
        <div className="sb-empty-title">Could not load scores</div>
        <div className="sb-empty-sub">{error}</div>
        <button
          onClick={() => { setLoading(true); fetchAllScores(); }}
          style={{ marginTop: 12, padding: "8px 16px", background: "var(--sb-primary)", color: "white", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 }}
        >
          Retry
        </button>
      </div>
    );
  }

  // Split teams into South Bay local and broader Bay Area
  const localTeams = SOUTH_BAY_TEAMS.filter((t) => t.primary);
  const bayAreaTeams = SOUTH_BAY_TEAMS.filter((t) => !t.primary);

  const liveCount = [...gamesByTeam.values()].flat().filter((g) => g.status === "in").length;

  return (
    <>
      <div className="sb-section-header">
        <span className="sb-section-title">
          Scoreboard
          {liveCount > 0 && (
            <span style={{ color: "var(--sb-live)", marginLeft: 8 }}>
              {liveCount} live
            </span>
          )}
        </span>
        <div className="sb-section-line" />
      </div>

      {/* South Bay local teams */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--sb-muted)", marginBottom: 10 }}>
          South Bay
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
          {localTeams.map((team) => (
            <TeamScheduleCard
              key={team.key}
              team={team}
              games={gamesByTeam.get(team.key) ?? []}
            />
          ))}
        </div>
      </div>

      {/* Bay Area teams */}
      <div style={{ marginBottom: 8, marginTop: 20 }}>
        <div style={{ fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono', monospace", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--sb-muted)", marginBottom: 10 }}>
          Bay Area
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
          {bayAreaTeams.map((team) => (
            <TeamScheduleCard
              key={team.key}
              team={team}
              games={gamesByTeam.get(team.key) ?? []}
            />
          ))}
        </div>
      </div>
    </>
  );
}
