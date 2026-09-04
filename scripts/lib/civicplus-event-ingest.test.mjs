import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchCampbellEvents,
  fetchLosAltosHistoryEvents,
} from "../generate-events.mjs";

const dayPT = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });

const civicDate = (iso) => new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "America/Los_Angeles",
}).format(new Date(`${iso}T12:00:00-07:00`));

const icalDate = (iso) => iso.replaceAll("-", "");

async function withFetchRoutes(routes, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = String(url);
    const body = routes[key];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

test("Campbell enriches sparse RSS rows from the official occurrence page", async () => {
  const date = dayPT(10);
  const eventUrl = "https://www.campbellca.gov/Calendar.aspx?EID=3968";
  const rssUrl = "https://www.campbellca.gov/RSSFeed.aspx?ModID=58&CID=14-Community-Event-Calendar";
  const rss = `
    <rss><channel><item>
      <title><![CDATA[Jack Wright's National Touring Tribute Presents: Neil Diamond Superstar]]></title>
      <link>${eventUrl}</link>
      <description><![CDATA[Jack Wright brings his Neil Diamond tribute to Campbell.]]></description>
      <calendarEvent:EventDates>${civicDate(date)}</calendarEvent:EventDates>
      <calendarEvent:EventTimes>07:30 PM - 09:30 PM</calendarEvent:EventTimes>
      <calendarEvent:Location></calendarEvent:Location>
    </item></channel></rss>
  `;
  const detail = `
    <span itemprop="startDate">${date}T19:30:00</span>
    <div class="specificDetailHeader">Time:</div>
    <div class="specificDetailItem">7:30 PM&thinsp;-&thinsp;9:30 PM</div>
    <div id="ctl00_MainContent_ModuleContent_ctl00_ctl04_location_name">
      <div itemprop="name">The Heritage Theatre</div>
    </div>
    <span itemprop="streetAddress">1 W Campbell Ave</span>
    <span itemprop="addressLocality">Campbell</span>
    <span itemprop="addressRegion">CA</span>
    <span itemprop="postalCode">95008</span>
    <div itemprop="price">$30.50/$43.50/$55.50 + fees</div>
  `;

  const events = await withFetchRoutes({ [rssUrl]: rss, [eventUrl]: detail }, () => fetchCampbellEvents());
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    ...events[0],
    date,
    time: "7:30 PM",
    endTime: "9:30 PM",
    venue: "Heritage Theatre",
    address: "1 W Campbell Ave, Campbell, CA 95008",
    cost: "paid",
    costNote: "From $30.50",
    url: eventUrl,
  });
  assert.equal(events[0].occurrenceEvidence.kind, "first-party-occurrence-page");
  assert.equal(events[0].occurrenceEvidence.sourceUrl, eventUrl);
  assert.equal(events[0].occurrenceEvidence.date, date);
});

test("Los Altos History Museum prices open tours and drops closed sessions before truncation", async () => {
  const openDate = dayPT(10);
  const closedDate = dayPT(11);
  const feedUrl = "https://www.losaltoshistory.org/events/?ical=1";
  const feed = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:open-tour
DTSTART:${icalDate(openDate)}T110000
DTEND:${icalDate(openDate)}T120000
SUMMARY:Curator-led Tour: Making Connections
LOCATION:Los Altos History Museum
DESCRIPTION:Learn about the exhibition. Cost: $15 per person\\; $10 for Museum members.
URL:https://www.losaltoshistory.org/event/open-tour/
END:VEVENT
BEGIN:VEVENT
UID:closed-tour
DTSTART:${icalDate(closedDate)}T110000
DTEND:${icalDate(closedDate)}T120000
SUMMARY:Curator-led Tour: Making Connections
LOCATION:Los Altos History Museum
DESCRIPTION:${"Background details. ".repeat(30)}Cost: $15 per person\\; $10 for Museum members. This session is closed.
URL:https://www.losaltoshistory.org/event/closed-tour/
END:VEVENT
END:VCALENDAR`;

  const events = await withFetchRoutes({ [feedUrl]: feed }, () => fetchLosAltosHistoryEvents());
  assert.equal(events.length, 1);
  assert.equal(events[0].date, openDate);
  assert.equal(events[0].cost, "low");
  assert.equal(events[0].costNote, "$15; $10 members");
  assert.equal(events[0].url, "https://www.losaltoshistory.org/event/open-tour/");
});
