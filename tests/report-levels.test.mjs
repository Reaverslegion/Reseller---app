// The testing report must stay honest at both test levels (8 Nov 2026):
//  - QUICK (uploads to a test branch): the emulator jobs skipped by design show as NOT TESTED, never PASS, and the
//    report says it was a quick check. A failure, or a skip of any other job, is still a FAIL.
//  - FULL (merge requests into main, manual runs): a skipped emulator job is a FAIL, exactly as before.
// Run: node tests/report-levels.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const report = new URL("./ci/report.mjs", import.meta.url).pathname;
const ALL_OK = { "Unit tests": "success", "Dependencies": "success", "Build": "success", "Test Scan service": "success", "Phone test build": "success", "Capacitor 8 trial": "skipped" };
const QUICK_SKIPS = { "Android emulator": "skipped", "Other Android versions": "skipped", "Emulator test app build": "skipped" };
function run(level, jobs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rep-")); fs.mkdirSync(path.join(dir, "results"));
  const env = { ...process.env, JOB_RESULTS: JSON.stringify(jobs) }; delete env.TEST_LEVEL; if (level) env.TEST_LEVEL = level;
  const r = spawnSync(process.execPath, [report, "results"], { cwd: dir, env, encoding: "utf8" });
  const md = fs.existsSync(path.join(dir, "test-report.md")) ? fs.readFileSync(path.join(dir, "test-report.md"), "utf8") : "";
  const row = (area) => md.split("\n").filter((l) => l.startsWith("| " + area + " |"));
  return { code: r.status, md, row };
}
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };

t("quick: emulator jobs skipped by design are NOT TESTED (not PASS, not FAIL) and the report says it was a quick check", () => {
  const r = run("quick", { ...ALL_OK, ...QUICK_SKIPS });
  for (const a of Object.keys(QUICK_SKIPS)) { assert.ok(r.row(a).length, "row for " + a); assert.ok(r.row(a).every((l) => /NOT TESTED/.test(l) && !/PASS/.test(l)), a + ": " + r.row(a)); }
  assert.match(r.md, /Quick check only/);
  assert.doesNotMatch(r.md, /❌ FAIL/);
});
t("quick: a real failure is still a FAIL and the run still fails", () => {
  const r = run("quick", { ...ALL_OK, ...QUICK_SKIPS, "Test Scan service": "failure" });
  assert.ok(r.row("Test Scan service").some((l) => /FAIL/.test(l))); assert.equal(r.code, 1);
});
t("quick: a skip of any other job is still a FAIL (only the emulator jobs may be skipped by design)", () => {
  const r = run("quick", { ...ALL_OK, ...QUICK_SKIPS, "Build": "skipped" });
  assert.ok(r.row("Build").some((l) => /FAIL/.test(l))); assert.equal(r.code, 1);
});
t("quick: an emulator job that failed or was cancelled is still a FAIL", () => {
  for (const res of ["failure", "cancelled"]) { const r = run("quick", { ...ALL_OK, ...QUICK_SKIPS, "Android emulator": res });
    assert.ok(r.row("Android emulator").some((l) => /FAIL/.test(l)), res); assert.equal(r.code, 1); }
});
t("full (and no level given, as before): a skipped emulator job is a FAIL and there is no quick-check note", () => {
  for (const level of ["full", null]) { const r = run(level, { ...ALL_OK, ...QUICK_SKIPS });
    assert.ok(r.row("Android emulator").some((l) => /FAIL/.test(l)), String(level)); assert.equal(r.code, 1); assert.doesNotMatch(r.md, /Quick check only/); }
});
t("the Capacitor 8 trial skipped is NOT TESTED at both levels (unchanged)", () => {
  for (const level of ["quick", "full"]) assert.ok(run(level, { ...ALL_OK, ...QUICK_SKIPS }).row("Capacitor 8 trial").every((l) => /NOT TESTED/.test(l)));
});

// the workflow itself: emulator jobs run on every merge request into main and on manual runs; cancellation and paths kept
const wf = fs.readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
const FULL = "(github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.level != 'quick'))";
t("workflow: emulator, emulator-app build and the report level use the same FULL rule; merge requests into main always run it", () => {
  const job = (id) => wf.split(/\n  (?=[a-z0-9-]+:\n)/).find((b) => b.startsWith(id + ":\n")) || "";
  for (const id of ["build-e2e", "emulator"]) assert.ok(job(id).includes("if: " + FULL), id);
  assert.ok(wf.includes("TEST_LEVEL: ${{ " + FULL + " && 'full' || 'quick' }}"));
  assert.match(wf, /pull_request:\n    branches: \[main\]\n/, "merge requests into main still trigger the suite, with no path filter");
  for (const id of ["unit", "supply", "build", "service", "build-phone", "report"]) assert.ok(!/\n    if: .*github.event_name/.test(job(id)), id + " still runs on every upload");
  assert.match(job("build-cap8"), /if: github.event_name == 'workflow_dispatch' && inputs.cap8/);
  assert.match(wf, /concurrency:\n  group: test-\$\{\{ github.ref \}\}\n  cancel-in-progress: true/, "superseded runs are still cancelled");
  assert.match(wf, /paths-ignore: \[".github\/phone-test\/\*\*", "docs\/\*\*", "\*\*.md"\]/);
});
t("workflow: Android 11 and 15 always run in the full compatibility matrix; the Capacitor 8 row only when that trial was ticked", () => {
  const m = wf.match(/include: \$\{\{ fromJSON\(format\('\[\{0\}\{1\}\]', '([^']*)', \(([^)]*)\) && '([^']*)' \|\| ''\)\) \}\}/);
  assert.ok(m, "matrix include expression found");
  const [, base, cond, trialRow] = m;
  assert.equal(cond, "github.event_name == 'workflow_dispatch' && inputs.cap8 && inputs.level != 'quick'", "same rule as the trial build");
  assert.ok(wf.includes("if: " + cond), "the trial build job uses the identical rule");
  const off = JSON.parse("[" + base + "]"), on = JSON.parse("[" + base + trialRow + "]");
  assert.deepEqual(off.map((r) => r.label), ["Android 11", "Android 15"]);
  assert.deepEqual(on.map((r) => r.label), ["Android 11", "Android 15", "Android 15 + Capacitor 8 trial"]);
  assert.deepEqual(off.map((r) => [r.api, r.apk]), [[30, "flipscout-emulator-test-apk"], [35, "flipscout-emulator-test-apk"]], "normal rows unchanged");
  assert.deepEqual([on[2].api, on[2].apk], [35, "flipscout-cap8-trial-apk"]);
  assert.ok(!/- \{ label: "Android 15 \+ Capacitor 8 trial"/.test(wf), "no fixed trial row left");
});
console.log(`\n${n} checks passed`);
