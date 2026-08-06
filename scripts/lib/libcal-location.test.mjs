import assert from "node:assert/strict";
import test from "node:test";

import { classifyLibCalLocation } from "./libcal-location.mjs";

// Mirrors the real LIBCAL_LIBRARIES entries in playwright-scrapers.mjs.
const MV = {
  name: "Mountain View Public Library",
  city: "mountain-view",
  address: "585 Franklin St, Mountain View, CA 94041",
  onsiteLocations: ["History Center"],
  offsiteAddresses: { "Pioneer Park": "1146 Church St, Mountain View, CA 94041" },
};
const LG = {
  name: "Los Gatos Library",
  city: "los-gatos",
  address: "110 E Main St, Los Gatos, CA 95030",
  onsiteLocations: [],
};

// ── The two records that shipped wrong on 2026-08-06 ───────────────────────

test("mountainview.libcal.com/event/16953202 — Location: Online is not an in-person library event", () => {
  const got = classifyLibCalLocation("Online", MV);
  assert.equal(got.kind, "online");
  assert.equal(got.virtual, true);
  assert.equal(got.address, "", "an online event must not inherit 585 Franklin St");
  assert.notEqual(got.venue, MV.name);
});

test("mountainview.libcal.com/event/16650443 — Location: Pioneer Park keeps its own venue", () => {
  const got = classifyLibCalLocation("Pioneer Park", MV);
  assert.equal(got.kind, "offsite");
  assert.equal(got.venue, "Pioneer Park");
  assert.equal(got.address, "1146 Church St, Mountain View, CA 94041", "verified off-site address survives");
  assert.notEqual(got.address, MV.address);
  assert.equal(got.virtual, false);
});

// ── On-site: the library really is the venue ───────────────────────────────

test("rooms inside the building keep the library name and address", () => {
  for (const room of [
    "1st Floor Program Room",
    "Children's Room",
    "Conference Room",
    "Teen Room",
    "Group Study Room",
    "Technology Lab",
    "Lobby",
    "Bookmobile Garage",
  ]) {
    const got = classifyLibCalLocation(room, MV);
    assert.equal(got.kind, "onsite", `${room} should be on-site`);
    assert.equal(got.venue, MV.name, `${room} should keep the library venue`);
    assert.equal(got.address, MV.address, `${room} should keep the library address`);
    assert.equal(got.virtual, false);
  }
});

test("per-library onsiteLocations cover in-building spaces the suffix rule can't know", () => {
  // Mountain View's History Center is on the library's 2nd floor.
  const mv = classifyLibCalLocation("History Center", MV);
  assert.equal(mv.kind, "onsite");
  assert.equal(mv.address, MV.address);

  // Los Gatos doesn't list one, so the same string is treated as off-site
  // rather than silently borrowing 110 E Main St.
  const lg = classifyLibCalLocation("History Center", LG);
  assert.equal(lg.kind, "offsite");
  assert.equal(lg.address, "");
});

test("no Location on the page falls back to the library config", () => {
  for (const empty of ["", "   ", null, undefined]) {
    const got = classifyLibCalLocation(empty, LG);
    assert.equal(got.kind, "onsite");
    assert.equal(got.venue, LG.name);
    assert.equal(got.address, LG.address);
  }
});

// ── Online variants ────────────────────────────────────────────────────────

test("online markers are recognised in every observed spelling", () => {
  for (const raw of [
    "Online",
    "online",
    "Zoom (Online)",
    "Zoom",
    "Virtual",
    "Webinar",
    "Livestream",
    "Google Meet",
    "WebEx",
  ]) {
    const got = classifyLibCalLocation(raw, LG);
    assert.equal(got.kind, "online", `${raw} should be online`);
    assert.equal(got.virtual, true, `${raw} should set virtual`);
    assert.equal(got.address, "", `${raw} should carry no address`);
  }
});

test("a hybrid listing on Zoom is treated as virtual, not as a library seat", () => {
  // losgatosca.libcal.com "Online Author Talk" cards: pill "In-Person / Online",
  // Location "Zoom (Online)". Skipping one recommendation beats sending a
  // reader to the building for a Zoom call.
  const got = classifyLibCalLocation("Zoom (Online)", LG);
  assert.equal(got.virtual, true);
  assert.equal(got.address, "");
});

// ── Unknown / placeholder ──────────────────────────────────────────────────

test("placeholder locations drop the address instead of claiming the library", () => {
  for (const raw of ["Offsite", "Off-site", "TBD", "To Be Determined", "Various", "See description", "N/A"]) {
    const got = classifyLibCalLocation(raw, MV);
    assert.equal(got.kind, "unknown", `${raw} should be unknown`);
    assert.equal(got.address, "", `${raw} must not inherit the library address`);
    assert.equal(got.virtual, false);
  }
});

// ── Bookmobile ─────────────────────────────────────────────────────────────

test("Mobile Library Stop is flagged so the scraper can drop it", () => {
  assert.equal(classifyLibCalLocation("Mobile Library Stop", MV).kind, "bookmobile");
});

// ── Regression guard on the core defect ────────────────────────────────────

test("an unrecognised location is never given the library's address", () => {
  for (const raw of [
    "Pioneer Park",
    "Rengstorff Park",
    "Mountain View Community Center",
    "Castro Elementary School",
    "Some Place We Have Never Seen",
  ]) {
    const got = classifyLibCalLocation(raw, MV);
    assert.notEqual(got.address, MV.address, `${raw} must not inherit the library address`);
  }
});

test("whitespace and trailing punctuation are normalised", () => {
  const got = classifyLibCalLocation("  Pioneer   Park.  ", MV);
  assert.equal(got.venue, "Pioneer Park");
});

test("an absurdly long location falls back to the library name rather than a wall of text", () => {
  const got = classifyLibCalLocation("x".repeat(200), MV);
  assert.equal(got.venue, MV.name);
  assert.equal(got.address, "", "still no address — we don't know where it is");
});

test("only verified off-site addresses are filled in — the rest stay empty", () => {
  // Pioneer Park is in the library's offsiteAddresses map; Rengstorff Park is
  // not, and must not borrow an address from anywhere.
  assert.equal(classifyLibCalLocation("Pioneer Park", MV).address, MV.offsiteAddresses["Pioneer Park"]);
  assert.equal(classifyLibCalLocation("pioneer park", MV).address, MV.offsiteAddresses["Pioneer Park"]);
  assert.equal(classifyLibCalLocation("Rengstorff Park", MV).address, "");
  // A library with no map at all still classifies, just without addresses.
  assert.equal(classifyLibCalLocation("Pioneer Park", LG).address, "");
});
