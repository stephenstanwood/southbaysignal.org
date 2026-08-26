#!/usr/bin/env node
// ---------------------------------------------------------------------------
// audit-events.mjs
//
// Scans src/data/south-bay/upcoming-events.json and inbound-events.json for:
//   - virtual events not tagged as virtual
//   - slug/address mismatches (e.g. city=milpitas, address in Santa Clara)
//   - out-of-area events (Santa Cruz, SF, etc.) leaking into in-area feed
//   - "Education" category but title is a commission/meeting pattern
//   - blurbs claiming a series position or weekday that their own run disproves
//
// Produces src/data/south-bay/events-suspected-issues.json as a tiered report.
// Does NOT mutate the source files — surgeon step is separate.
//
// Usage: npm run audit-events
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "./lib/io.mjs";
import { catSignal } from "./lib/notify.mjs";
import {
  SLUG_TO_CITY_TOKENS,
  OUT_OF_AREA_CITIES,
  NON_CA_STATES,
  VIRTUAL_TITLE_SIGNALS,
  VIRTUAL_ADDRESS_SIGNALS,
  MEETING_TITLE_PATTERNS,
  BORDER_VENUE_ALLOWLIST,
} from "./social/lib/content-rules.mjs";
import { LOCAL_DEPARTURE_TRIP } from "../src/lib/south-bay/eventFilters.mjs";
import {
  eventBlurbCacheKey,
  blurbSequencePositionConflict,
  blurbDayOfWeekConflict,
} from "../src/lib/south-bay/eventBlurbs.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const UPCOMING = resolve(ROOT, "src/data/south-bay/upcoming-events.json");
const INBOUND = resolve(ROOT, "src/data/south-bay/inbound-events.json");
const REPORT = resolve(ROOT, "src/data/south-bay/events-suspected-issues.json");

// Venue names that span multiple cities — do NOT use them for city-slug
// mismatch detection. "Santa Clara County Library" has branches in every
// SCC city; "VTA" serves all of them; etc.
const MULTI_CITY_VENUE_PATTERNS = [
  /\bsanta clara county library\b/i,
  /\bsccl\b/i,
  /\bsan jose public library\b/i,  // SJPL has neighborhood branches
  /\bvta\b/i,
  /\bcaltrain\b/i,
  /\bde anza college\b/i,  // a legit Cupertino campus, but name contains no city token
];

