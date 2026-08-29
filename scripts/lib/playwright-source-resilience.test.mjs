import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeUnexpectedEmptyRetry,
  findUnexpectedEmptyRetries,
} from "./playwright-source-resilience.mjs";

const PREVIOUS = {
  _meta: {
    sourceHealth: [
      { id: "san-jose-jazz", sources: ["San Jose Jazz"] },
      { id: "history-san-jose", sources: ["History San Jose"] },
      { id: "ica-san-jose", sources: ["ICA San José"] },
      { id: "post-peninsula-open-space-trust", sources: ["Peninsula Open Space Trust"] },
      { id: "sj-museum-of-art", sources: ["San Jose Museum of Art"] },
      { id: "childrens-discovery-museum", sources: ["Children's Discovery Museum"] },
    ],
  },
  events: [
    { source: "San Jose Jazz", date: "2026-09-04" },
    { source: "San Jose Jazz", date: "2026-09-05" },
    { source: "History San Jose", date: "2026-11-07" },
    { source: "ICA San José", date: "2026-10-02" },
    { source: "Peninsula Open Space Trust", date: "2026-09-26" },
    { source: "San Jose Museum of Art", date: "2026-09-06" },
    { source: "Children's Discovery Museum", date: "2026-08-28" },
  ],
};

test("retries only silent empties that would erase still-future source coverage", () => {
  const tasks = [
    { name: "San Jose Jazz" },
    { name: "History San Jose" },
    { name: "ICA San Jose" },
    { name: "POST (Peninsula Open Space Trust)" },
    { name: "SJ Museum of Art" },
    { name: "Children's Discovery Museum" },
    { name: "Never Contributed" },
  ];
  const results = [
    { events: [], error: null },
    { events: [], error: null },
    { events: [], error: null },
    { events: [], error: null },
    { events: [], error: "page.goto timed out" },
    { events: [], error: null },
    { events: [], error: null },
  ];

  assert.deepEqual(findUnexpectedEmptyRetries({
    tasks,
    results,
    previous: PREVIOUS,
    today: "2026-08-29",
  }), [
    {
      index: 0,
      name: "San Jose Jazz",
      knownSources: ["San Jose Jazz"],
      previousFutureEventCount: 2,
    },
    {
      index: 1,
      name: "History San Jose",
      knownSources: ["History San Jose"],
      previousFutureEventCount: 1,
    },
    {
      index: 2,
      name: "ICA San Jose",
      knownSources: ["ICA San José"],
      previousFutureEventCount: 1,
    },
    {
      index: 3,
      name: "POST (Peninsula Open Space Trust)",
      knownSources: ["Peninsula Open Space Trust"],
      previousFutureEventCount: 1,
    },
  ]);
});

test("a successful retry replaces the silent empty without degradation", () => {
  const retry = { events: [{ source: "San Jose Jazz", date: "2026-09-04" }], error: null };
  assert.equal(finalizeUnexpectedEmptyRetry(retry, {
    knownSources: ["San Jose Jazz"],
    previousFutureEventCount: 2,
  }), retry);
});

test("a second silent empty becomes an explicit error eligible for bounded carry-forward", () => {
  const result = finalizeUnexpectedEmptyRetry({ events: [], error: null }, {
    knownSources: ["San Jose Jazz"],
    previousFutureEventCount: 2,
  });
  assert.deepEqual(result.events, []);
  assert.match(result.error, /unexpected empty result after retry/);
  assert.match(result.error, /2 future event\(s\) from San Jose Jazz/);
});

test("a thrown retry error remains the recorded failure", () => {
  const retry = { events: [], error: "page.goto timed out" };
  assert.equal(finalizeUnexpectedEmptyRetry(retry, {
    knownSources: ["San Jose Jazz"],
    previousFutureEventCount: 2,
  }), retry);
});
