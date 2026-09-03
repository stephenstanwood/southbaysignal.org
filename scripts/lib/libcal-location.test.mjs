import assert from "node:assert/strict";
import test from "node:test";

import { classifyLibCalLocation, extractPublishedAddress } from "./libcal-location.mjs";

// Mirrors the real LIBCAL_LIBRARIES entries in playwright-scrapers.mjs.
const MV = {
  name: "Mountain View Public Library",
  city: "mountain-view",
  address: "585 Franklin St, Mountain View, CA 94041",
  onsiteLocations: ["History Center"],
  offsiteAddresses: {
    "Pioneer Park": "1146 Church St, Mountain View, CA 94041",
    "Cuesta Park": "615 Cuesta Dr, Mountain View, CA 94040",
    "Magical Bridge Playground": "201 S Rengstorff Ave, Mountain View, CA 94040",
    "Rengstorff Park": "201 S Rengstorff Ave, Mountain View, CA 94040",
    "Deer Hollow Farm": "22500 Cristo Rey Dr, Cupertino, CA",
  },
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

// "Offsite" was in this list until 2026-09-03 and is deliberately no longer:
// it asserts the event is NOT at the library, so it gets its own kind and its
// own tests below. These remaining values genuinely say nothing about where.
test("placeholder locations drop the address instead of claiming the library", () => {
  for (const raw of ["TBD", "To Be Determined", "Various", "See description", "N/A"]) {
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
    "Whisman Park",
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
  // Pioneer Park is in the library's offsiteAddresses map; Whisman Park is
  // not, and must not borrow an address from anywhere.
  assert.equal(classifyLibCalLocation("Pioneer Park", MV).address, MV.offsiteAddresses["Pioneer Park"]);
  assert.equal(classifyLibCalLocation("pioneer park", MV).address, MV.offsiteAddresses["Pioneer Park"]);
  assert.equal(classifyLibCalLocation("Whisman Park", MV).address, "");
  // A library with no map at all still classifies, just without addresses.
  assert.equal(classifyLibCalLocation("Pioneer Park", LG).address, "");
});

// ── 2026-09-03: LibCal's own Location is the literal string "Offsite" ───────
//
// event/17295774 "Cuesta Park Storytime" shipped as "Mountain View Public
// Library" — on the site, in the newsletter, and in the schema.org JSON-LD —
// because "Offsite" matched the TBD/Various placeholder set, whose branch
// falls back to the host library. "Offsite" is the one value that positively
// asserts the event is NOT there.

const CUESTA = {
  title: "Cuesta Park Storytime",
  description:
    "<p>Stop by the Bookmobile for stories, songs, and rhymes in the heart of Cuesta Park! "
    + "Enjoy a fun-filled storytime at the playground, and take advantage of full library "
    + "services available from 10:00&ndash;11:00 a.m.</p><p>Events are weather permitting.<br />"
    + "Find us at 615 Cuesta Drive, Mountain View, CA 94040</p>",
};

test("mountainview.libcal.com/event/17295774 — Location: Offsite never names the library", () => {
  const got = classifyLibCalLocation("Offsite", MV, CUESTA);
  assert.equal(got.kind, "offsite-unnamed");
  assert.notEqual(got.venue, MV.name, "an off-site event must never carry the library's name");
  assert.notEqual(got.address, MV.address, "…nor the library's street address");
  assert.equal(got.venue, "Cuesta Park");
  assert.equal(got.address, "615 Cuesta Dr, Mountain View, CA 94040");
  assert.equal(got.virtual, false);
  assert.ok(!got.suppress, "a resolved off-site event still ships");
});

test("Offsite spellings all route away from the library", () => {
  for (const raw of ["Offsite", "offsite", "Off-site", "OFF SITE", "off site"]) {
    const got = classifyLibCalLocation(raw, MV, CUESTA);
    assert.equal(got.kind, "offsite-unnamed", `${raw} must not be treated as a placeholder`);
    assert.notEqual(got.venue, MV.name, `${raw} must not name the library`);
  }
});

test("the longest verified name wins, so a playground beats the park around it", () => {
  const got = classifyLibCalLocation("Offsite", MV, {
    title: "Magical Bridge Storytime",
    description:
      "Stop by the Bookmobile for stories in the heart of Rengstorff Park! Enjoy a storytime "
      + "at the Magical Bridge Playground. Find us at 201 S. Rengstorff Ave, Mountain View, CA 94040.",
  });
  assert.equal(got.venue, "Magical Bridge Playground");
  assert.equal(got.address, "201 S Rengstorff Ave, Mountain View, CA 94040");
});

test("an off-site venue in another city keeps its own address", () => {
  const got = classifyLibCalLocation("Offsite", MV, {
    title: "Deer Hollow Spooky Storytime",
    description: "Meet us there: Deer Hollow Farm, 22500 Cristo Rey Dr., Cupertino",
  });
  assert.equal(got.venue, "Deer Hollow Farm");
  assert.equal(got.address, "22500 Cristo Rey Dr, Cupertino, CA");
  assert.notEqual(got.venue, MV.name);
});

test("an unlisted off-site venue that publishes an address ships that address, not the library", () => {
  const got = classifyLibCalLocation("Offsite", MV, {
    title: "Pop-Up Storytime",
    description: "Join us at 1000 Elsewhere Boulevard, Sunnyvale, CA 94086 for songs and books.",
  });
  assert.equal(got.address, "1000 Elsewhere Boulevard, Sunnyvale, CA 94086");
  assert.notEqual(got.venue, MV.name);
  assert.ok(!got.suppress);
});

test("an off-site event with no resolvable venue is suppressed, never labelled with the library", () => {
  const got = classifyLibCalLocation("Offsite", MV, {
    title: "Community Outreach Visit",
    description: "Our librarians will be out and about. Ask at the desk for details.",
  });
  assert.equal(got.suppress, true, "fail closed rather than assert a building");
  assert.equal(got.venue, "");
  assert.equal(got.address, "");
});

test("genuine placeholders still fall back to the library name but never its address", () => {
  for (const raw of ["TBD", "TBA", "Various", "See description", "N/A", "None", "Other"]) {
    const got = classifyLibCalLocation(raw, MV, {});
    assert.equal(got.kind, "unknown", `${raw} stays a placeholder`);
    assert.equal(got.venue, MV.name);
    assert.equal(got.address, "", `${raw} must not claim ${MV.address}`);
  }
});

// ── the address reader ─────────────────────────────────────────────────────

test("extractPublishedAddress reads first-party addresses and nothing else", () => {
  assert.equal(
    extractPublishedAddress("Find us at 615 Cuesta Drive, Mountain View, CA 94040"),
    "615 Cuesta Drive, Mountain View, CA 94040",
  );
  assert.equal(
    extractPublishedAddress("Meet us there: Deer Hollow Farm, 22500 Cristo Rey Dr., Cupertino, CA"),
    "22500 Cristo Rey Dr., Cupertino, CA",
  );
  // Prose that merely mentions a place is not an address.
  assert.equal(extractPublishedAddress("Join us in the heart of Cuesta Park!"), "");
  assert.equal(extractPublishedAddress("Room 3 opens at 10:00 a.m."), "");
  assert.equal(extractPublishedAddress(""), "");
  assert.equal(extractPublishedAddress(null), "");
});
