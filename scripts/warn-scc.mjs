#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run warn-scc [-- --year 2023-24 | --history] [--company Intel]
//                  [--all] [--min N] [--file <path>]
//
// Prints Santa Clara County WARN filings from California EDD, newest notice
// first, plus a per-company rollup.
//
//   (no flags)        current fiscal year, from EDD's .xlsx
//   --year 2023-24    one prior fiscal year, from that year's PDF
//   --history         every fiscal year back to 2014-15, as a per-year table
//   --company Intel   filter to employers matching this text (works in all modes;
//                     under --history it prints that employer's trajectory)
//
// Use it to check a tech-companies.ts trendNote against the primary source
// before writing a headcount claim. Prior-year PDFs are cached under
// /tmp/sbs-warn-pdfs so a --history run only downloads each year once.
//
// Nothing here writes to src/data — this is a read-only verification tool.
// A WARN filing is a notice, not a headcount. Say "cut on WARN filings".
// ---------------------------------------------------------------------------

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  XLSX_URL,
  fetchWarnWorkbook,
  filterSantaClara,
  parseWarnWorkbook,
  summarizeByCompany,
} from "./lib/warn-scc.mjs";
import {
  WARN_PDF_YEARS,
  fetchWarnPdf,
  isSantaClaraCity,
  parseWarnPdf,
  warnPdfUrl,
} from "./lib/warn-pdf.mjs";
import { TEMP } from "./lib/paths.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : (args[i + 1] ?? "");
};

const file = flag("file");
const year = flag("year");
const company = (flag("company") ?? "").trim();
const min = Number(flag("min") ?? 0) || 0;
const showAll = args.includes("--all");
const history = args.includes("--history");

/** Santa Clara filings, whichever source they came from. FY2014-15 has no
 *  County column, so that year falls back to the mailing city. */
const scopeSantaClara = (rows) =>
  rows.some((r) => r.county)
    ? filterSantaClara(rows)
    : rows.filter((r) => isSantaClaraCity(r.city));

const matchesCompany = (r) =>
  !company || String(r.company ?? "").toLowerCase().includes(company.toLowerCase());

async function loadYear(fiscalYear) {
  await mkdir(TEMP.warnPdfs, { recursive: true });
  const cached = join(TEMP.warnPdfs, `${fiscalYear}.pdf`);
  let buf;
  try {
    buf = await readFile(cached);
  } catch {
    process.stderr.write(`fetching ${warnPdfUrl(fiscalYear)}\n`);
    buf = await fetchWarnPdf(fiscalYear);
    await writeFile(cached, buf);
  }
  let skipped = 0;
  const rows = await parseWarnPdf(buf, { onSkip: () => (skipped += 1) });
  return { rows, skipped };
}

function printFilings(rows) {
  for (const r of [...rows].sort((a, b) => b.noticeDate.localeCompare(a.noticeDate))) {
    const where = r.address || r.city || r.county || "";
    console.log(
      `notice ${r.noticeDate}  effective ${r.effectiveDate}  ${String(r.employees).padStart(5)}  ` +
        `${r.company}\n${" ".repeat(41)}${r.layoffOrClosure ?? r.type} · ${where}`
    );
  }
}

function printRollup(rows) {
  console.log("\nBy company:");
  for (const c of summarizeByCompany(rows)) {
    const window =
      c.firstNotice === c.lastNotice ? c.firstNotice : `${c.firstNotice}..${c.lastNotice}`;
    console.log(
      `${String(c.employees).padStart(6)}  ${c.company}  (${c.filings} filing${
        c.filings === 1 ? "" : "s"
      }, ${window})`
    );
  }
}

// ── Multi-year history ─────────────────────────────────────────────────────
if (history) {
  const years = Object.keys(WARN_PDF_YEARS);
  console.log(
    company
      ? `Santa Clara County WARN filings matching "${company}", by fiscal year\n`
      : "Santa Clara County WARN filings by fiscal year\n"
  );
  console.log("  fiscal year   filings    jobs");

  let totalFilings = 0;
  let totalJobs = 0;
  let totalSkipped = 0;
  const matched = [];

  for (const fy of years.slice().reverse()) {
    const { rows, skipped } = await loadYear(fy);
    totalSkipped += skipped;
    const scc = scopeSantaClara(rows).filter(matchesCompany);
    const jobs = scc.reduce((n, r) => n + r.employees, 0);
    totalFilings += scc.length;
    totalJobs += jobs;
    matched.push(...scc);
    console.log(
      `  ${fy.padEnd(11)} ${String(scc.length).padStart(7)} ${String(jobs).padStart(7)}`
    );
  }

  console.log(`  ${"total".padEnd(11)} ${String(totalFilings).padStart(7)} ${String(totalJobs).padStart(7)}`);
  console.log(
    `\nPrior fiscal years only — run without --history for the current year.` +
      (totalSkipped
        ? ` ${totalSkipped} filing(s) statewide unread: EDD published no employee count.`
        : "")
  );

  if (company && matched.length) {
    console.log("");
    printFilings(matched);
  } else if (!company) {
    printRollup(matched);
  }
  process.exit(0);
}

// ── Single source ──────────────────────────────────────────────────────────
let rows;
let skipped = 0;
let sourceLabel;

if (file) {
  const buf = await readFile(file);
  rows = file.toLowerCase().endsWith(".pdf")
    ? await parseWarnPdf(buf, { onSkip: () => (skipped += 1) })
    : parseWarnWorkbook(buf);
  sourceLabel = file;
} else if (year) {
  ({ rows, skipped } = await loadYear(year));
  sourceLabel = warnPdfUrl(year);
} else {
  rows = parseWarnWorkbook(await fetchWarnWorkbook());
  sourceLabel = XLSX_URL;
}

console.log(`Source: ${sourceLabel}`);

const scoped = (showAll ? rows : scopeSantaClara(rows)).filter(matchesCompany);
const shown = scoped.filter((r) => r.employees >= min);

if (!shown.length) {
  console.log("No matching filings.");
  process.exit(0);
}

const label = showAll ? "statewide" : "Santa Clara County";
console.log(
  `\n${shown.length} ${label} filings covering ${shown.reduce((n, r) => n + r.employees, 0)} jobs` +
    (skipped ? ` (${skipped} skipped: no employee count published)` : "") +
    "\n"
);

printFilings(shown);
printRollup(shown);
