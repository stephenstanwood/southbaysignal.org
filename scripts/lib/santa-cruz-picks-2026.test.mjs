import assert from "node:assert/strict";
import test from "node:test";

import {
  BOARDWALK_2026_EVENTS,
  BOARDWALK_2026_SCHEDULE_URL,
  BOARDWALK_2026_SEASON_END,
} from "./santa-cruz-picks-2026.mjs";

test("Boardwalk 2026 picks cannot extend beyond the official summer season", () => {
  assert.match(BOARDWALK_2026_SCHEDULE_URL, /Summer-Entertainment-Schedule/i);
  assert.equal(BOARDWALK_2026_EVENTS.at(-1)?.date, BOARDWALK_2026_SEASON_END);
  assert.equal(
    BOARDWALK_2026_EVENTS.every((event) => event.date <= BOARDWALK_2026_SEASON_END),
    true,
  );
  assert.deepEqual(
    BOARDWALK_2026_EVENTS.filter((event) => ["2026-08-14", "2026-08-21"].includes(event.date)),
    [],
  );
});
