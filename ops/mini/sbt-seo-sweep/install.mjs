#!/usr/bin/env node
// Register the repo-owned task in the Mini Codex app's native automation store
// and retire the superseded launchd/Claude runner. The automation_update tool
// is host-local, so a MacBook session cannot use it against the Mini.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const home = homedir();
const sourceDir = dirname(fileURLToPath(import.meta.url));
const config = {
  id: "sbt-seo-sweep",
  name: "SBT weekly SEO",
  cwd: join(home, "Projects/southbaytoday.org"),
  skillRelativePath: "ops/mini/sbt-seo-sweep/SKILL.md",
  promptFile: join(sourceDir, "PROMPT.md"),
  rrule: "RRULE:FREQ=WEEKLY;BYDAY=TU;BYHOUR=1;BYMINUTE=15;BYSECOND=0",
  weekday: 2,
  hour: 1,
  minute: 15,
  model: "gpt-5.6-sol",
  reasoningEffort: "max",
  executionEnvironment: "local",
  retiredLaunchAgent: "org.southbaytoday.seo-sweep",
  retiredClaudeDir: join(home, ".claude/scheduled-tasks/sbt-seo-sweep"),
};

if (process.argv.includes("--help")) {
  console.log("Usage: node install.mjs [--smoke | --check]");
  process.exit(0);
}
const unknownArguments = process.argv.slice(2).filter((argument) => !["--smoke", "--check"].includes(argument));
if (unknownArguments.length > 0) {
  console.error(`Unknown argument: ${unknownArguments.join(", ")}`);
  process.exit(64);
}

function fail(message) {
  console.error(`sbt-seo-sweep install: ${message}`);
  process.exit(1);
}

