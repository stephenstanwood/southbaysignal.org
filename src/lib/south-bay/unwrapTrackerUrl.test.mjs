// Tests for isTrackerUrl / stripTrackingParams — the guard that keeps
// email-blast wrapper URLs off the public site.
//
// The stakes are not just dead links: several of these wrappers encode the
// recipient. On 2026-08-27 a Los Gatos Library cookbook-club listing shipped
// with a lgplca.patronpoint.com/r/ URL whose token base64-decodes to an
// `email` field and a 64-hex `contactHash` — a per-subscriber identifier,
// published on a public events page.

import test from "node:test";
import assert from "node:assert/strict";
import { isTrackerUrl, stripTrackingParams } from "./unwrapTrackerUrl.mjs";

test("flags PatronPoint library redirects (carry a per-subscriber contactHash)", () => {
  assert.equal(
    isTrackerUrl("https://lgplca.patronpoint.com/r/dfe41380f5a167a4cb048f92a/AAAAAhQGEQFzFAIGABEFZW1haWw"),
    true,
  );
});

test("flags Levi's Stadium / 49ers marketing sends", () => {
  assert.equal(
    isTrackerUrl("https://ls.49ers.com/MjIyLUJBTy04NDQAAAGhb0rvTiCHCsW4VL9Ai9s_2wt9wBae4tdGQgHdzUQoH"),
    true,
  );
});

test("still flags the previously-known wrappers", () => {
  assert.equal(isTrackerUrl("https://cc.rs6.net/tn.jsp?f=001abc"), true);
  assert.equal(isTrackerUrl("https://us7.list-manage.com/track/click?u=1&id=2"), true);
  assert.equal(isTrackerUrl("https://links-2.govdelivery.com/CL0/https%3A%2F%2Fexample.gov/1/010"), true);
});

test("leaves real event pages alone", () => {
  assert.equal(isTrackerUrl("https://levisstadium.com/event/chris-brown-usher-the-randb-tour/"), false);
  assert.equal(isTrackerUrl("https://www.mountainwinery.com/events/detail?event_id=1374384"), false);
  assert.equal(isTrackerUrl("https://sccl.bibliocommons.com/events/6a650543cf8dd42855ad7e51"), false);
  // The bare PatronPoint host is a real library site — only the /r/ redirect
  // path is a tracker.
  assert.equal(isTrackerUrl("https://lgplca.patronpoint.com/events"), false);
});

test("stripTrackingParams drops utm/click ids but keeps real query params", () => {
  assert.equal(
    stripTrackingParams("https://example.com/e?event_id=12&utm_source=news&fbclid=xyz"),
    "https://example.com/e?event_id=12",
  );
  assert.equal(
    stripTrackingParams("https://example.com/e?event_id=12"),
    "https://example.com/e?event_id=12",
  );
});
