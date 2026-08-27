import assert from "node:assert/strict";
import test from "node:test";

import {
  auditDigestFreshness,
  daysBetween,
  formatFreshnessAlert,
  MAX_CARRY_FORWARD_RUNS,
  MAX_DIGEST_AGE_DAYS,
} from "./digest-staleness.mjs";

const TODAY = "2026-08-27";
const CITIES = [
  { city: "campbell", cityName: "Campbell" },
  { city: "san-jose", cityName: "San José" },
];

function digest(overrides = {}) {
  return {
    city: "san-jose",
    cityName: "San José",
    meetingDateIso: "2026-08-25",
    summary: "…",
    ...overrides,
  };
}

test("daysBetween counts calendar days and rejects junk", () => {
  assert.equal(daysBetween("2026-08-25", "2026-08-27"), 2);
  assert.equal(daysBetween("2026-07-07", "2026-08-27"), 51);
  assert.equal(daysBetween("2026-08-27", "2026-08-27"), 0);
  assert.equal(daysBetween(undefined, TODAY), null);
  assert.equal(daysBetween("July 7, 2026", TODAY), null, "display dates are not ISO dates");
});

test("daysBetween is not thrown off by a DST boundary", () => {
  // Nov 1 2026 is the fall-back Sunday; a naive local-midnight subtraction
  // yields 30.04 days and rounds fine, but 24h-based flooring would say 30.
  assert.equal(daysBetween("2026-10-25", "2026-11-24"), 30);
});

test("a fresh digest for every city raises nothing", () => {
  const { alerts, ok } = auditDigestFreshness({
    cities: CITIES,
    today: TODAY,
    digests: {
      campbell: digest({ city: "campbell", meetingDateIso: "2026-08-18" }),
      "san-jose": digest(),
    },
  });
  assert.deepEqual(alerts, []);
  assert.equal(ok, true);
});

// The actual Campbell failure: summarize threw on most nights but succeeded on
// some, so the carry-forward streak kept resetting to zero while the published
// meeting stayed on July 7. Only the age check catches this.
test("a source that stopped advancing is caught even when the run succeeded", () => {
  const { alerts } = auditDigestFreshness({
    cities: CITIES,
    today: TODAY,
    digests: {
      campbell: digest({ city: "campbell", meetingDateIso: "2026-07-07" }),
      "san-jose": digest(),
    },
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].city, "campbell");
  assert.equal(alerts[0].kind, "stale");
  assert.equal(alerts[0].ageDays, 51);
  assert.match(alerts[0].detail, /source is not advancing/);
});

test("a stale carried-forward digest names the carry-forward reason", () => {
  const { alerts } = auditDigestFreshness({
    cities: CITIES,
    today: TODAY,
    digests: {
      campbell: digest({
        city: "campbell",
        meetingDateIso: "2026-07-07",
        carriedForward: true,
        carryForwardReason: "summarize-failed",
        carriedForwardRuns: 2,
      }),
      "san-jose": digest(),
    },
  });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].detail, /carried forward, summarize-failed/);
});

test("a carry-forward streak fires before the age floor is reached", () => {
  const { alerts } = auditDigestFreshness({
    cities: CITIES,
    today: TODAY,
    digests: {
      campbell: digest({
        city: "campbell",
        meetingDateIso: "2026-08-18", // only 9 days old — not stale yet
        carriedForward: true,
        carryForwardReason: "no-source-meeting",
        carriedForwardRuns: MAX_CARRY_FORWARD_RUNS,
      }),
      "san-jose": digest(),
    },
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "carry-forward-streak");
  assert.equal(alerts[0].runs, MAX_CARRY_FORWARD_RUNS);
});

test("one bad night is not an alert", () => {
  const { ok } = auditDigestFreshness({
    cities: CITIES,
    today: TODAY,
    digests: {
      campbell: digest({
        city: "campbell",
        meetingDateIso: "2026-08-18",
        carriedForward: true,
        carryForwardReason: "summarize-failed",
        carriedForwardRuns: 1,
      }),
      "san-jose": digest(),
    },
  });
  assert.equal(ok, true);
});

test("a city with no card at all is reported", () => {
  const { alerts } = auditDigestFreshness({
    cities: CITIES,
    today: TODAY,
    digests: { "san-jose": digest() },
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "missing");
  assert.equal(alerts[0].city, "campbell");
});

test("a digest with an unusable meeting date is reported rather than skipped", () => {
  const { alerts } = auditDigestFreshness({
    cities: CITIES,
    today: TODAY,
    digests: {
      campbell: digest({ city: "campbell", meetingDateIso: undefined }),
      "san-jose": digest(),
    },
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "undated");
});

test("the age floor is exclusive at the boundary", () => {
  const at = auditDigestFreshness({
    cities: [CITIES[0]],
    today: TODAY,
    digests: { campbell: digest({ city: "campbell", meetingDateIso: "2026-07-23" }) },
  });
  assert.equal(daysBetween("2026-07-23", TODAY), MAX_DIGEST_AGE_DAYS);
  assert.equal(at.ok, true, "exactly at the floor is still fine");

  const past = auditDigestFreshness({
    cities: [CITIES[0]],
    today: TODAY,
    digests: { campbell: digest({ city: "campbell", meetingDateIso: "2026-07-22" }) },
  });
  assert.equal(past.alerts[0].kind, "stale");
});

test("alerts are ordered worst-first so the DM leads with the worst city", () => {
  const { alerts } = auditDigestFreshness({
    cities: [
      { city: "campbell", cityName: "Campbell" },
      { city: "los-altos", cityName: "Los Altos" },
      { city: "saratoga", cityName: "Saratoga" },
    ],
    today: TODAY,
    digests: {
      campbell: digest({
        city: "campbell",
        meetingDateIso: "2026-08-18",
        carriedForward: true,
        carriedForwardRuns: 9,
      }),
      saratoga: digest({ city: "saratoga", meetingDateIso: "2026-06-03" }),
    },
  });
  assert.deepEqual(alerts.map((a) => a.kind), ["missing", "stale", "carry-forward-streak"]);
});

test("formatFreshnessAlert renders one bullet per city", () => {
  const body = formatFreshnessAlert([
    { cityName: "Campbell", detail: "published meeting is 51 days old" },
    { cityName: "Saratoga", detail: "published meeting is 85 days old" },
  ]);
  assert.equal(
    body,
    "• **Campbell** — published meeting is 51 days old\n• **Saratoga** — published meeting is 85 days old",
  );
});