// audit-events extends VIRTUAL_TITLE_SIGNALS with one extra pattern — "zoom
// meeting" is too common as a calendar heading to put in the shared set (it
// causes false positives on "post-meeting zoom coffee"-style descriptions).
const AUDIT_VIRTUAL_TITLE_SIGNALS = [...VIRTUAL_TITLE_SIGNALS, /\bzoom meeting\b/i];
const AUDIT_VIRTUAL_ADDRESS_SIGNALS = [...VIRTUAL_ADDRESS_SIGNALS, /^https?:\/\//i];

function getLocationText(e) {
  return [e.address, e.location, e.venue, e.description].filter(Boolean).join(" | ");
}

// Address-only text for geography checks. Descriptions can mention sponsors,
// charities, or "supports families in [out-of-area city]" — those references
// are not the event's location and shouldn't trigger out-of-area findings.
function getAddressText(e) {
  return [e.address, e.location, e.venue].filter(Boolean).join(" | ");
}

function getCity(e) {
  return e.city || e.cityKey || null;
}

function getVirtualFlag(e) {
  if (e.virtual === true) return true;
  if (typeof e.venue === "string" && /\bvirtual|online|zoom\b/i.test(e.venue)) {
    // Already reflected in venue string, but still flag for missing boolean.
    return "venue-implied";
  }
  return false;
}

function classify(event) {
  const findings = [];
  const title = event.title || "";
  const loc = getLocationText(event);
  const city = getCity(event);

  // Virtual signals — split into strong (title or address) vs. weak (description only).
  const alreadyFlagged = getVirtualFlag(event) === true;
  if (!alreadyFlagged) {
    let virtualHit = null;
    for (const re of AUDIT_VIRTUAL_TITLE_SIGNALS) {
      if (re.test(title)) { virtualHit = { severity: "hard", re, where: "title" }; break; }
    }
    if (!virtualHit) {
      const addr = event.address || event.location || "";
      for (const re of AUDIT_VIRTUAL_ADDRESS_SIGNALS) {
        if (re.test(addr)) { virtualHit = { severity: "hard", re, where: "address" }; break; }
      }
    }
    // Soft: description says "virtual" but title doesn't — could be dual-format.
    if (!virtualHit && (event.description || "")) {
      if (/\b(join us online|join online|virtual(ly)?|livestream)\b/i.test(event.description)) {
        virtualHit = { severity: "soft", re: /description mention/, where: "description" };
      }
    }
    if (virtualHit) {
      findings.push({
        severity: virtualHit.severity,
        reason: "virtual-not-flagged",
        detail: `matched ${virtualHit.re} in ${virtualHit.where}`,
      });
    }
  }

  // Out-of-area event tagged as in-area.
  const locLower = loc.toLowerCase();
  const addrLower = getAddressText(event).toLowerCase();
  const titleLower = title.toLowerCase();
  const venueLower = (event.venue || "").toLowerCase();
  const borderAllowed = BORDER_VENUE_ALLOWLIST.some((needle) =>
    titleLower.includes(needle) || venueLower.includes(needle) || locLower.includes(needle)
  );
  if (!borderAllowed) {
    for (const ooaCity of OUT_OF_AREA_CITIES) {
      const re = new RegExp(`\\b${ooaCity}\\b`, "i");
      if (re.test(addrLower)) {
        // Tolerate out-of-area city names that appear inside a recognizable
        // address for an in-area city (rare, but possible for street names).
        const tokens = city ? SLUG_TO_CITY_TOKENS[city] : null;
        const inAreaHit = tokens && tokens.some(t => locLower.includes(t));
        if (!inAreaHit) {
          // Organized outings that depart from a covered city are supposed to
          // have an out-of-area destination — a Sunnyvale senior-center bus to
          // the SF Zoo is Sunnyvale programming, and the ingest keeps it on
          // purpose (LOCAL_DEPARTURE_TRIP in eventFilters.mjs). Report it as
          // info so the hard tier stays a list of things actually worth fixing.
          const departureTrip = LOCAL_DEPARTURE_TRIP.test(title);
          findings.push({
            severity: departureTrip ? "info" : "hard",
            reason: departureTrip ? "local-departure-trip" : "out-of-area",
            detail: departureTrip
              ? `destination "${ooaCity}" is out of area, but the title reads as a trip departing from a covered city — kept by design`
              : `location mentions "${ooaCity}" with no in-area city token`,
          });
        }
        break;
      }
    }
  }

  // Non-CA US state in location.
  for (const m of loc.matchAll(/,\s*([A-Z]{2})\s+\d{5}/g)) {
    if (NON_CA_STATES.has(m[1])) {
      findings.push({
        severity: "hard",
        reason: "non-ca-state",
        detail: `location contains state code ${m[1]}`,
      });
    }
  }

  // Slug vs. in-area mismatch. Skip if the venue is a known multi-city system
  // (SCCL, VTA, SJPL, etc.) — those span branches in every city.
  const isMultiCityVenue = MULTI_CITY_VENUE_PATTERNS.some(re => re.test(loc));
  if (city && SLUG_TO_CITY_TOKENS[city] && loc && !isMultiCityVenue) {
    const tokens = SLUG_TO_CITY_TOKENS[city];
    if (!tokens.some(t => addrLower.includes(t))) {
      let otherSlug = null;
      for (const [slug, toks] of Object.entries(SLUG_TO_CITY_TOKENS)) {
        if (slug === city) continue;
        if (toks.some(t => addrLower.includes(t))) {
          otherSlug = slug;
          break;
        }
      }
      if (otherSlug) {
        findings.push({
          severity: "hard",
          reason: "slug-mismatch",
          detail: `city="${city}" but location references "${otherSlug}"`,
        });
      } else if (city === "santa-clara-county") {
        // "santa-clara-county" is a curated catch-all for hand-picked
        // landmarks, not a real city slug (it isn't in the City union,
        // src/lib/south-bay/types.ts) — an ingest fallback stamping it on
        // an unresolved venue (D53: POST/Midpen preserve names that didn't
        // match a known location) is unlocatable, not curated. Flag hard so
        // it can't silently ship the way the 6 POST/Midpen records did.
        findings.push({
          severity: "hard",
          reason: "unverifiable-county-fallback",
          detail: `city="santa-clara-county" but location text contains no "santa clara county" token — looks like an unresolved ingest fallback, not a curated pick`,
        });
      }
    }
  }

  // Meeting-pattern title.
  for (const re of MEETING_TITLE_PATTERNS) {
    if (re.test(title)) {
      findings.push({
        severity: "soft",
        reason: "meeting-title",
        detail: `title matches meeting pattern: ${re}`,
      });
      break;
    }
  }

  // Unknown city slug.
  if (city && !SLUG_TO_CITY_TOKENS[city]) {
    findings.push({
      severity: "soft",
      reason: "unknown-slug",
      detail: `city="${city}" is not in the 11-city coverage map`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Blurb claims a multi-date run disproves (2026-08-26)
//
// One blurb-cache entry serves every occurrence sharing a title+venue+
// description, so a blurb saying this date opens or closes a run — or naming
// the weekday it falls on — is false on all but one of the dates it gets
// stamped on. The 2026-08-26 issue shipped "the San Jose Giants … wrap up
// their series against the Visalia Rawhide" on game 2 of 6; the finale was
// five days later. The same sweep found "every Thursday" on a Wed/Thu pair and
// "Sunday afternoon" on a Sat/Sun pair.
//
// Unlike everything in classify() these are cross-event checks — a single
// record carries no evidence either way, and only its date group makes the
// claim provably wrong. They run off the same detectors the generator rejects
// with (src/lib/south-bay/eventBlurbs.mjs), so the gate and the pipeline can't
// drift apart.
// ---------------------------------------------------------------------------
const BLURB_RUN_CHECKS = [
  {
    reason: "blurb-series-position",
    detect: blurbSequencePositionConflict,
    describe: (claim) => `claims "${claim}"`,
  },
  {
    reason: "blurb-day-of-week",
    detect: blurbDayOfWeekConflict,
    describe: (claim) => `names the day "${claim}"`,
  },
];

function blurbRunFindings(events) {
  const byKey = new Map();
  for (const e of events) {
    const k = eventBlurbCacheKey(e);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }

  const byEvent = new Map();
  for (const group of byKey.values()) {
    const blurb = group.find((e) => e.blurb)?.blurb;
    if (!blurb) continue;
    const dates = [...new Set(group.map((e) => e.date).filter(Boolean))].sort();
    for (const { reason, detect, describe } of BLURB_RUN_CHECKS) {
      const claim = detect(blurb, group);
      if (!claim) continue;
      const finding = {
        severity: "hard",
        reason,
        detail: `blurb ${describe(claim)} but the same blurb is served on ${dates.length} dates (${dates[0]}..${dates[dates.length - 1]}): "${blurb}"`,
      };
      for (const e of group) byEvent.set(e, [...(byEvent.get(e) || []), finding]);
    }
  }
  return byEvent;
}

function loadEvents(path) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(raw)) return { events: raw, shape: "array" };
    if (Array.isArray(raw.events)) return { events: raw.events, shape: "events" };
    if (Array.isArray(raw.items)) return { events: raw.items, shape: "items" };
    if (Array.isArray(raw.inbound)) return { events: raw.inbound, shape: "inbound" };
    return { events: [], shape: "unknown" };
  } catch (err) {
    console.error(`could not read ${path}: ${err.message}`);
    return { events: [], shape: "error" };
  }
}

function auditSource(label, path) {
  const { events } = loadEvents(path);
  const totals = { hard: 0, soft: 0, info: 0 };
  const byReason = {};
  const hardEntries = [];
  const softEntries = [];
  const runFindings = blurbRunFindings(events);
  for (const e of events) {
    const findings = [...classify(e), ...(runFindings.get(e) || [])];
    if (!findings.length) continue;
    const worst = findings.reduce((a, b) => {
      const rank = { hard: 3, soft: 2, info: 1 };
      return rank[a.severity] >= rank[b.severity] ? a : b;
    });
    totals[worst.severity]++;
    for (const f of findings) byReason[f.reason] = (byReason[f.reason] || 0) + 1;
    const record = {
      id: e.id,
      title: e.title,
      city: getCity(e),
      date: e.date || e.startsAt,
      location: e.address || e.location || e.venue || "",
      findings,
    };
    if (worst.severity === "hard") hardEntries.push(record);
    else softEntries.push(record);
  }
  return { label, total: events.length, totals, byReason, hard: hardEntries, soft: softEntries };
}

// A hard virtual-not-flagged finding means an event's own title or address
// says "online/virtual/zoom" while `virtual` is unset — so every downstream
// consumer will treat it as a physical destination. This is exactly the class
// of defect that put SJSU's online-only CRC meeting into the 2026-08-05
// newsletter as an in-person afternoon pick with a lunch paired to it, and it
// sat in this report for weeks because nothing read the report. Now it fails
// the run. Other reasons stay advisory: they need human judgment (is this
// venue really out of area?), while this one is always a pipeline bug —
// generate-events and pull-inbound-events both run the flag pass, so a hit
// here means the flag pass regressed or a new feed skipped it.
function blockersForReason(sources, reason) {
  const blockers = [];
  for (const src of sources) {
    for (const entry of src.hard) {
      for (const finding of entry.findings) {
        if (finding.severity === "hard" && finding.reason === reason) {
          blockers.push(`${src.label}: "${entry.title}" (${entry.id}) — ${finding.detail}`);
        }
      }
    }
  }
  return blockers;
}

async function main() {
  const upcoming = auditSource("upcoming-events.json", UPCOMING);
  const inbound = auditSource("inbound-events.json", INBOUND);
  const report = {
    _meta: { auditedAt: new Date().toISOString() },
    upcoming,
    inbound,
  };
  writeFileAtomic(REPORT, JSON.stringify(report, null, 2) + "\n");

  for (const src of [upcoming, inbound]) {
    console.log(`\n=== ${src.label} ===`);
    console.log(`total: ${src.total}`);
    console.log(`  hard: ${src.totals.hard}  soft: ${src.totals.soft}`);
    for (const [r, c] of Object.entries(src.byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${r.padEnd(24)} ${c}`);
    }
    if (src.hard.length) {
      console.log(`  hard entries:`);
      for (const e of src.hard.slice(0, 20)) {
        const reasons = e.findings.filter(f => f.severity === "hard").map(f => f.reason).join(",");
        console.log(`    [${reasons}] ${e.city ?? "?"} | ${e.title} | ${e.location}`);
      }
      if (src.hard.length > 20) console.log(`    ... and ${src.hard.length - 20} more`);
    }
  }
  console.log(`\nReport: ${REPORT}`);

  const blockers = blockersForReason([upcoming, inbound], "virtual-not-flagged");
  if (blockers.length) {
    console.error(
      `\n❌ BLOCKED: ${blockers.length} event(s) read as virtual but are not flagged \`virtual\`.\n` +
      `   Every downstream surface will publish them as a physical destination.\n` +
      blockers.map((b) => `   - ${b}`).join("\n"),
    );
    await catSignal({
      key: "events-virtual-not-flagged",
      title: `${blockers.length} virtual event(s) not flagged`,
      body: blockers.join("\n"),
    });
    process.exitCode = 1;
  }

  // These need no judgment call: the same sentence is published on every date
  // in the run, so it is wrong on all but one of them. Blocks for the same
  // reason virtual-not-flagged does. Reported per blurb, not per event — six
  // Giants games sharing one bad blurb are one thing to fix, not six.
  for (const { reason, label } of [
    { reason: "blurb-series-position", label: "claim a position in a series that spans several dates" },
    { reason: "blurb-day-of-week", label: "name a weekday their own run contradicts" },
  ]) {
    const found = blockersForReason([upcoming, inbound], reason);
    if (!found.length) continue;
    const unique = [...new Set(found.map((b) => b.replace(/^(.*?): ".*?" \(.*?\) — /, "$1: ")))];
    console.error(
      `\n❌ BLOCKED: ${unique.length} blurb(s) ${label}.\n` +
      `   The same sentence publishes on every date in the run, so it is wrong on all but one.\n` +
      unique.map((b) => `   - ${b}`).join("\n"),
    );
    await catSignal({
      key: `events-${reason}`,
      title: `${unique.length} blurb(s) ${label}`,
      body: unique.join("\n"),
    });
    process.exitCode = 1;
  }
}

await main();
