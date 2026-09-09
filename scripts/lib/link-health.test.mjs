import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyLink,
  extractLinks,
  hostOf,
  looksParked,
  HARD_BUCKETS,
} from "./link-health.mjs";

// The three cases below are the real 2026-09-09 findings, kept as fixtures so a
// future refactor cannot quietly stop catching them.

test("a squatted domain that 200s is not healthy", () => {
  // campbellfarmersmarket.com redirected here while the card still linked it.
  const finalUrl =
    "https://www.hugedomains.com/domain_profile.cfm?d=campbellfarmersmarket.com";
  const title = "CampbellFarmersMarket.com is for sale | HugeDomains";
  assert.equal(looksParked({ finalUrl, title }), true);
  assert.equal(classifyLink({ status: 200, finalUrl, title }), "parked");
});

test("a for-sale title alone is enough, even off a parking host", () => {
  assert.equal(
    classifyLink({
      status: 200,
      finalUrl: "https://example.org/",
      title: "example.org is for sale",
    }),
    "parked",
  );
});

test("a certificate mismatch is reported apart from a plain outage", () => {
  // lgcr.com served a Pantheon default cert that does not cover the name.
  assert.equal(classifyLink({ errorCode: "ERR_TLS_CERT_ALTNAME_INVALID" }), "tls");
  assert.equal(classifyLink({ errorCode: "CERT_HAS_EXPIRED" }), "tls");
  assert.equal(classifyLink({ errorCode: "ENOTFOUND" }), "broken");
  assert.equal(classifyLink({ errorCode: "UND_ERR_CONNECT_TIMEOUT" }), "broken");
});

test("an incomplete cert chain is not a broken link", () => {
  // cinequest.org omits its intermediate. Node cannot verify the leaf; a
  // browser fetches the issuer via AIA and loads the festival site fine.
  assert.equal(classifyLink({ errorCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), "suspicious");
  assert.equal(classifyLink({ errorCode: "UNABLE_TO_GET_ISSUER_CERT" }), "suspicious");
  assert.equal(HARD_BUCKETS.has(classifyLink({ errorCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })), false);
});

test("404 is broken, 403 is only suspicious", () => {
  // sunnyvale.ca.gov's retired market page vs. Cloudflare bot-blocking sjmusart.
  assert.equal(classifyLink({ status: 404, finalUrl: "https://sunnyvale.ca.gov/x" }), "broken");
  assert.equal(classifyLink({ status: 403, finalUrl: "https://sjmusart.org" }), "suspicious");
  assert.equal(classifyLink({ status: 406, finalUrl: "https://www.arista.com/" }), "suspicious");
  assert.equal(classifyLink({ status: 500, finalUrl: "https://example.org" }), "broken");
});

test("a plain 200 on the intended host passes", () => {
  assert.equal(
    classifyLink({
      status: 200,
      finalUrl: "https://uvfm.org/campbell-sundays",
      title: "Campbell - SUN — Urban Village Farmers' Markets",
    }),
    "ok",
  );
});

test("only broken, parked and tls are hard findings", () => {
  assert.deepEqual([...HARD_BUCKETS].sort(), ["broken", "parked", "tls"]);
  assert.equal(HARD_BUCKETS.has("suspicious"), false);
  assert.equal(HARD_BUCKETS.has("ok"), false);
});

test("hostOf drops www and survives junk", () => {
  assert.equal(hostOf("https://www.lgcrc.com/"), "lgcrc.com");
  assert.equal(hostOf("not a url"), "");
});

test("extractLinks labels each link with the card a reader would click", () => {
  const src = [
    "export const X = [",
    "  {",
    '    id: "campbell-farmers-market",',
    '    title: "Campbell Farmers Market",',
    '    url: "https://uvfm.org/campbell-sundays",',
    "  },",
    "  {",
    '    id: "no-link-here",',
    '    venue: "Somewhere",',
    "  },",
    "  {",
    '    id: "id-only",',
    '    url: "https://example.org",',
    "  },",
    "];",
  ].join("\n");
  assert.deepEqual(extractLinks(src), [
    { label: "Campbell Farmers Market", url: "https://uvfm.org/campbell-sundays" },
    { label: "id-only", url: "https://example.org" },
  ]);
});
