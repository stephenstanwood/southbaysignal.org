// ---------------------------------------------------------------------------
// California EDD WARN report — Santa Clara County reader
//
// The EDD publishes every WARN (mass layoff / closure) notice California
// employers file. It is the only primary source for "how many jobs actually
// left Santa Clara County," and it is the source of record behind the
// trendNote lines in src/data/south-bay/tech-companies.ts.
//
//   Landing page : https://edd.ca.gov/en/jobs_and_training/layoff_services_warn/
//   Current FY   : /siteassets/files/jobs_and_training/warn/warn_report1.xlsx
//   Prior FYs    : /siteassets/files/jobs_and_training/warn/warn-report-for-7-1-25-to-6-30-26.pdf
//
// The current fiscal year ships as a workbook; every prior year back to
// FY2014-15 is PDF only and is read by scripts/lib/warn-pdf.mjs. This module
// reads the workbook with no third-party dependency — .xlsx is a ZIP of XML,
// and Node ships everything needed to open it.
//
// This is a verification tool, not a data pipeline. Nothing renders from it.
// A WARN filing is a notice, not a headcount: it covers a single site, only
// triggers at scale, and the number filed is what the employer expects to cut.
// Say "cut on WARN filings", never "lost N jobs".
// ---------------------------------------------------------------------------

import { inflateRawSync } from "node:zlib";

const XLSX_URL =
  "https://edd.ca.gov/siteassets/files/jobs_and_training/warn/warn_report1.xlsx";

// ── Minimal ZIP reader ─────────────────────────────────────────────────────
// Reads one entry by name out of a ZIP archive. Sizes come from the central
// directory rather than the local header, so entries written with a trailing
// data descriptor (size fields zeroed in the local header) still read cleanly.
export function unzipEntry(buf, name) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory)");
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < entries; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory header");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const entryName = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (entryName === name) {
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const data = buf.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`entry not found in archive: ${name}`);
}

function findEocd(buf) {
  // The EOCD is last, but may be followed by a variable-length comment.
  const floor = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// ── Sheet parsing ──────────────────────────────────────────────────────────
export function excelSerialToISO(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return String(serial ?? "");
  // Excel's epoch is 1899-12-30 once its phantom 1900 leap day is accounted for.
  return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
}

// Hand-rolled reader for the narrow slice of SpreadsheetML the EDD emits:
// rows of inline or shared-string cells, no formulas we care about.
function readSheetRows(sheetXml, sharedStrings) {
  const rows = [];
  for (const rowXml of sheetXml.split(/<row[ >]/).slice(1)) {
    const cells = [];
    for (const cellXml of rowXml.split(/<c[ >]/).slice(1)) {
      const isShared = /\bt="s"/.test(cellXml);
      const value = cellXml.match(/<v>([^<]*)<\/v>/);
      const inline = cellXml.match(/<is>([\s\S]*?)<\/is>/);
      if (value) {
        cells.push(isShared ? (sharedStrings[Number(value[1])] ?? "") : value[1]);
      } else if (inline) {
        cells.push([...inline[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).join(""));
      } else {
        cells.push("");
      }
    }
    rows.push(cells);
  }
  return rows;
}

function readSharedStrings(xml) {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join("")
  );
}

/**
 * Parse an EDD WARN workbook buffer into normalized filing rows.
 * Column order in "Detailed WARN Report": county, notice, processed,
 * effective, company, layoff/closure, employees, address, industry.
 */
export function parseWarnWorkbook(buf) {
  const sharedStrings = readSharedStrings(
    unzipEntry(buf, "xl/sharedStrings.xml").toString("utf8")
  );
  const workbook = unzipEntry(buf, "xl/workbook.xml").toString("utf8");
  const rels = unzipEntry(buf, "xl/_rels/workbook.xml.rels").toString("utf8");

  const sheetMatch = [...workbook.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)].find(
    ([, name]) => /detailed warn report/i.test(name)
  );
  if (!sheetMatch) throw new Error("workbook has no 'Detailed WARN Report' sheet");
  const target = rels.match(new RegExp(`Id="${sheetMatch[2]}"[^>]*Target="([^"]*)"`));
  if (!target) throw new Error("sheet relationship missing a Target");

  const sheetXml = unzipEntry(buf, `xl/${target[1].replace(/^\/?/, "")}`).toString("utf8");
  const rows = readSheetRows(sheetXml, sharedStrings);

  return rows
    .filter((r) => /County|Parish/i.test(r[0] ?? "") && /^\d+$/.test(String(r[6] ?? "")))
    .map((r) => ({
      county: r[0],
      noticeDate: excelSerialToISO(r[1]),
      processedDate: excelSerialToISO(r[2]),
      effectiveDate: excelSerialToISO(r[3]),
      company: r[4],
      type: r[5],
      employees: Number(r[6]),
      address: (r[7] ?? "").replace(/\s+/g, " ").trim(),
      industry: r[8] ?? "",
    }));
}

export function filterSantaClara(rows) {
  return rows.filter((r) => /^santa clara/i.test(r.county ?? ""));
}

/** Collapse a company's per-building filings — Intel files one row per site. */
export function normalizeCompany(name) {
  return String(name ?? "")
    .replace(/\s*[-(–—].*$/, "")
    .replace(/,?\s+(inc|llc|corporation|corp|co|ltd)\.?$/i, "")
    .trim();
}

export function summarizeByCompany(rows) {
  const byCompany = new Map();
  for (const r of rows) {
    const key = normalizeCompany(r.company);
    const entry = byCompany.get(key) ?? { company: key, employees: 0, filings: 0, dates: [] };
    entry.employees += r.employees;
    entry.filings += 1;
    entry.dates.push(r.noticeDate);
    byCompany.set(key, entry);
  }
  return [...byCompany.values()]
    .map((e) => ({
      company: e.company,
      employees: e.employees,
      filings: e.filings,
      firstNotice: e.dates.slice().sort()[0],
      lastNotice: e.dates.slice().sort().at(-1),
    }))
    .sort((a, b) => b.employees - a.employees);
}

export async function fetchWarnWorkbook(url = XLSX_URL) {
  const res = await fetch(url, {
    headers: { "user-agent": "southbaytoday.org WARN check (stephen@stanwood.dev)" },
  });
  if (!res.ok) throw new Error(`EDD returned ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export { XLSX_URL };
