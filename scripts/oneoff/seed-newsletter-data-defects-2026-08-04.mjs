#!/usr/bin/env node
// ---------------------------------------------------------------------------
// One-off: seed the newsletter data-defect ledger from findings already sitting
// in `guidance`.
//
// Until now the editorial pass had one bucket. Every finding — including ones
// about the SOURCE DATA that no editor could fix — was stored as `guidance`,
// i.e. a note telling tomorrow's editor to work around it. The pipeline that
// owns the fix never heard. lib.mjs now splits the two at the source, but that
// only affects findings from the next send onward; the ones already filed
// would sit in guidance forever. This lifts them across so the ledger is
// useful on day one.
//
// PURELY ADDITIVE: `guidance` is left exactly as-is. The window-pressure fix
// is the reflection contract change (new findings file themselves correctly),
// not a retroactive purge — deleting guidance the editor is actively using is
// a behaviour change this seed has no business making.
//
// Classification test applied to each entry: could tomorrow's editor fix this
// by writing or selecting differently from the same data? If yes it stays
// guidance. Only entries where the underlying RECORD is wrong or missing a
// field move here. Judgment calls, spelled out so they can be argued with:
//
//   MIGRATED
//   • cost — records carry no cost field, so the editor cannot label a price
//     it was never given. Two separate phrasings, both kept verbatim.
//   • url  — the record's primary link IS a bare registration form; the editor
//     cannot invent a canonical event page.
//   • civic — civic meeting records lack a start time and agenda link.
//
//   NOT MIGRATED (deliberately)
//   • "Consolidate duplicate events: three separate 'National Night Out'
//     bullets" — verified 2026-08-04: Palo Alto (5:00, Gamble Garden),
//     Mountain View (5:30) and Los Altos (6:00) are three real, correct,
//     distinct events. Grouping them into one bullet is a PRESENTATION
//     preference the editor can act on, not a data defect. Filing it as one
//     would send the pipeline hunting for a duplicate that does not exist.
//   • markdown-escape leaks ('vs\.', '\- Campbell') — render/copy lint.
//   • everything about ordering, tone, lead-vs-body, anchor breadth.
//
// firstSeen/lastSeen are set to the migration date rather than backdated:
// these entries carry no real first-seen history and inventing one would
// misrepresent how long each has been broken. `migratedFromGuidance` marks
// them so nobody reads their count as observed recurrence.
//
// Re-runnable: matches on the existing ledger, so a second run is a no-op.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "../lib/io.mjs";
import { mergeDataDefects, todayPT } from "../newsletter/lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_PATH = resolve(__dirname, "../../src/data/south-bay/newsletter-editorial-memory.json");

// Exact guidance text → area. Matched by substring against the live guidance
// array so we only migrate what is actually there.
const MIGRATIONS = [
  { match: "Every listed event needs a cost signal", area: "cost" },
  { match: "Apply free/paid tags consistently", area: "cost" },
  { match: "no forms.gle/raw registration URLs as the primary link", area: "url" },
  { match: "Prefer canonical event pages over form/registration links", area: "url" },
  { match: "Give the civic section a reason to exist", area: "civic" },
];

if (!existsSync(MEMORY_PATH)) {
  console.log("No newsletter-editorial-memory.json here (it is gitignored / Mini-only) — nothing to seed.");
  process.exit(0);
}

const raw = readFileSync(MEMORY_PATH, "utf8");
const memory = JSON.parse(raw);
const guidance = Array.isArray(memory.guidance) ? memory.guidance : [];
const today = todayPT();

const incoming = [];
for (const { match, area } of MIGRATIONS) {
  const found = guidance.find((g) => String(g).includes(match));
  if (!found) {
    console.warn(`⚠️  guidance entry not found, skipping: "${match}"`);
    continue;
  }
  incoming.push({ area, detail: found, example: "" });
}

if (!incoming.length) {
  console.log("Nothing to migrate.");
  process.exit(0);
}

const before = Array.isArray(memory.dataDefects) ? memory.dataDefects.length : 0;
const merged = mergeDataDefects(memory.dataDefects, incoming, today).map((d) =>
  d.lastSeen === today && (d.count || 0) === 1 ? { ...d, migratedFromGuidance: true } : d,
);

if (merged.length === before && before > 0) {
  console.log(`Ledger already holds these ${before} defect(s) — no change.`);
  process.exit(0);
}

memory.dataDefects = merged;
memory._meta = { ...(memory._meta || {}), updatedAt: new Date().toISOString() };
writeFileAtomic(MEMORY_PATH, JSON.stringify(memory, null, 2) + (raw.endsWith("\n") ? "\n" : ""));

console.log(`Seeded ledger: ${before} → ${merged.length} defect(s). guidance left untouched (${guidance.length} entries).`);
for (const d of merged) console.log(`  [${d.area}] ${d.detail.slice(0, 96)}${d.detail.length > 96 ? "…" : ""}`);
