#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { loadEnvLocal } from "../lib/env.mjs";
import { writeJsonAtomic } from "../lib/io.mjs";
import { catSignal } from "../lib/notify.mjs";
import {
  DEFAULT_REPO_ROOT,
  preflightNewsletterCheckout,
} from "../newsletter/scheduled-preflight.mjs";
import {
  hasRecentSuccessfulRefresh,
  RETRY_SLOT_SUPPRESSION_HOURS,
} from "./refresh-schedule.mjs";

const PREFIX = "[events-scheduled]";
const LOCK_TASK = "events-refresh";
const DEFAULT_LOCK_SCRIPT = join(
  homedir(),
  ".claude",
  "scheduled-tasks",
  "lib",
  "repo-lock.sh",
);
const DEFAULT_STATE_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "SouthBayToday",
  "events-refresh-state.json",
);

function log(message) {
  console.log(`${PREFIX} ${new Date().toISOString()} ${message}`);
}

function run(command, args, {
  cwd,
  env = process.env,
  allowStatuses = [0],
  timeout = 30 * 60_000,
} = {}) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", timeout });
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
  if (!allowStatuses.includes(result.status)) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}${result.signal ? ` (${result.signal})` : ""}`);
  }
  return result;
}

function runGit(repoRoot, args, options = {}) {
  return run("git", ["-C", repoRoot, ...args], options);
}

function readState(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

function recentlySucceeded(path) {
  return hasRecentSuccessfulRefresh({ lastSuccessAt: readState(path).lastSuccessAt });
}

// Set when this run took the lock away from a crashed prior holder. That job
// may have left its half-written generated data behind, which is what the
// preflight then refuses. The 2026-08-17 alert listed 20 modified files and
// never named the crash that made them, so the dirty tree read as an events
// bug for an hour. Remember the holder and say so instead.
let stolenLockHolder = null;

function runRepoLock(script, action, { allowBusy = false } = {}) {
  const result = spawnSync(script, [action, LOCK_TASK], { encoding: "utf8" });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (output) process.stdout.write(output);
  const stolen = output.match(/stealing stale lock from '([^']+)'/);
  if (stolen) stolenLockHolder = stolen[1];
  if (result.error) throw new Error(`repo lock ${action} failed: ${result.error.message}`);
  if (allowBusy && result.status === 1) return false;
  if (result.status !== 0) throw new Error(`repo lock ${action} failed with exit ${result.status}`);
  return true;
}

/** Name the crashed prior lock holder on the guard it actually tripped. */
function annotateDirtyCheckout(message) {
  if (!stolenLockHolder || !/tracked changes/.test(message)) return message;
  return `${message}\n\n(prior lock holder '${stolenLockHolder}' crashed and its stale`
    + " lock was stolen by this run; the changes above are most likely its"
    + " abandoned output. Confirm they are generated data, then restore them"
    + " in the scheduled checkout.)";
}

function refreshLock(script) {
  runRepoLock(script, "refresh");
}

function runNode(repoRoot, relativePath, lockScript, timeout) {
  log(`running ${relativePath}`);
  run(process.execPath, [join(repoRoot, relativePath)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SBT_STRICT_EVENT_REFRESH: "1",
      SBT_EVENT_SNAPSHOT_MAX_AGE_HOURS: "2",
    },
    timeout,
  });
  refreshLock(lockScript);
}

function ensureWatchdogAgent(repoRoot) {
  if (process.platform !== "darwin" || process.env.SBT_SKIP_AGENT_ENSURE === "1") return;
  run(
    "/bin/bash",
    [join(repoRoot, "scripts", "events", "install-mini-refresh.sh"), "--watchdog-only"],
    { cwd: repoRoot, timeout: 60_000 },
  );
}

function commitGeneratedData(repoRoot) {
  runGit(repoRoot, ["add", "--", "src/data/south-bay"]);
  const diff = spawnSync("git", ["-C", repoRoot, "diff", "--cached", "--quiet"]);
  if (diff.error) throw new Error(`git diff failed: ${diff.error.message}`);
  if (diff.status === 0) {
    log("no generated-data changes to commit");
    return false;
  }
  if (diff.status !== 1) throw new Error(`git diff --cached exited ${diff.status}`);

  const stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date()).replace(",", "");
  runGit(repoRoot, ["commit", "-m", `chore: refresh event sources ${stamp} PT`]);
  return true;
}

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const preflightOnly = args.has("--preflight-only");
const repoRoot = process.env.SBT_EVENTS_REPO_ROOT || DEFAULT_REPO_ROOT;
const lockScript = process.env.SBT_REPO_LOCK_SCRIPT || DEFAULT_LOCK_SCRIPT;
const statePath = process.env.SBT_EVENTS_REFRESH_STATE || DEFAULT_STATE_PATH;

loadEnvLocal(join(repoRoot, ".env.local"));

try {
  ensureWatchdogAgent(repoRoot);
} catch (error) {
  console.error(`${PREFIX} ${new Date().toISOString()} BLOCKED: ${error.message}`);
  await catSignal({
    key: "events-refresh-watchdog-install",
    title: "Event refresh watchdog could not be restored",
    body: error.message,
  });
  process.exit(1);
}

if (!force && !preflightOnly && recentlySucceeded(statePath)) {
  log(
    `last successful Mini refresh is under ${RETRY_SLOT_SUPPRESSION_HOURS}h old;`
    + " retry slot is a no-op",
  );
  process.exit(0);
}

let lockHeld = false;
let generated = false;
let primaryError = null;
try {
  if (!existsSync(lockScript)) throw new Error(`required SBT repo lock is missing: ${lockScript}`);
  lockHeld = runRepoLock(lockScript, "acquire", { allowBusy: true });
  if (!lockHeld) {
    log("shared repo lock is busy; deferring to the next launchd retry slot");
    process.exitCode = 0;
  } else {
    log(`acquired shared repo lock (${LOCK_TASK})`);
    const before = preflightNewsletterCheckout({ repoRoot, log: console.log });
    if (preflightOnly) {
      log(`preflight-only complete at ${before.head.slice(0, 12)}`);
    } else {
      generated = true;
      runNode(repoRoot, "scripts/playwright-scrapers.mjs", lockScript, 40 * 60_000);
      runNode(repoRoot, "scripts/pull-inbound-events.mjs", lockScript, 10 * 60_000);
      runNode(repoRoot, "scripts/generate-events.mjs", lockScript, 45 * 60_000);
      // Audit before commit: a hard virtual-not-flagged finding means an
      // online-only event would ship with a venue, a city and a map link, so
      // it fails the run into the rollback path below instead of landing in a
      // report nobody opens (the 2026-08-05 CRC newsletter error).
      runNode(repoRoot, "scripts/audit-events.mjs", lockScript, 5 * 60_000);
      commitGeneratedData(repoRoot);

      // Re-fetch after the long scrape. Data-only local commits can safely
      // absorb a newer origin/main; source-ahead or dirty states fail closed.
      const after = preflightNewsletterCheckout({ repoRoot, log: console.log });
      runGit(repoRoot, ["push", "origin", "main"], { timeout: 5 * 60_000 });
      writeJsonAtomic(statePath, {
        lastSuccessAt: new Date().toISOString(),
        head: after.head,
        sourceHead: before.originHead,
      });
      log(`refresh pushed successfully at HEAD=${after.head.slice(0, 12)}`);
    }
  }
} catch (error) {
  primaryError = error;
  const blockedMessage = annotateDirtyCheckout(error.message);
  console.error(`${PREFIX} ${new Date().toISOString()} BLOCKED: ${blockedMessage}`);
  if (generated) {
    // The checkout was proven clean while the lock was held. Roll back only
    // uncommitted generated JSON so a failed run cannot wedge every later job.
    try {
      runGit(repoRoot, ["restore", "--staged", "--worktree", "--", "src/data/south-bay"]);
      log("restored uncommitted generated data after failure");
    } catch (restoreError) {
      console.error(`${PREFIX} rollback failed: ${restoreError.message}`);
    }
  }
  await catSignal({
    key: "events-scheduled-refresh",
    title: "Scheduled event refresh failed",
    body: blockedMessage,
  });
  process.exitCode = 1;
} finally {
  if (lockHeld) {
    try {
      runRepoLock(lockScript, "release");
      log(`released shared repo lock (${LOCK_TASK})`);
    } catch (error) {
      console.error(`${PREFIX} repo lock release failed: ${error.message}`);
      if (!primaryError) process.exitCode = 1;
    }
  }
}
