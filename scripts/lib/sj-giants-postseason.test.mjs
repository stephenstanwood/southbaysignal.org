import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSJGiantsSchedule } from "../generate-events.mjs";

// The adapter asked StatsAPI for `gameType=R` only, so the San Jose Giants
// postseason never reached the calendar. On 2026-09-01 that cost the site the
// two best baseball dates of the year: the Giants had clinched the California
// League North first half (standings API, firstHalf, 37–29, `clinched: true`)
// and were awarded home Division Series games at Excite Ballpark on Sep 10 and
// Sep 11, while the only regular-season games left were six road games in
// Fresno. The source reported "empty" for the whole month and a resident saw
// nothing.
//
// Two things make postseason rows different from regular-season rows, and both
// are represented below exactly as the live API returned them:
//
//   1. The undecided side is the placeholder franchise "To Be Determined"
//      (team id 41), which matches no California League market — so the
//      Copa-promo guard that keeps "Ontario Tower Buzzers" out would also
//      throw away a real home playoff date.
//   2. A slot the league hasn't timed yet carries a filler timestamp flagged
//      by `status.startTimeTBD` — the Sep 8 road game reads 10:33 UTC, i.e.
//      3:33 a.m. PT. Rendering that is a fabricated clock time.

function apiTeam(id, name, extra = {}) {
  // The schedule endpoint returns a bare {id, name, link} team object —
  // `locationName` and `teamName` are absent unless you hydrate.
  return { team: { id, name, link: `/api/v1/teams/${id}`, ...extra } };
}

const SJ = () => apiTeam(476, "San Jose Giants");
const TBD = () => apiTeam(41, "To Be Determined");
const FRESNO = () => apiTeam(259, "Fresno Grizzlies");

function schedule(dates) {
  return { dates };
}

async function runWith(payload) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    return { events: await fetchSJGiantsSchedule(), requests: seen };
  } finally {
    globalThis.fetch = original;
  }
}

test("the schedule request asks for the postseason, not just the regular season", async () => {
  const { requests } = await runWith(schedule([]));
  assert.equal(requests.length, 1);
  const url = requests[0];
  // F/D/L/W are the StatsAPI postseason codes. Requesting `gameType=R` alone
  // is what hid the 2026 Division Series.
  assert.match(url, /gameType=R,F,D,L,W/);
  for (const code of ["F", "D", "L", "W"]) {
    assert.ok(url.includes(code), `expected postseason code ${code} in ${url}`);
  }
  // A Sep 30 end date drops a championship round that runs into October.
  assert.match(url, /endDate=\d{4}-10-05/);
});

test("a home Division Series game survives the undecided opponent", async () => {
  const { events } = await runWith(
    schedule([
      {
        date: "2026-09-10",
        games: [
          {
            gamePk: 850956,
            gameDate: "2026-09-11T01:30:00Z", // 6:30 PM PT on Sep 10
            gameType: "L",
            seriesDescription: "CAL Division Series",
            status: { startTimeTBD: false, detailedState: "Scheduled" },
            venue: { id: 2815, name: "Excite Ballpark" },
            teams: { away: TBD(), home: SJ() },
          },
        ],
      },
    ]),
  );

  assert.equal(events.length, 1, "the playoff game must not be filtered out");
  const [game] = events;
  assert.equal(game.date, "2026-09-10");
  assert.equal(game.venue, "Excite Ballpark");
  assert.equal(game.city, "san-jose");
  assert.equal(game.category, "sports");
  // Real published start, in Pacific.
  assert.equal(game.time, "6:30 PM");
  // The abbreviation gets spelled out; no phantom opponent is invented.
  assert.equal(game.title, "San Jose Giants — California League Division Series");
  assert.doesNotMatch(game.title, /to be determined/i);
  assert.doesNotMatch(game.description, /to be determined/i);
  assert.match(game.description, /California League Division Series/);
  // Playoff pricing is set per series and isn't published on this endpoint.
  assert.equal(game.costNote, null);
  assert.equal(game.cost, "paid");
});

