/**
 * Inbound events storage — Vercel Blob in prod, filesystem in local dev.
 *
 * Same trick as Stoa: if BLOB_READ_WRITE_TOKEN is set, use blob. Otherwise
 * fall back to a local JSON file so dev works without any platform plumbing.
 *
 * Two stores:
 *   - inbound-events.json  — the full extracted-event list (append-only for now)
 *   - inbound-intake-log.json — dedup/audit log keyed by hash(from+subject+messageId)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { put, head } from "@vercel/blob";
import type { InboundEvent, InboundIntakeLog } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function dataPath(name: string): string {
  return join(__dirname, "../../../src/data/south-bay", name);
}

const EVENTS_PATH = dataPath("inbound-events.json");
const LOG_PATH = dataPath("inbound-intake-log.json");

const EVENTS_BLOB_KEY = "lookout/inbound-events.json";
const LOG_BLOB_KEY = "lookout/inbound-intake-log.json";

function getBlobToken(): string | null {
  const fromProcess = typeof process !== "undefined" ? process.env?.BLOB_READ_WRITE_TOKEN : undefined;
  const fromImport = typeof import.meta !== "undefined" ? (import.meta as ImportMeta).env?.BLOB_READ_WRITE_TOKEN : undefined;
  return (fromProcess ?? fromImport) || null;
}

function hasBlobToken(): boolean {
  return !!getBlobToken();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function readInboundEvents(): Promise<InboundEvent[]> {
  if (hasBlobToken()) {
    const raw = await readBlobJson(EVENTS_BLOB_KEY);
    if (raw === null) return [];
    try {
      return JSON.parse(raw) as InboundEvent[];
    } catch {
      return [];
    }
  }
  if (!existsSync(EVENTS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(EVENTS_PATH, "utf-8")) as InboundEvent[];
  } catch {
    return [];
  }
}

export async function writeInboundEvents(events: InboundEvent[]): Promise<void> {
  const json = JSON.stringify(events, null, 2);
  if (hasBlobToken()) {
    await writeBlobJson(EVENTS_BLOB_KEY, json);
    return;
  }
  ensureDir(EVENTS_PATH);
  writeFileSync(EVENTS_PATH, json);
}

export async function readIntakeLog(): Promise<InboundIntakeLog[]> {
  if (hasBlobToken()) {
    const raw = await readBlobJson(LOG_BLOB_KEY);
    if (raw === null) return [];
    try {
      return JSON.parse(raw) as InboundIntakeLog[];
    } catch {
      return [];
    }
  }
  if (!existsSync(LOG_PATH)) return [];
  try {
    return JSON.parse(readFileSync(LOG_PATH, "utf-8")) as InboundIntakeLog[];
  } catch {
    return [];
  }
}

export async function writeIntakeLog(log: InboundIntakeLog[]): Promise<void> {
  const json = JSON.stringify(log, null, 2);
  if (hasBlobToken()) {
    await writeBlobJson(LOG_BLOB_KEY, json);
    return;
  }
  ensureDir(LOG_PATH);
  writeFileSync(LOG_PATH, json);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateInboundEventId(): string {
  return `inbound_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function dedupHashFor(from: string, subject: string, messageId: string): string {
  return createHash("sha1").update(`${from}|${subject}|${messageId}`).digest("hex").slice(0, 16);
}

async function readBlobJson(pathname: string): Promise<string | null> {
  const token = getBlobToken();
  if (!token) return null;
  try {
    const meta = await head(pathname, { token });
    if (!meta?.url) return null;
    const res = await fetch(`${meta.url}?_cb=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return await res.text();
  } catch (err) {
    if ((err as Error).name === "BlobNotFoundError") return null;
    if (/404|not.found/i.test((err as Error).message)) return null;
    throw err;
  }
}

async function writeBlobJson(pathname: string, json: string): Promise<void> {
  const token = getBlobToken();
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN not available");
  await put(pathname, json, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    token,
    cacheControlMaxAge: 0,
  });
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
