// Shared JSON cache helpers for generate-*.mjs scripts.
// loadJsonCache returns a default value on missing/malformed files so
// scripts can depend on it without re-implementing try/catch boilerplate.

import { readFileSync, writeFileSync, existsSync } from "fs";

export function loadJsonCache(path, defaultValue = {}) {
  if (!existsSync(path)) return defaultValue;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return defaultValue;
  }
}

export function saveJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}
