/**
 * Vercel serverless function — proxies HockeyTech AHL scorebar for Barracuda.
 * HockeyTech blocks browser CORS, so we relay through this edge function.
 *
 * GET /api/ahl-scores?days_back=4&days_forward=4
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

const HOCKEYTECH_BASE =
  "https://lscluster.hockeytech.com/feed/index.php";
const AHL_KEY = "50c2cd9b5e18e390";
const BARRACUDA_ID = "405";
const SEASON_ID = "81"; // 2025-26

interface HTGame {
  ID: string;
  Date: string;
  GameDate: string;
  GameDateISO8601: string;
  ScheduledFormattedTime: string;
  HomeID: string;
  HomeCity: string;
  HomeNickname: string;
  HomeLongName: string;
  HomeGoals: string;
  HomeCode: string;
  VisitorID: string;
  VisitorCity: string;
  VisitorNickname: string;
  VisitorLongName: string;
  VisitorGoals: string;
  VisitorCode: string;
  GameStatus: string; // "1" = scheduled, "2" = in progress, "3" = final, "4" = final OT
}

function fmtDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const daysBack = Math.min(Number(req.query.days_back) || 4, 14);
  const daysForward = Math.min(Number(req.query.days_forward) || 4, 14);

  // HockeyTech returns ~1 week of games around the given date.
  // We request the midpoint to cover our range.
  const now = new Date();
  const centerDate = fmtDate(now);

  const url = new URL(HOCKEYTECH_BASE);
  url.searchParams.set("feed", "modulekit");
  url.searchParams.set("view", "scorebar");
  url.searchParams.set("key", AHL_KEY);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("client_code", "ahl");
  url.searchParams.set("lang", "en");
  url.searchParams.set("season_id", SEASON_ID);
  url.searchParams.set("date", centerDate);

  try {
    const htRes = await fetch(url.toString());
    if (!htRes.ok) {
      res.status(502).json({ error: `HockeyTech returned ${htRes.status}` });
      return;
    }

    let text = await htRes.text();
    // Strip JSONP wrapper if present
    text = text.replace(/^\(/, "").replace(/\)$/, "");
    const data = JSON.parse(text);

    const allGames: HTGame[] =
      data?.SiteKit?.Scorebar ?? [];

    // Filter to Barracuda games within our date range
    const minDate = fmtDate(new Date(now.getTime() - daysBack * 86400000));
    const maxDate = fmtDate(new Date(now.getTime() + daysForward * 86400000));

    const games = allGames
      .filter(
        (g) =>
          (g.HomeID === BARRACUDA_ID || g.VisitorID === BARRACUDA_ID) &&
          g.Date >= minDate &&
          g.Date <= maxDate,
      )
      .map((g) => ({
        id: g.ID,
        date: g.Date,
        gameDate: g.GameDate,
        startTime: g.ScheduledFormattedTime,
        isoTime: g.GameDateISO8601,
        homeTeam: g.HomeLongName,
        homeAbbr: g.HomeCode,
        homeGoals: parseInt(g.HomeGoals) || 0,
        awayTeam: g.VisitorLongName,
        awayAbbr: g.VisitorCode,
        awayGoals: parseInt(g.VisitorGoals) || 0,
        // 1=scheduled, 2=in progress, 3=final, 4=final OT/SO
        status:
          g.GameStatus === "2"
            ? "in"
            : g.GameStatus === "3" || g.GameStatus === "4"
              ? "post"
              : "pre",
        statusDetail:
          g.GameStatus === "4"
            ? "Final/OT"
            : g.GameStatus === "3"
              ? "Final"
              : g.GameStatus === "2"
                ? "In Progress"
                : g.ScheduledFormattedTime,
        isSouthBayHome: g.HomeID === BARRACUDA_ID,
      }));

    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
    res.status(200).json({ games });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
