#!/usr/bin/env node
// Build-time guardrail: the Home tab (SouthBayTodayView.tsx) is hand-curated.
// Autonomous Builder sessions keep adding teaser components ("just-opened",
// "city hall this week", etc). This check fails the build if anything outside
// the allowlist is imported into SouthBayTodayView, so the violation is caught
// before it ships.
//
// To intentionally add a new home-tab section, update ALLOWED_LOCAL_IMPORTS
// below in the same commit. That commit needs human approval (Stephen) — see
// CLAUDE.md "Home tab is curated".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME_FILE = resolve(__dirname, "../src/components/south-bay/homepage/SouthBayTodayView.tsx");

const ALLOWED_LOCAL_IMPORTS = new Set([
  "./PhotoStrip",
  "./RedditPulseTeaser",
]);

const src = readFileSync(HOME_FILE, "utf8");

const importRe = /^import\s+(?:[\s\S]*?)\s+from\s+["']([^"']+)["'];?\s*$/gm;
const localImports = new Set();
for (const m of src.matchAll(importRe)) {
  const spec = m[1];
  if (spec.startsWith("./")) localImports.add(spec);
}

const unauthorized = [...localImports].filter((s) => !ALLOWED_LOCAL_IMPORTS.has(s));

if (unauthorized.length > 0) {
  console.error("");
  console.error("=====================================================================");
  console.error("HOME-TAB-LOCKED guardrail FAILED");
  console.error("=====================================================================");
  console.error("");
  console.error("SouthBayTodayView.tsx imported components not on the allowlist:");
  for (const u of unauthorized) console.error(`  - ${u}`);
  console.error("");
  console.error("The Home tab is hand-curated. Do not add teasers, callouts, strips,");
  console.error("or cards without explicit Stephen approval (see CLAUDE.md).");
  console.error("");
  console.error("If this addition was approved, update ALLOWED_LOCAL_IMPORTS in");
  console.error("scripts/check-home-locked.mjs in the same commit.");
  console.error("=====================================================================");
  console.error("");
  process.exit(1);
}

console.log(`check-home-locked: OK (${localImports.size} local imports, all allowed)`);
