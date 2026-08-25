import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativeUrl) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

test("primary launch agent keeps the normal run and retry slots", () => {
  const plist = read("./events-refresh.plist");
  assert.match(plist, /org\.southbaytoday\.events-refresh/);
  assert.match(plist, /<integer>19<\/integer>\s*<key>Minute<\/key>\s*<integer>15<\/integer>/);
  assert.match(plist, /<integer>20<\/integer>\s*<key>Minute<\/key>\s*<integer>45<\/integer>/);
});

test("independent watchdog runs repeatedly and can restore the primary agent", () => {
  const plist = read("./events-refresh-watchdog.plist");
  const watchdog = read("./refresh-watchdog.mjs");
  assert.match(plist, /org\.southbaytoday\.events-refresh-watchdog/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>10800<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(watchdog, /install-mini-refresh\.sh"\), "--refresh-only"/);
  assert.match(watchdog, /scheduled-refresh\.mjs"\), "--force"/);
});

test("primary and watchdog mutually restore one another", () => {
  const installer = read("./install-mini-refresh.sh");
  const scheduled = read("./scheduled-refresh.mjs");
  assert.match(installer, /--refresh-only/);
  assert.match(installer, /--watchdog-only/);
  assert.match(installer, /org\.southbaytoday\.events-refresh-watchdog/);
  assert.match(scheduled, /install-mini-refresh\.sh"\), "--watchdog-only"/);
  assert.match(scheduled, /SBT_EVENT_SNAPSHOT_MAX_AGE_HOURS: "2"/);
});

test("GitHub is a same-night independent check with explicit failure alerting", () => {
  const workflow = read("../../.github/workflows/refresh-events.yml");
  assert.match(workflow, /SBT_EVENT_SNAPSHOT_MAX_AGE_HOURS: "8"/);
  assert.match(workflow, /verify-refresh-output\.mjs --max-age-hours 1 --snapshot-max-age-hours 8/);
  assert.match(workflow, /if: \$\{\{ failure\(\) \}\}/);
  assert.match(workflow, /notify-workflow-failure\.mjs/);
});

test("the eventCount pre-commit hook is tracked and self-installs", () => {
  // The first version of this hook existed only in the Mini's untracked
  // .git/hooks, so the repo had no idea it was load-bearing. Assert both
  // halves: the hook is in the tree, and something actually links it in.
  const hook = read("../hooks/pre-commit");
  const installer = read("./install-mini-refresh.sh");
  const scheduled = read("./scheduled-refresh.mjs");

  assert.match(hook, /eventCount = d\.events\.length/);
  assert.match(hook, /src\/data\/south-bay/);
  assert.match(hook, /exit 0/);
  assert.match(installer, /install_hooks/);
  assert.match(installer, /scripts\/hooks\/pre-commit/);
  // --watchdog-only runs on every scheduled pass, so the link self-heals.
  assert.match(installer, /^install_hooks$/m);
  assert.match(scheduled, /install-mini-refresh\.sh"\), "--watchdog-only"/);
});

test("partial inbound shard loss degrades, systemic loss still blocks", () => {
  // 2026-08-23/24: three unreachable shards out of 860 aborted the nightly
  // refresh after the 40-minute scrape had already succeeded.
  const puller = read("../pull-inbound-events.mjs");
  assert.match(puller, /inboundReadProblems/);
  assert.match(puller, /readHealth\.blocking\.length > 0/);
  // The coverage guards this degradation leans on must stay.
  assert.match(puller, /inbound source returned zero events/);
  assert.match(puller, /inbound coverage regression/);
  assert.doesNotMatch(puller, /sourceErrors\.length > 0/);
  // list() caps at 1000 per page; an unpaginated call silently drops shards
  // past that with every read it *did* make succeeding, so the run looks clean.
  assert.match(puller, /page\.hasMore/);
  assert.match(puller, /pageCursor/);
});

test("generate-events records input snapshots on every run, strict or not", () => {
  // 2026-08-24: `inputSnapshots` was written as `...(inputHealth ? {...} : {})`
  // and `inputHealth` was only computed under SBT_STRICT_EVENT_REFRESH, so any
  // ad-hoc `npm run generate-events` silently stripped the key the watchdog
  // pages on. Strict mode may decide whether bad inputs ABORT the run; it must
  // never decide whether they get recorded.
  const generator = read("../generate-events.mjs");

  assert.match(generator, /^\s*inputSnapshots: inputHealth\.snapshots,$/m);
  assert.doesNotMatch(generator, /\.\.\.\(inputHealth \?/);
  assert.doesNotMatch(generator, /let inputHealth = null/);

  // The measurement has to sit outside — and ahead of — the strict-mode branch
  // that consumes it, or `inputHealth` is out of scope at the write site.
  const measured = generator.indexOf("const inputHealth = strictRefreshInputHealth({");
  const strictBranch = generator.indexOf("if (STRICT_EVENT_REFRESH) {\n    if (!inputHealth.ok) {");
  assert.ok(measured !== -1, "inputHealth must be computed unconditionally");
  assert.ok(strictBranch !== -1, "strict mode must still gate the abort-before-overwrite");
  assert.ok(measured < strictBranch, "inputHealth must be measured before the strict gate");
});
