#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run warn-scc [-- --file <path.xlsx>] [--all] [--min N]
//
// Prints every Santa Clara County WARN filing in California EDD's current
// fiscal-year workbook, newest notice first, plus a per-company rollup.
//
// Use it to check a tech-companies.ts trendNote against the primary source
// before writing a headcount claim. Prior fiscal years are PDF-only; grab
// them from the landing page linked in scripts/lib/warn-scc.mjs and read with
// `pdftotext -layout`.
//
// Nothing here writes to src/data — this is a read-only verification tool.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import {
  XLSX_URL,
  fetchWarnWorkbook,
  filterSantaClara,
  parseWarnWorkbook,
  summarizeByCompany,
} from "./lib/warn-scc.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : (args[i + 1] ?? "");
};

const file = flag("file");
const min = Number(flag("min") ?? 0) || 0;
const showAll = args.includes("--all");

const buf = file ? await readFile(file) : await fetchWarnWorkbook();
console.log(file ? `Source: ${file}` : `Source: ${XLSX_URL}`);

const rows = parseWarnWorkbook(buf);
const scoped = showAll ? rows : filterSantaClara(rows);
const shown = scoped.filter((r) => r.employees >= min);

if (!shown.length) {
  console.log("No matching filings.");
  process.exit(0);
}

const label = showAll ? "statewide" : "Santa Clara County";
console.log(
  `\n${shown.length} ${label} filings covering ${shown.reduce((n, r) => n + r.employees, 0)} jobs\n`
);

for (const r of [...shown].sort((a, b) => b.noticeDate.localeCompare(a.noticeDate))) {
  console.log(
    `notice ${r.noticeDate}  effective ${r.effectiveDate}  ${String(r.employees).padStart(5)}  ` +
      `${r.company}\n${" ".repeat(41)}${r.type} · ${r.address}`
  );
}

console.log("\nBy company:");
for (const c of summarizeByCompany(shown)) {
  const window =
    c.firstNotice === c.lastNotice ? c.firstNotice : `${c.firstNotice}..${c.lastNotice}`;
  console.log(
    `${String(c.employees).padStart(6)}  ${c.company}  (${c.filings} filing${
      c.filings === 1 ? "" : "s"
    }, ${window})`
  );
}