test("a postseason slot the league hasn't timed publishes no clock time", async () => {
  const { events } = await runWith(
    schedule([
      {
        date: "2026-09-09",
        games: [
          {
            gamePk: 850957,
            // The filler stamp: 10:33 UTC is 3:33 a.m. PT, a time no ballpark
            // has ever hosted a game at.
            gameDate: "2026-09-09T10:33:00Z",
            gameType: "L",
            seriesDescription: "CAL Division Series",
            status: { startTimeTBD: true, detailedState: "Scheduled" },
            venue: { id: 2815, name: "Excite Ballpark" },
            teams: { away: TBD(), home: SJ() },
          },
        ],
      },
    ]),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].time, null, "must not publish the 3:33 a.m. filler stamp");
  assert.equal(events[0].endTime, null);
  assert.equal(events[0].date, "2026-09-09");
});

test("a resolved postseason opponent is named", async () => {
  const { events } = await runWith(
    schedule([
      {
        date: "2026-09-11",
        games: [
          {
            gamePk: 850946,
            gameDate: "2026-09-12T01:30:00Z",
            gameType: "L",
            seriesDescription: "CAL Division Series",
            status: { startTimeTBD: false },
            venue: { id: 2815, name: "Excite Ballpark" },
            teams: { away: FRESNO(), home: SJ() },
          },
        ],
      },
    ]),
  );

  assert.equal(events.length, 1);
  assert.equal(
    events[0].title,
    "San Jose Giants vs. Fresno Grizzlies — California League Division Series",
  );
  assert.match(events[0].description, /Opponent: Fresno Grizzlies\./);
});

test("road playoff games and out-of-league promo identities still drop", async () => {
  const { events } = await runWith(
    schedule([
      {
        // Sep 8: San Jose is the away side at the other qualifier's park.
        date: "2026-09-08",
        games: [
          {
            gamePk: 850958,
            gameDate: "2026-09-08T10:33:00Z",
            gameType: "L",
            seriesDescription: "CAL Division Series",
            status: { startTimeTBD: true },
            venue: { id: 401, name: "TBD" },
            teams: { away: SJ(), home: TBD() },
          },
        ],
      },
      {
        // A Copa de la Diversión promo identity is not a California League
        // market — the original guard exists for this and must still hold.
        date: "2026-09-09",
        games: [
          {
            gamePk: 999999,
            gameDate: "2026-09-10T02:00:00Z",
            gameType: "R",
            seriesDescription: "Regular Season",
            status: { startTimeTBD: false },
            venue: { id: 2815, name: "Excite Ballpark" },
            teams: { away: apiTeam(9999, "Ontario Tower Buzzers"), home: SJ() },
          },
        ],
      },
      {
        // A placeholder opponent in the regular season is bad data, not a
        // bracket that hasn't filled in.
        date: "2026-09-12",
        games: [
          {
            gamePk: 999998,
            gameDate: "2026-09-13T02:00:00Z",
            gameType: "R",
            seriesDescription: "Regular Season",
            status: { startTimeTBD: false },
            venue: { id: 2815, name: "Excite Ballpark" },
            teams: { away: TBD(), home: SJ() },
          },
        ],
      },
    ]),
  );

  assert.deepEqual(events, []);
});

test("a regular-season home game is unchanged", async () => {
  const { events } = await runWith(
    schedule([
      {
        date: "2026-08-20",
        games: [
          {
            gamePk: 800001,
            gameDate: "2026-08-21T02:00:00Z", // 7:00 PM PT
            gameType: "R",
            seriesDescription: "Regular Season",
            status: { startTimeTBD: false },
            venue: { id: 2815, name: "Excite Ballpark" },
            teams: { away: apiTeam(478, "Visalia Rawhide"), home: SJ() },
          },
        ],
      },
    ]),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].title, "San Jose Giants vs. Visalia Rawhide");
  assert.equal(events[0].costNote, "From $14");
  assert.equal(
    events[0].description,
    "San Jose Giants home game vs. Visalia Rawhide at Excite Ballpark.",
  );
});
