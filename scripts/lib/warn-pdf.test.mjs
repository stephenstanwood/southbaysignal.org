import test from "node:test";
import assert from "node:assert/strict";

import {
  WARN_PDF_YEARS,
  groupRows,
  isSantaClaraCity,
  parseWarnPages,
  readLayout,
  usDateToISO,
  warnPdfUrl,
} from "./warn-pdf.mjs";

// ---------------------------------------------------------------------------
// The fixtures below are glyph positions copied off real EDD reports, one per
// distinct layout. EDD has reshuffled this table four times in twelve years, so
// each fixture is a regression guard for a specific way the columns can move.
// ---------------------------------------------------------------------------

const row = (y, pairs) => pairs.map(([x, str]) => ({ x, y, str }));

// FY2025-26: notice / received / effective, County, Address, no City.
const FY2025 = [
  ...row(600, [
    [23, "Notice Date"],
    [56, "Received Date"],
    [93, "Effective Date"],
    [222, "Company"],
    [358, "County"],
    [397, "No. Of Employees"],
    [453, "Layoff/Closure Type"],
  ]),
  ...row(599, [[595, "Address"]]),
  ...row(593, [
    [25, "07/01/2025"],
    [62, "07/02/2025"],
    [98, "09/02/2025"],
    [127, "Republic National Distributing Company"],
    [341, "Santa Clara County"],
    [435, "156"],
    [444, "Closure Permanent"],
    [509, "850 Jarvis Dr Morgan Hill CA 95037"],
  ]),
  ...row(586, [
    [25, "07/31/2025"],
    [62, "07/31/2025"],
    [98, "09/30/2025"],
    [127, "Stanford University"],
    [341, "Santa Clara County"],
    [435, "363"],
    [444, "Layoff Permanent"],
    [509, "450 Jane Stanford Way Stanford CA 94305"],
  ]),
  ...row(578, [
    [25, "06/30/2025"],
    [62, "07/01/2025"],
    [98, "09/02/2025"],
    [127, "Ford Design Studio"],
    [341, "Orange County"],
    [435, "263"],
    [444, "Closure Permanent"],
    [509, "3 Glen Bell Way Irvine CA 92618"],
  ]),
];

// FY2019-20: notice / EFFECTIVE / received, plus a City column.
const FY2019 = [
  ...row(700, [
    [38, "Notice Date"],
    [103, "Effective Date"],
    [163, "Received Date"],
    [293, "Company"],
    [441, "City"],
    [512, "County"],
    [574, "Employees"],
    [660, "Layoff/Closure"],
  ]),
  ...row(688, [
    [35, "06/29/2020"],
    [95, "08/29/2020"],
    [155, "06/30/2020"],
    [217, "Nitto, Inc."],
    [414, "San Jose"],
    [489, "Santa Clara County"],
    [571, "3"],
    [628, "Closure Permanent"],
  ]),
];

// FY2014-15: no County column at all — Santa Clara has to come from the city.
const FY2014 = [
  ...row(505, [
    [42, "Notice Date"],
    [117, "Effective"],
    [184, "Received"],
    [309, "Company"],
    [461, "City"],
    [542, "No. Of"],
    [640, "Layoff/Closure"],
  ]),
  ...row(491, [
    [127, "Date"],
    [195, "Date"],
    [531, "Employees"],
  ]),
  ...row(478, [
    [39, "06/30/2014"],
    [107, "06/18/2014"],
    [174, "07/01/2014"],
    [242, "Symantec Corporation"],
    [426, "Mountain View"],
    [518, "51"],
    [601, "Layoff Permanent"],
  ]),
];

test("reads the FY2025-26 layout: notice/received/effective, address, no city", () => {
  const layout = readLayout(groupRows(FY2025));
  assert.deepEqual(layout.dateOrder, ["noticeDate", "processedDate", "effectiveDate"]);
  assert.equal(layout.hasCounty, true);
  assert.equal(layout.hasAddress, true);
  assert.equal(layout.hasCity, false);

  const rows = parseWarnPages([FY2025]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    county: "Santa Clara County",
    city: "",
    company: "Republic National Distributing Company",
    employees: 156,
    layoffOrClosure: "closure",
    type: "Permanent",
    address: "850 Jarvis Dr Morgan Hill CA 95037",
    industry: "",
    noticeDate: "2025-07-01",
    processedDate: "2025-07-02",
    effectiveDate: "2025-09-02",
  });
});

test("FY2019-20 puts effective before received — dates must not be read positionally", () => {
  const layout = readLayout(groupRows(FY2019));
  assert.deepEqual(layout.dateOrder, ["noticeDate", "effectiveDate", "processedDate"]);

  const [filing] = parseWarnPages([FY2019]);
  assert.equal(filing.noticeDate, "2020-06-29");
  assert.equal(filing.effectiveDate, "2020-08-29");
  assert.equal(filing.processedDate, "2020-06-30");
  assert.equal(filing.city, "San Jose");
  assert.equal(filing.company, "Nitto, Inc.");
});

