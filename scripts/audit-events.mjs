#!/usr/bin/env node
// ---------------------------------------------------------------------------
// audit-events.mjs
//
// Scans src/data/south-bay/upcoming-events.json and inbound-events.json for:
//   - virtual events not tagged as virtual
//   - slug/address mismatches (e.g. city=milpitas, address in Santa Clara)
//   - out-of-area events (Santa Cruz, SF, etc.) leaking into in-area feed
//   - "Education" category but title is a commission/meeting pattern
//
// Produces src/data/south-bay/events-suspected-issues.json as a tiered report.
// Does NOT mutate the source files — surgeon step is separate.
//
// Usage: npm run audit-events
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SLUG_TO_CITY_TOKENS,
  OUT_OF_AREA_CITIES,
  NON_CA_STATES,
  VIRTUAL_TITLE_SIGNALS,
  VIRTUAL_ADDRESS_SIGNALS,
  MEETING_TITLE_PATTERNS,
  BORDER_VENUE_ALLOWLIST,
} from "./social/lib/content-rules.mjs";

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
  const titleLower = title.toLowerCase();
  const venueLower = (event.venue || "").toLowerCase();
  const borderAllowed = BORDER_VENUE_ALLOWLIST.some((needle) =>
    titleLower.includes(needle) || venueLower.includes(needle) || locLower.includes(needle)
  );
  if (!borderAllowed) {
    for (const ooaCity of OUT_OF_AREA_CITIES) {
      const re = new RegExp(`\\b${ooaCity}\\b`, "i");
      if (re.test(locLower)) {
        // Tolerate out-of-area city names that appear inside a recognizable
        // address for an in-area city (rare, but possible for street names).
        const tokens = city ? SLUG_TO_CITY_TOKENS[city] : null;
        const inAreaHit = tokens && tokens.some(t => locLower.includes(t));
        if (!inAreaHit) {
          findings.push({
            severity: "hard",
            reason: "out-of-area",
            detail: `location mentions "${ooaCity}" with no in-area city token`,
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
    if (!tokens.some(t => locLower.includes(t))) {
      let otherSlug = null;
      for (const [slug, toks] of Object.entries(SLUG_TO_CITY_TOKENS)) {
        if (slug === city) continue;
        if (toks.some(t => locLower.includes(t))) {
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
  for (const e of events) {
    const findings = classify(e);
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

function main() {
  const upcoming = auditSource("upcoming-events.json", UPCOMING);
  const inbound = auditSource("inbound-events.json", INBOUND);
  const report = {
    _meta: { auditedAt: new Date().toISOString() },
    upcoming,
    inbound,
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");

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
}

main();
