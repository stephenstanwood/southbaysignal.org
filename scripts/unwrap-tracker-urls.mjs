#!/usr/bin/env node
/**
 * unwrap-tracker-urls.mjs — backfill resolution of email-newsletter tracker
 * URLs in inbound-events.json and upcoming-events.json.
 *
 * Flow:
 *  1. Walk inbound-events.json events[*].sourceUrl — for each tracker URL,
 *     follow the redirect chain, store the resolved URL on the event, and
 *     stash the original under sourceUrlOriginal.
 *  2. Walk upcoming-events.json events[*].url — same treatment. Inbound
 *     events show up here as `event.url = e.sourceUrl`, so this catches
 *     anything generate-events already merged.
 *  3. Walk events-archive.json events[*].url — past events keep rendering on
 *     archive views, and a tracker URL that slipped through before this
 *     script ran would otherwise stay wrapped there forever.
 *  4. Write the files back. Cache lives in url-unwrap-cache.json — re-runs
 *     only fetch new tracker URLs.
 *
 * Usage:  node scripts/unwrap-tracker-urls.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./lib/io.mjs";
import { unwrapMany, isTrackerUrl } from "../src/lib/south-bay/unwrapTrackerUrl.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const INBOUND = join(REPO_ROOT, "src", "data", "south-bay", "inbound-events.json");
const UPCOMING = join(REPO_ROOT, "src", "data", "south-bay", "upcoming-events.json");
const ARCHIVE = join(REPO_ROOT, "src", "data", "south-bay", "events-archive.json");

function loadJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileAtomic(path, JSON.stringify(data, null, 2) + "\n");
}

async function processInbound() {
  const data = loadJson(INBOUND);
  if (!data?.events?.length) {
    console.log("inbound: no events file");
    return;
  }
  const tracker = data.events
    .map((e) => e.sourceUrl)
    .filter((u) => u && isTrackerUrl(u));
  console.log(`inbound: ${data.events.length} events, ${tracker.length} tracker URLs`);
  if (!tracker.length) return;

  const resolved = await unwrapMany(tracker, { verbose: true });
  let changed = 0;
  for (const e of data.events) {
    if (!e.sourceUrl || !resolved.has(e.sourceUrl)) continue;
    const final = resolved.get(e.sourceUrl);
    if (final && final !== e.sourceUrl) {
      e.sourceUrlOriginal = e.sourceUrl;
      e.sourceUrl = final;
      changed++;
    }
  }
  if (changed) {
    writeJson(INBOUND, data);
    console.log(`inbound: rewrote ${changed} event URLs`);
  }
}

async function processUpcoming() {
  const data = loadJson(UPCOMING);
  if (!data?.events?.length) {
    console.log("upcoming: no events file");
    return;
  }
  const tracker = data.events
    .map((e) => e.url)
    .filter((u) => u && isTrackerUrl(u));
  console.log(`upcoming: ${data.events.length} events, ${tracker.length} tracker URLs`);
  if (!tracker.length) return;

  const resolved = await unwrapMany(tracker, { verbose: true });
  let changed = 0;
  for (const e of data.events) {
    if (!e.url || !resolved.has(e.url)) continue;
    const final = resolved.get(e.url);
    if (final && final !== e.url) {
      e.urlOriginal = e.url;
      e.url = final;
      changed++;
    }
  }
  if (changed) {
    writeJson(UPCOMING, data);
    console.log(`upcoming: rewrote ${changed} event URLs`);
  }
}

async function processArchive() {
  const data = loadJson(ARCHIVE);
  if (!data?.events?.length) {
    console.log("archive: no events file");
    return;
  }
  const tracker = data.events
    .map((e) => e.url)
    .filter((u) => u && isTrackerUrl(u));
  console.log(`archive: ${data.events.length} events, ${tracker.length} tracker URLs`);
  if (!tracker.length) return;

  const resolved = await unwrapMany(tracker, { verbose: true });
  let changed = 0;
  for (const e of data.events) {
    if (!e.url || !resolved.has(e.url)) continue;
    const final = resolved.get(e.url);
    if (final && final !== e.url) {
      e.urlOriginal = e.url;
      e.url = final;
      changed++;
    }
  }
  if (changed) {
    writeJson(ARCHIVE, data);
    console.log(`archive: rewrote ${changed} event URLs`);
  }
}

await processInbound();
await processUpcoming();
await processArchive();
console.log("done.");