test("FY2014-15 has no county column, so Santa Clara comes from the city", () => {
  const layout = readLayout(groupRows(FY2014));
  assert.equal(layout.hasCounty, false);
  assert.equal(layout.hasCity, true);

  const [filing] = parseWarnPages([FY2014]);
  assert.equal(filing.county, "");
  assert.equal(filing.city, "Mountain View");
  assert.equal(filing.company, "Symantec Corporation");
  assert.equal(filing.employees, 51);
  assert.equal(isSantaClaraCity(filing.city), true);
  assert.equal(isSantaClaraCity("Oakland"), false);
});

test("an employer with County in its own name keeps its full name", () => {
  const page = [
    ...FY2025.slice(0, 8),
    ...row(560, [
      [25, "04/30/2024"],
      [62, "05/09/2024"],
      [98, "06/30/2024"],
      [127, "Catholic Charities of Santa Clara County"],
      [341, "Santa Clara County"],
      [435, "3"],
      [444, "Layoff Permanent"],
      [509, "645 Wool Creek Drive San Jose CA 95112"],
    ]),
  ];
  const [filing] = parseWarnPages([page]);
  assert.equal(filing.company, "Catholic Charities of Santa Clara County");
  assert.equal(filing.county, "Santa Clara County");
  assert.equal(filing.employees, 3);
});

test("counts over 999 print with a thousands separator", () => {
  const page = [
    ...FY2025.slice(0, 8),
    ...row(560, [
      [25, "11/27/2023"],
      [62, "01/03/2024"],
      [98, "01/26/2024"],
      [127, "Broadcom Inc."],
      [341, "Santa Clara County"],
      [430, "1,267"],
      [444, "Layoff Permanent"],
      [509, "3401 Hillview Ave Palo Alto CA 94304"],
    ]),
  ];
  const [filing] = parseWarnPages([page]);
  assert.equal(filing.employees, 1267);
});

test("a layoff/closure word split across two text runs still reads", () => {
  const page = [
    ...FY2025.slice(0, 8),
    ...row(560, [
      [25, "09/29/2020"],
      [62, "09/30/2020"],
      [98, "12/04/2020"],
      [127, "Adient US LLC"],
      [341, "Santa Clara County"],
      [435, "167"],
      [444, "C"],
      [450, "losure Permanent"],
    ]),
  ];
  const [filing] = parseWarnPages([page]);
  assert.equal(filing.layoffOrClosure, "closure");
  assert.equal(filing.employees, 167);
});

test("a row printing only two of three dates lands them under the right headers", () => {
  const page = [
    ...FY2019.slice(0, 8),
    ...row(660, [
      [35, "08/17/2020"],
      [155, "09/10/2020"],
      [217, "JC Resorts LLC"],
      [414, "La Jolla"],
      [489, "San Diego County"],
      [571, "17"],
      [628, "Layoff Permanent"],
    ]),
  ];
  const [filing] = parseWarnPages([page]);
  assert.equal(filing.noticeDate, "2020-08-17");
  assert.equal(filing.processedDate, "2020-09-10");
  assert.equal(filing.effectiveDate, "");
});

test("a filing published without an employee count is skipped, not guessed at", () => {
  const skipped = [];
  const page = [
    ...FY2019.slice(0, 8),
    ...row(660, [
      [35, "05/08/2020"],
      [95, "07/17/2020"],
      [155, "05/23/2020"],
      [217, "Allergan plc"],
      [414, "Irvine"],
      [489, "Orange County"],
      [628, "Layoff Temporary"],
    ]),
  ];
  const rows = parseWarnPages([page], { onSkip: (r) => skipped.push(r) });
  assert.equal(rows.length, 0);
  assert.equal(skipped.length, 1);
});

test("headers and page furniture never become filings", () => {
  const page = [
    ...row(720, [[349, "WARN Report"]]),
    ...row(707, [[328, "Summary by Received Date"]]),
    ...row(694, [[339, "07/01/2025 - 06/30/2026"]]),
    ...FY2025,
  ];
  assert.equal(parseWarnPages([page]).length, 3);
});

test("usDateToISO normalizes printed dates and rejects everything else", () => {
  assert.equal(usDateToISO("7/1/2025"), "2025-07-01");
  assert.equal(usDateToISO("07/01/25"), "2025-07-01");
  assert.equal(usDateToISO("Santa Clara"), "");
  assert.equal(usDateToISO(undefined), "");
});

test("warnPdfUrl covers every published fiscal year and rejects unknown ones", () => {
  assert.equal(Object.keys(WARN_PDF_YEARS).length, 12);
  assert.match(warnPdfUrl("2023-24"), /^https:\/\/edd\.ca\.gov\/.*\.pdf$/);
  assert.throws(() => warnPdfUrl("2013-14"), /unknown fiscal year/);
});
