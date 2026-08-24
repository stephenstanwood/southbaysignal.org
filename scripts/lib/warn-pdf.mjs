// ---------------------------------------------------------------------------
// California EDD WARN report — prior-fiscal-year PDF reader
//
// EDD publishes the current fiscal year as a workbook (scripts/lib/warn-scc.mjs)
// and every prior year back to FY2014-15 as a PDF only. Those PDFs are the only
// machine-checkable record of what a company has filed over time, which is what
// turns a trendNote from "cut N jobs in June" into a trajectory.
//
//   Landing page: https://edd.ca.gov/en/jobs_and_training/layoff_services_warn/
//
// The layout is not stable across years. Column order changes (FY2019-20 runs
// notice/effective/received; everything since runs notice/received/effective),
// FY2014-15 has a City column and no County column at all, and the Address
// column only appears from FY2021-22 on. Line-based text extraction also fails
// outright on some years — FY2017-18 comes out of the text layer column-major,
// with every notice date in one block ahead of any company name.
//
// So this reads glyph positions instead of lines. Items are grouped into rows
// by y, the three date columns are ordered by the x of their header labels, and
// every other field is identified by what it contains rather than where it sits.
// That survives all twelve layouts without a per-year special case.
//
// This is a verification tool, not a data pipeline. Nothing renders from it.
// A WARN filing is a notice, not a headcount: it covers a single site, only
// triggers at scale, and the number filed is what the employer expects to cut.
// Say "cut on WARN filings", never "lost N jobs".
// ---------------------------------------------------------------------------

/**
 * Prior-year reports, newest first. The current fiscal year is not here — it
 * lives as an .xlsx and is read by scripts/lib/warn-scc.mjs.
 */
export const WARN_PDF_YEARS = Object.freeze({
  "2025-26": "warn-report-for-7-1-25-to-6-30-26.pdf",
  "2024-25": "warn-report-for-7-1-2024-to-06-30-2025.pdf",
  "2023-24": "warn-report-for-7-1-2023-to-06-30-2024.pdf",
  "2022-23": "warn-report-for-7-1-2022-to-06-30-2023.pdf",
  "2021-22": "warn-report-for-7-1-2021-to-06-30-2022.pdf",
  "2020-21": "warn-report-for-7-1-2020-to-06-30-2021.pdf",
  "2019-20": "warn-report-for-7-1-2019-to-6-30-2020.pdf",
  "2018-19": "warn-report-for-7-1-2018-to-06-30-2019.pdf",
  "2017-18": "warn-report-for-7-1-2017-to-06-30-2018.pdf",
  "2016-17": "warn-report-for-7-1-2016-to-06-30-2017.pdf",
  "2015-16": "warn-report-for-7-1-2015-to-06-30-2016.pdf",
  "2014-15": "warnreportfor7-1-2014to06-30-2015.pdf",
});

const PDF_BASE = "https://edd.ca.gov/siteassets/files/jobs_and_training/warn/";

export function warnPdfUrl(fiscalYear) {
  const file = WARN_PDF_YEARS[fiscalYear];
  if (!file) {
    throw new Error(
      `unknown fiscal year "${fiscalYear}" — try one of ${Object.keys(WARN_PDF_YEARS).join(", ")}`
    );
  }
  return PDF_BASE + file;
}

// Santa Clara County's fifteen incorporated cities, plus the two unincorporated
// places that show up as a mailing city on filings. Only used for FY2014-15,
// the one report with no County column.
const SCC_CITIES = new Set(
  [
    "san jose",
    "santa clara",
    "sunnyvale",
    "mountain view",
    "palo alto",
    "cupertino",
    "milpitas",
    "campbell",
    "los gatos",
    "saratoga",
    "los altos",
    "los altos hills",
    "monte sereno",
    "morgan hill",
    "gilroy",
    "stanford",
    "alviso",
  ].map((c) => c)
);

export function isSantaClaraCity(city) {
  return SCC_CITIES.has(String(city ?? "").trim().toLowerCase());
}

const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const ACTION_RE = /^(Layoff|Closure)\b\s*(.*)$/i;
// Counts over 999 are printed with a thousands separator.
const EMPLOYEES_RE = /^\d{1,3}(?:,\d{3})+$|^\d{1,6}$/;

