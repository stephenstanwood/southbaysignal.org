import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";

import {
  excelSerialToISO,
  filterSantaClara,
  normalizeCompany,
  summarizeByCompany,
  unzipEntry,
} from "./warn-scc.mjs";

// ── ZIP fixture ────────────────────────────────────────────────────────────
// Builds a one-entry archive so the reader is exercised against real bytes
// rather than a mock. `stored` skips deflate to cover the method-0 branch.
function makeZip(name, contents, { stored = false } = {}) {
  const nameBuf = Buffer.from(name, "utf8");
  const raw = Buffer.from(contents, "utf8");
  const data = stored ? raw : deflateRawSync(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(stored ? 0 : 8, 8);
  local.writeUInt32LE(crc32(raw), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(stored ? 0 : 8, 10);
  central.writeUInt32LE(crc32(raw), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset

  const cdOffset = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

test("unzipEntry reads a deflated entry", () => {
  const zip = makeZip("xl/workbook.xml", "<workbook><sheet/></workbook>");
  assert.equal(unzipEntry(zip, "xl/workbook.xml").toString("utf8"), "<workbook><sheet/></workbook>");
});

test("unzipEntry reads a stored entry", () => {
  const zip = makeZip("a.txt", "plain", { stored: true });
  assert.equal(unzipEntry(zip, "a.txt").toString("utf8"), "plain");
});

test("unzipEntry throws on a missing entry", () => {
  const zip = makeZip("a.txt", "plain");
  assert.throws(() => unzipEntry(zip, "b.txt"), /entry not found/);
});

// ── Date handling ──────────────────────────────────────────────────────────
test("excelSerialToISO converts serials without an off-by-one", () => {
  // 45839 is 2025-07-07, the day Intel filed its first FY25-26 Santa Clara round.
  assert.equal(excelSerialToISO(45845), "2025-07-07");
  assert.equal(excelSerialToISO("46203"), "2026-06-30");
});

test("excelSerialToISO leaves non-serial values alone", () => {
  assert.equal(excelSerialToISO("Notice Date"), "Notice Date");
  assert.equal(excelSerialToISO(""), "");
});

// ── Row shaping ────────────────────────────────────────────────────────────
const ROWS = [
  { county: "Santa Clara County", company: "Intel Corporation - SC-12", employees: 67, noticeDate: "2026-07-24" },
  { county: "Santa Clara County", company: "Intel Corporation (Robert Noyce Building)", employees: 24, noticeDate: "2026-07-24" },
  { county: "Santa Clara County", company: "ServiceNow, Inc.", employees: 154, noticeDate: "2026-07-28" },
  { county: "San Mateo County", company: "Genentech, Inc.", employees: 103, noticeDate: "2026-07-15" },
];

test("filterSantaClara keeps only Santa Clara County rows", () => {
  assert.deepEqual(
    filterSantaClara(ROWS).map((r) => r.employees),
    [67, 24, 154]
  );
});

test("normalizeCompany collapses per-building suffixes", () => {
  assert.equal(normalizeCompany("Intel Corporation - SC-12"), "Intel");
  assert.equal(normalizeCompany("Intel Corporation (Robert Noyce Building)"), "Intel");
  assert.equal(normalizeCompany("ServiceNow, Inc."), "ServiceNow");
  assert.equal(normalizeCompany("Applied Materials, Inc. (3050 Bowers Ave)"), "Applied Materials");
});

test("summarizeByCompany rolls per-site filings into one company total", () => {
  const summary = summarizeByCompany(filterSantaClara(ROWS));
  assert.deepEqual(summary, [
    {
      company: "ServiceNow",
      employees: 154,
      filings: 1,
      firstNotice: "2026-07-28",
      lastNotice: "2026-07-28",
    },
    {
      company: "Intel",
      employees: 91,
      filings: 2,
      firstNotice: "2026-07-24",
      lastNotice: "2026-07-24",
    },
  ]);
});