function readGlobalState() {
  const path = join(home, ".codex/.codex-global-state.json");
  if (!existsSync(path)) fail(`missing ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveProjectId() {
  const projects = Object.values(readGlobalState()["local-projects"] ?? {});
  const exact = projects.find((project) => project.rootPaths?.includes(config.cwd));
  if (exact) return exact.id;

  const ancestors = projects
    .flatMap((project) =>
      (project.rootPaths ?? []).map((root) => ({ project, root })),
    )
    .filter(({ root }) => {
      const remainder = relative(root, config.cwd);
      return remainder === "" || (!remainder.startsWith("..") && !remainder.startsWith("/"));
    })
    .sort((a, b) => b.root.length - a.root.length);
  if (ancestors[0]) return ancestors[0].project.id;
  fail(`no saved Codex project contains ${config.cwd}`);
}

function automationDbPath() {
  const candidates = [
    join(home, ".codex/sqlite/codex-dev.db"),
    join(home, ".codex/codex-dev.db"),
  ];
  const found = candidates.find(existsSync);
  if (!found) fail("could not locate the Codex automation database");
  return found;
}

function nextRunAt() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(config.hour, config.minute, 0, 0);
  let dayDelta = (config.weekday - next.getDay() + 7) % 7;
  if (dayDelta === 0 && next <= now) dayDelta = 7;
  next.setDate(next.getDate() + dayDelta);
  return next.getTime();
}

function tomlString(value) {
  return JSON.stringify(value);
}

function buildToml({ prompt, projectId, createdAt, updatedAt }) {
  return [
    "version = 1",
    `id = ${tomlString(config.id)}`,
    'kind = "cron"',
    `name = ${tomlString(config.name)}`,
    `prompt = ${tomlString(prompt)}`,
    'status = "ACTIVE"',
    `rrule = ${tomlString(config.rrule)}`,
    `model = ${tomlString(config.model)}`,
    `reasoning_effort = ${tomlString(config.reasoningEffort)}`,
    `execution_environment = ${tomlString(config.executionEnvironment)}`,
    `target = { type = "project", project_id = ${tomlString(projectId)} }`,
    `cwds = [${tomlString(config.cwd)}]`,
    `created_at = ${createdAt}`,
    `updated_at = ${updatedAt}`,
    "",
  ].join("\n");
}

function retirePath(path, label) {
  if (!existsSync(path)) return null;
  const retiredRoot = join(home, ".codex/retired-claude-seo");
  mkdirSync(retiredRoot, { recursive: true });
  let destination = join(retiredRoot, `${label}-2026-08-12`);
  let suffix = 2;
  while (existsSync(destination)) destination = join(retiredRoot, `${label}-2026-08-12-${suffix++}`);
  renameSync(path, destination);
  return destination;
}

const smoke = process.argv.includes("--smoke");
const checkOnly = process.argv.includes("--check");
const skillPath = join(config.cwd, config.skillRelativePath);
if (!existsSync(config.promptFile)) fail(`missing ${config.promptFile}`);
if (!existsSync(skillPath)) fail(`missing ${skillPath}`);

const prompt = readFileSync(config.promptFile, "utf8").trim();
const projectId = resolveProjectId();
const dbPath = automationDbPath();
const automationDir = join(home, ".codex/automations", config.id);
const automationPath = join(automationDir, "automation.toml");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");
const existing = db.prepare("SELECT * FROM automations WHERE id = ?").get(config.id);

if (checkOnly) {
  if (!existing) fail("native Codex automation is not registered");
  if (!existsSync(automationPath)) fail(`missing ${automationPath}`);
  if (existing.status !== "ACTIVE") fail(`automation status is ${existing.status}`);
  if (existing.model !== config.model || existing.reasoning_effort !== config.reasoningEffort) {
    fail(`unexpected model lane ${existing.model}/${existing.reasoning_effort}`);
  }
  const toml = readFileSync(automationPath, "utf8");
  if (!toml.includes(`execution_environment = ${tomlString(config.executionEnvironment)}`)) {
    fail(`automation is not configured for ${config.executionEnvironment} execution`);
  }
  console.log(`sbt-seo-sweep: ACTIVE, ${config.model}/${config.reasoningEffort}, ${config.rrule}`);
  db.close();
  process.exit(0);
}

const now = Date.now();
const createdAt = Number(existing?.created_at ?? now);
const scheduledAt = smoke ? now + 15_000 : nextRunAt();
mkdirSync(automationDir, { recursive: true });
const temporaryToml = `${automationPath}.tmp-${process.pid}`;
writeFileSync(temporaryToml, buildToml({ prompt, projectId, createdAt, updatedAt: now }), {
  mode: 0o600,
});

db.prepare(`
  INSERT INTO automations (
    id, name, prompt, status, next_run_at, last_run_at, cwds, rrule,
    model, reasoning_effort, created_at, updated_at, target_type, project_id
  ) VALUES (?, ?, ?, 'ACTIVE', ?, NULL, ?, ?, ?, ?, ?, ?, 'project', ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    prompt = excluded.prompt,
    status = 'ACTIVE',
    next_run_at = excluded.next_run_at,
    cwds = excluded.cwds,
    rrule = excluded.rrule,
    model = excluded.model,
    reasoning_effort = excluded.reasoning_effort,
    updated_at = excluded.updated_at,
    target_type = excluded.target_type,
    project_id = excluded.project_id
`).run(
  config.id,
  config.name,
  prompt,
  scheduledAt,
  JSON.stringify([config.cwd]),
  config.rrule,
  config.model,
  config.reasoningEffort,
  createdAt,
  now,
  projectId,
);
db.close();
renameSync(temporaryToml, automationPath);

if (smoke) writeFileSync(join(automationDir, "smoke-test"), `${new Date().toISOString()}\n`);

const domain = `gui/${process.getuid()}`;
spawnSync("/bin/launchctl", ["bootout", `${domain}/${config.retiredLaunchAgent}`], {
  stdio: "ignore",
});
const retiredPlist = retirePath(
  join(home, `Library/LaunchAgents/${config.retiredLaunchAgent}.plist`),
  `${config.retiredLaunchAgent}.plist`,
);
const retiredRunner = retirePath(config.retiredClaudeDir, `${config.id}-runner`);

console.log(`sbt-seo-sweep: registered native Codex automation (${config.model}/${config.reasoningEffort})`);
console.log(`next run: ${new Date(scheduledAt).toString()}${smoke ? " (smoke preflight)" : ""}`);
if (retiredPlist) console.log(`retired Claude launchd plist: ${retiredPlist}`);
if (retiredRunner) console.log(`retired Claude runner: ${retiredRunner}`);