/** MM/DD/YYYY as printed → ISO. Returns "" for anything that isn't a date. */
export function usDateToISO(value) {
  const m = String(value ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return "";
  const [, mm, dd, yy] = m;
  const year = yy.length === 2 ? `20${yy}` : yy;
  return `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/**
 * Group positioned glyph runs into visual rows, top of page first.
 * Items within ~2pt of each other vertically belong to the same row; EDD's
 * header labels sit a point or two off from the row they label.
 */
export function groupRows(items, tolerance = 2) {
  const kept = items
    .filter((it) => String(it.str ?? "").trim())
    .map((it) => ({ x: it.x, y: it.y, str: String(it.str).trim() }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const rows = [];
  for (const it of kept) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= tolerance) {
      last.items.push(it);
      last.y = Math.max(last.y, it.y);
    } else {
      rows.push({ y: it.y, items: [it] });
    }
  }
  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  return rows;
}

/**
 * Read the column layout off the header rows: which of the three date columns
 * comes first, and whether this year prints City / County / Address at all.
 * Header rows are everything above the first row that starts with a date.
 */
export function readLayout(rows) {
  const firstData = rows.findIndex((r) => DATE_RE.test(r.items[0]?.str ?? ""));
  const headerRows = firstData === -1 ? rows : rows.slice(0, firstData);
  const labels = headerRows.flatMap((r) => r.items);

  const anchor = (re) => {
    const hits = labels.filter((it) => re.test(it.str));
    return hits.length ? Math.min(...hits.map((it) => it.x)) : null;
  };

  const dates = [
    ["noticeDate", anchor(/^Notice\b/i)],
    ["processedDate", anchor(/^Received\b/i)],
    ["effectiveDate", anchor(/^Effective\b/i)],
  ]
    .filter(([, x]) => x !== null)
    .sort((a, b) => a[1] - b[1]);

  return {
    // FY2019-20 and earlier run notice, effective, received; FY2021-22 on run
    // notice, received, effective. Keep the x of each so a row that prints only
    // two of the three still lands its dates in the right fields.
    dateOrder:
      dates.length === 3
        ? dates.map(([key]) => key)
        : ["noticeDate", "processedDate", "effectiveDate"],
    dateAnchors: dates.length === 3 ? Object.fromEntries(dates) : null,
    hasCity: anchor(/^City$/i) !== null,
    hasCounty: anchor(/^County$/i) !== null,
    hasAddress: anchor(/^Address$/i) !== null,
    cityAnchor: anchor(/^City$/i),
    countyAnchor: anchor(/^County$/i),
  };
}

/**
 * A handful of rows have the layoff/closure word split across two text runs
 * ("C" + "losure Temporary"). Only rebuild when the field is otherwise missing,
 * so a healthy row is never re-cut.
 */
function repairSplitAction(items) {
  if (items.some((it) => ACTION_RE.test(it.str))) return items;
  for (let k = 0; k < items.length - 1; k += 1) {
    const joined = items[k].str + items[k + 1].str;
    if (ACTION_RE.test(joined)) {
      return [...items.slice(0, k), { ...items[k], str: joined }, ...items.slice(k + 2)];
    }
  }
  return items;
}

/**
 * Turn one visual row into a filing. Fields are identified by content, not by
 * column boundaries — the header labels are centered while the data is
 * left-aligned, so x ranges do not line up well enough to slice on.
 * Returns null for headers, page furniture, and continuation lines.
 */
export function parseRow(items, layout) {
  const dates = [];
  let i = 0;
  while (i < items.length && DATE_RE.test(items[i].str)) {
    dates.push(items[i]);
    i += 1;
  }
  if (dates.length < 2) return null;

  const rest = repairSplitAction(items.slice(i));
  const employeesAt = rest.findIndex((it) => EMPLOYEES_RE.test(it.str));
  const actionAt = rest.findIndex((it) => ACTION_RE.test(it.str));
  if (employeesAt === -1 || actionAt === -1 || actionAt < employeesAt) return null;

  // Company / City / County are all free text, and plenty of employers have
  // "County" in their own name (Catholic Charities of Santa Clara County), so
  // these three are separated by which header they sit under, not by content.
  const before = rest.slice(0, employeesAt);
  const nearest = (anchor, from, to) => {
    if (anchor === null || from >= to) return -1;
    let pick = -1;
    let best = Infinity;
    for (let k = from; k < to; k += 1) {
      const d = Math.abs(before[k].x - anchor);
      if (d < best) {
        best = d;
        pick = k;
      }
    }
    return pick;
  };

  const countyAt = layout.hasCounty ? nearest(layout.countyAnchor, 1, before.length) : -1;
  const cityAt = layout.hasCity
    ? nearest(layout.cityAnchor, 1, countyAt === -1 ? before.length : countyAt)
    : -1;
  const nameEnd = Math.min(...[cityAt, countyAt, before.length].filter((n) => n > -1));

  const company = before
    .slice(0, nameEnd)
    .map((it) => it.str)
    .join(" ");
  const city = cityAt === -1 ? "" : before[cityAt].str;

  const [, action, typeInline] = rest[actionAt].str.match(ACTION_RE);
  const trailing = rest.slice(actionAt + 1).map((it) => it.str);
  const type = typeInline || (trailing.length && !layout.hasAddress ? trailing.shift() : "");
  const address = layout.hasAddress ? trailing.join(" ").replace(/\s+/g, " ").trim() : "";

  const record = {
    county: countyAt === -1 ? "" : before[countyAt].str,
    city: city.trim(),
    company: company.replace(/\s+/g, " ").trim(),
    employees: Number(rest[employeesAt].str.replace(/,/g, "")),
    layoffOrClosure: action.replace(/^./, (c) => c.toUpperCase()).toLowerCase(),
    type: type.trim(),
    address,
    industry: "",
  };
  for (const key of layout.dateOrder) record[key] = "";
  if (layout.dateAnchors && dates.length < layout.dateOrder.length) {
    // Fewer dates than columns: place each under the header it sits closest to
    // rather than assuming the missing one is the last.
    for (const d of dates) {
      let pick = layout.dateOrder[0];
      let best = Infinity;
      for (const [key, x] of Object.entries(layout.dateAnchors)) {
        const gap = Math.abs(d.x - x);
        if (gap < best) {
          best = gap;
          pick = key;
        }
      }
      if (!record[pick]) record[pick] = usDateToISO(d.str);
    }
  } else {
    for (const [k, key] of layout.dateOrder.entries()) record[key] = usDateToISO(dates[k]?.str ?? "");
  }
  record.noticeDate ??= "";
  record.processedDate ??= "";
  record.effectiveDate ??= "";
  if (!record.company) return null;
  return record;
}

/**
 * Parse every page's positioned items into filings.
 * `pages` is an array of arrays of `{ x, y, str }`.
 *
 * `onSkip` is called with any row that opens with a date but could not be read
 * — almost always a filing EDD published with no employee count. Callers should
 * report the count rather than let filings vanish quietly.
 */
export function parseWarnPages(pages, { onSkip } = {}) {
  const allRows = pages.map((items) => groupRows(items));
  const layout = readLayout(allRows.flat().slice(0, 40));
  const out = [];
  for (const rows of allRows) {
    for (const row of rows) {
      const record = parseRow(row.items, layout);
      if (record) out.push(record);
      else if (onSkip && DATE_RE.test(row.items[0]?.str ?? "")) onSkip(row);
    }
  }
  return out;
}

/** Extract positioned text items from a PDF buffer, page by page. */
export async function readPdfPages(buf) {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .filter((it) => typeof it.str === "string")
        .map((it) => ({ x: it.transform[4], y: it.transform[5], str: it.str }))
    );
  }
  return pages;
}

export async function parseWarnPdf(buf, options) {
  return parseWarnPages(await readPdfPages(buf), options);
}

export async function fetchWarnPdf(fiscalYear) {
  const url = warnPdfUrl(fiscalYear);
  const res = await fetch(url, {
    headers: { "user-agent": "southbaytoday.org WARN check (stephen@stanwood.dev)" },
  });
  if (!res.ok) throw new Error(`EDD returned ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
