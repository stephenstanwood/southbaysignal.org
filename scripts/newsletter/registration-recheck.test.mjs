import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  biblioEventRef,
  recheckRegistrationGatedEvents,
} from "./registration-recheck.mjs";

// ---------------------------------------------------------------------------
// Live registration re-check — the layer that would have caught the sent
// Sept 1 2026 issue's "Intro to Ukulele for Adults · Reserve ahead" listing.
// Fixtures mirror the live API shapes sampled that morning.
// ---------------------------------------------------------------------------

/** The feed listing exactly as the Sept 1 issue selected it. */
function ukuleleListing() {
  return {
    id: "sjpl-6a7a2993b44674e2601d024d",
    title: "Intro to Ukulele for Adults",
    date: "2026-09-01",
    time: "5:15 PM",
    registration: "required",
    url: "https://sjpl.bibliocommons.com/events/6a7a2993b44674e2601d024d",
  };
}

/** The live gateway record for that instance: flags false, window ended. */
function ukuleleGatewayRecord({ isFull = false, registrationClosed = false, isCancelled = false, provider = "BIBLIO_EVENTS", cap = 10 } = {}) {
  return {
    id: "6a7a2993b44674e2601d024d",
    isFull,
    registrationClosed,
    numberRegistered: 8,
    definition: {
      title: "Intro to Ukulele for Adults",
      isCancelled,
      registrationInfo: { provider, cap, maxSeats: 1 },
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/**
 * fetchImpl stub: routes gateway and windows URLs to canned bodies and
 * records every request so tests can assert batching and short-circuits.
 */
function stubFetch({ gateway = {}, windows = {} } = {}) {
  const calls = [];
  const impl = async (url) => {
    const u = String(url);
    calls.push(u);
    const gw = /gateway\.bibliocommons\.com\/v2\/libraries\/([a-z]+)\/events\?ids=/.exec(u);
    if (gw) {
      const body = gateway[gw[1]];
      if (body instanceof Error) throw body;
      if (!body) return jsonResponse({ error: { message: "Not found" } }, 404);
      return jsonResponse(body);
    }
    const w = /https:\/\/([a-z]+)\.bibliocommons\.com\/events\/events\/([0-9a-f]{24})\/registration_windows/.exec(u);
    if (w) {
      const body = windows[w[2]];
      if (body instanceof Error) throw body;
      if (!body) return jsonResponse({ error: "missing" }, 404);
      return jsonResponse(body);
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { impl, calls };
}

function gatewayBody(records) {
  const events = {};
  for (const r of records) events[r.id] = r;
  return { entities: { events } };
}

const silent = () => {};

test("Midpen capacity can fill and reopen without affecting walk-ups or other sources", async () => {
  const spots = readFileSync(new URL("../lib/fixtures/midpen-volunteer-spots.html", import.meta.url), "utf8");
  const project = {
    id: "midpen-d0971601e9e7fcc3", registration: "required",
    url: "https://www.openspace.org/events/volunteer-projects/habitat-restoration-thistle-removal-25",
  };
  const walkup = { id: "guided", url: project.url.replace("volunteer-projects", "guided-activities") };
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, text: async () => spots.replace("3 open spots", "0 open spots") }; };
  const full = await recheckRegistrationGatedEvents([project, walkup], { fetchImpl, log: silent });
  assert.equal(full.events[0].registration, "full");
  assert.equal(full.events[1], walkup);
  assert.equal(project.registration, "required", "shared source objects stay untouched");
  assert.equal(calls, 1);
  const reopened = await recheckRegistrationGatedEvents(full.events, {
    fetchImpl: async () => ({ ok: true, text: async () => spots }), log: silent,
  });
  assert.equal(reopened.events[0].registration, "required");
  for (const response of [
    { ok: true, text: async () => "If there are 0 spots available, click WAITLIST." },
    { ok: false, status: 403 },
  ]) {
    const unknown = await recheckRegistrationGatedEvents(full.events, { fetchImpl: async () => response, log: silent });
    assert.equal(unknown.events[0].registration, "full");
  }
});

test("biblioEventRef parses library-prefixed ids and rejects everything else", () => {
  assert.deepEqual(biblioEventRef(ukuleleListing()), {
    libraryId: "sjpl",
    eventId: "6a7a2993b44674e2601d024d",
  });
  assert.equal(biblioEventRef({ id: "eventbrite-123456789" }), null);
  assert.equal(biblioEventRef({ id: "mvpl-6a7a2993b44674e2601d024d" }), null); // unknown library
  assert.equal(biblioEventRef({ id: "sjpl-notahexid" }), null);
  assert.equal(biblioEventRef({}), null);
});

test("a listing whose live window has ENDED is dropped — the shipped defect", async () => {
  // The record's own flags still say open (they did on Sept 1); only the
  // resolved window knows the truth.
  const { impl, calls } = stubFetch({
    gateway: { sjpl: gatewayBody([ukuleleGatewayRecord()]) },
    windows: { "6a7a2993b44674e2601d024d": { event: { status: "ENDED", window_end: "2026-08-17T00:00:00" } } },
  });
  const walkUp = { id: "sjpl-aaaaaaaaaaaaaaaaaaaaaaaa", title: "Family Storytime", date: "2026-09-01" };
  const { events, dropped } = await recheckRegistrationGatedEvents(
    [walkUp, ukuleleListing()],
    { fetchImpl: impl, log: silent },
  );
  assert.deepEqual(events.map((e) => e.title), ["Family Storytime"]);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /window ended/);
  // The ungated listing triggered no fetches of its own.
  assert.equal(calls.filter((u) => u.includes("aaaaaaaaaaaaaaaaaaaaaaaa")).length, 0);
});

test("an ACTIVE window keeps the listing exactly as assembled", async () => {
  const { impl } = stubFetch({
    gateway: { sjpl: gatewayBody([ukuleleGatewayRecord()]) },
    windows: { "6a7a2993b44674e2601d024d": { event: { status: "ACTIVE" } } },
  });
  const listing = ukuleleListing();
  const { events, dropped } = await recheckRegistrationGatedEvents([listing], { fetchImpl: impl, log: silent });
  assert.equal(events[0], listing); // same object — nothing changed
  assert.equal(dropped.length, 0);
});

test("a listing that filled overnight is re-labelled, not dropped", async () => {
  const { impl } = stubFetch({
    gateway: { sjpl: gatewayBody([ukuleleGatewayRecord({ isFull: true })]) },
    windows: { "6a7a2993b44674e2601d024d": { event: { status: "ACTIVE" } } },
  });
  const listing = ukuleleListing();
  const { events, dropped } = await recheckRegistrationGatedEvents([listing], { fetchImpl: impl, log: silent });
  assert.equal(dropped.length, 0);
  assert.equal(events[0].registration, "full");
  // Shallow copy, never a mutation of the shared feed object.
  assert.equal(listing.registration, "required");
});

test("a live closed flag (with accounting) drops the listing without a windows call", async () => {
  const { impl, calls } = stubFetch({
    gateway: { sjpl: gatewayBody([ukuleleGatewayRecord({ registrationClosed: true })]) },
  });
  const { events, dropped } = await recheckRegistrationGatedEvents([ukuleleListing()], { fetchImpl: impl, log: silent });
  assert.equal(events.length, 0);
  assert.match(dropped[0].reason, /registration closed/);
  assert.equal(calls.some((u) => u.includes("registration_windows")), false);
});

test("a record cancelled since ingest is dropped", async () => {
  const { impl } = stubFetch({
    gateway: { sjpl: gatewayBody([ukuleleGatewayRecord({ isCancelled: true })]) },
  });
  const { events, dropped } = await recheckRegistrationGatedEvents([ukuleleListing()], { fetchImpl: impl, log: silent });
  assert.equal(events.length, 0);
  assert.match(dropped[0].reason, /cancelled/);
});

test("a listing no longer gated at the source loses its tag but keeps its slot", async () => {
  const { impl } = stubFetch({
    gateway: { sjpl: gatewayBody([ukuleleGatewayRecord({ provider: null, cap: null })]) },
  });
  const { events, dropped } = await recheckRegistrationGatedEvents([ukuleleListing()], { fetchImpl: impl, log: silent });
  assert.equal(dropped.length, 0);
  assert.equal(events[0].title, "Intro to Ukulele for Adults");
  assert.equal("registration" in events[0], false);
  assert.equal("registrationClosesBy" in events[0], false);
});

test("FAIL OPEN: fetch failures keep every listing as assembled", async () => {
  // Gateway down entirely.
  const down = stubFetch({ gateway: { sjpl: new Error("ECONNRESET") } });
  const listing = ukuleleListing();
  let result = await recheckRegistrationGatedEvents([listing], { fetchImpl: down.impl, log: silent });
  assert.equal(result.events[0], listing);
  assert.equal(result.dropped.length, 0);

  // Gateway fine, windows endpoint down: the fresh label applies, the drop
  // decision does not — a network blip must never empty the section.
  const half = stubFetch({
    gateway: { sjpl: gatewayBody([ukuleleGatewayRecord()]) },
    windows: { "6a7a2993b44674e2601d024d": new Error("timeout") },
  });
  result = await recheckRegistrationGatedEvents([listing], { fetchImpl: half.impl, log: silent });
  assert.equal(result.events.length, 1);
  assert.equal(result.dropped.length, 0);

  // Record missing from a successful gateway response: also kept — the id
  // roster shifts for reasons that aren't "this event stopped existing".
  const missing = stubFetch({ gateway: { sjpl: gatewayBody([]) } });
  result = await recheckRegistrationGatedEvents([listing], { fetchImpl: missing.impl, log: silent });
  assert.equal(result.events.length, 1);
});

test("gated non-BiblioCommons listings pass through with zero fetches", async () => {
  const { impl, calls } = stubFetch({});
  const inbound = { id: "inbound-workshop-42", title: "Sourdough Workshop", registration: "required" };
  const { events, dropped } = await recheckRegistrationGatedEvents([inbound], { fetchImpl: impl, log: silent });
  assert.equal(events[0], inbound);
  assert.equal(dropped.length, 0);
  assert.equal(calls.length, 0);
});

test("gateway lookups batch to one request per library", async () => {
  const sjplA = ukuleleGatewayRecord();
  const sjplB = { ...ukuleleGatewayRecord(), id: "bbbbbbbbbbbbbbbbbbbbbbbb" };
  const scclC = { ...ukuleleGatewayRecord(), id: "cccccccccccccccccccccccc" };
  const { impl, calls } = stubFetch({
    gateway: {
      sjpl: gatewayBody([sjplA, sjplB]),
      sccl: gatewayBody([scclC]),
    },
    windows: {
      "6a7a2993b44674e2601d024d": { event: { status: "ACTIVE" } },
      bbbbbbbbbbbbbbbbbbbbbbbb: { event: { status: "ACTIVE" } },
      cccccccccccccccccccccccc: { event: { status: "ACTIVE" } },
    },
  });
  const listings = [
    ukuleleListing(),
    { id: "sjpl-bbbbbbbbbbbbbbbbbbbbbbbb", title: "B", registration: "appointment-only" },
    { id: "sccl-cccccccccccccccccccccccc", title: "C", registration: "full" },
  ];
  const { events } = await recheckRegistrationGatedEvents(listings, { fetchImpl: impl, log: silent });
  assert.equal(events.length, 3);
  const gatewayCalls = calls.filter((u) => u.includes("gateway.bibliocommons.com"));
  assert.equal(gatewayCalls.length, 2);
  assert.ok(gatewayCalls.some((u) => u.includes("/sjpl/") && u.includes("6a7a2993b44674e2601d024d,bbbbbbbbbbbbbbbbbbbbbbbb")));
});

test("an empty or ungated list makes no requests at all", async () => {
  const { impl, calls } = stubFetch({});
  const walkUp = { id: "sjpl-dddddddddddddddddddddddd", title: "Drop-in Chess" };
  const a = await recheckRegistrationGatedEvents([], { fetchImpl: impl, log: silent });
  const b = await recheckRegistrationGatedEvents([walkUp], { fetchImpl: impl, log: silent });
  assert.deepEqual(a.events, []);
  assert.equal(b.events[0], walkUp);
  assert.equal(calls.length, 0);
});
