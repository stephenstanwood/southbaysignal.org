#!/usr/bin/env node
// ---------------------------------------------------------------------------
// report-data-defects.mjs
// ---------------------------------------------------------------------------
// Prints the data defects the nightly editorial pass found in the newsletter's
// SOURCE DATA — duplicate events, bad primary links, missing cost signals,
// times that contradict the venue — as opposed to copy it could fix itself.
//
// Why this exists: the editorial pass has always been good at spotting ingest
// defects, but every finding was stored as `guidance` — a note telling
// TOMORROW'S EDITOR to work around it. So the pipeline never heard about it
// and the defect shipped again the next morning. On 2026-08-04 the editor
// named the exact root cause of that day's bad Evening Pick ("the Texturescape
// opening links to a bare forms.gle URL") in the same issue that shipped the
// bug, and nothing read it. Findings now split at the source (lib.mjs
// reflection contract) and land here with a recurrence count.
//
// Recurrence is the signal worth acting on: seen once = maybe a bad record,
// seen 3+ mornings = a pipeline that isn't fixing it.
//
// Usage:
//   node scripts/newsletter/report-data-defects.mjs           human-readable
//   node scripts/newsletter/report-data-defects.mjs --json    machine-readable
//   node scripts/newsletter/report-data-defects.mjs --strict  exit 1 if recurring
//
// Read-only. Never mutates the ledger or any event data.
// ---------------------------------------------------------------------------

import { loadNewsletterDataDefects, formatDataDefectEscalation, todayPT } from "./lib.mjs";

const jsonMode = process.argv.includes("--json");
const strict = process.argv.includes("--strict");
const RECURRING_THRESHOLD = 3;

const defects = loadNewsletterDataDefects();
const today = todayPT();
const recurring = defects.filter((d) => (d.count || 0) >= RECURRING_THRESHOLD);

if (jsonMode) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), today, defects, recurring }, null, 2));
} else {
  const report = formatDataDefectEscalation(defects, { recurringThreshold: RECURRING_THRESHOLD, today });
  console.log(report || "No open newsletter data defects — the editorial pass found nothing wrong upstream.");
}

// --strict is for a future gate; the default stays exit 0 so this can be
// called from the send job without ever failing a send over a report.
if (strict && recurring.length) process.exit(1);
