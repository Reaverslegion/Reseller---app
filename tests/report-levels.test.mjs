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
const ALL_OK = { "Unit tests": "success", "Dependencies": "success", "Build": "success", "Test Scan service": "success", "Phone test build": "success", "Capacitor trial": "skipped" };
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
t("the Capacitor trial skipped is NOT TESTED at both levels (unchanged)", () => {
  for (const level of ["quick", "full"]) assert.ok(run(level, { ...ALL_OK, ...QUICK_SKIPS }).row("Capacitor trial").every((l) => /NOT TESTED/.test(l)));
});

// the workflow itself: emulator jobs run on every merge request into main and on manual runs; cancellation and paths kept
const wf = fs.readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
const FULL = "(github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.level == 'full'))";
const TRIAL = "(github.event_name == 'workflow_dispatch' && inputs.cap_trial != 'none' && inputs.level != 'quick')";
// evaluates one of the workflow's ${{ }} expressions for a given kind of run (only the operators these use)
const ev = (expr, event, inputs = {}) => new Function("github", "inputs", "format", "fromJSON",
  "return (" + expr.replace(/==/g, "===").replace(/!===/g, "!==") + ");")({ event_name: event }, inputs,
  (f, ...a) => f.replace(/\{(\d+)\}/g, (_, i) => a[+i]), JSON.parse);
const exprOf = (re) => { const m = wf.match(re); assert.ok(m, "expression found: " + re); return m[1]; };
t("workflow: emulator, emulator-app build and the report level use the same FULL rule; merge requests into main always run it", () => {
  const job = (id) => wf.split(/\n  (?=[a-z0-9-]+:\n)/).find((b) => b.startsWith(id + ":\n")) || "";
  for (const id of ["build-e2e", "emulator"]) assert.ok(job(id).includes("if: " + FULL), id);
  assert.ok(wf.includes("TEST_LEVEL: ${{ " + FULL + " && 'full' || 'quick' }}"));
  assert.match(wf, /pull_request:\n    branches: \[main\]\n/, "merge requests into main still trigger the suite, with no path filter");
  for (const id of ["unit", "supply", "build", "service", "build-phone", "report"]) assert.ok(!/\n    if: .*github.event_name/.test(job(id)), id + " still runs on every upload");
  assert.ok(job("build-cap8").includes("if: " + TRIAL), "the trial build runs only when a trial is chosen on a manual run");
  assert.match(wf, /concurrency:\n  group: test-\$\{\{ github.ref \}\}\n  cancel-in-progress: true/, "superseded runs are still cancelled");
  assert.match(wf, /paths-ignore: \[".github\/phone-test\/\*\*", "docs\/\*\*", "\*\*.md"\]/);
});
// every kind of run: which Android checks run, which trial apps get built, which trial package sets get a security check
const RUNS = [
  ["upload to a test branch", "push", {}],
  ["merge request into main", "pull_request", {}],
  ["manual full, no trial", "workflow_dispatch", { level: "full", cap_trial: "none" }],
  ["manual quick with a trial chosen (ignored)", "workflow_dispatch", { level: "quick", cap_trial: "both" }],
  ["manual trial, 8.6.0", "workflow_dispatch", { level: "trial", cap_trial: "8.6.0" }],
  ["manual trial, both", "workflow_dispatch", { level: "trial", cap_trial: "both" }],
  ["manual full + 7.6.10", "workflow_dispatch", { level: "full", cap_trial: "7.6.10" }],
];
const matrixExpr = exprOf(/include: \$\{\{ (fromJSON\(format\('\[\{0\}\{1\}\{2\}\]'.*\)\)) \}\}/);
const versExpr = exprOf(/\n        v: \$\{\{ (.*) \}\}/), auditExpr = exprOf(/CAP_TRIALS: \$\{\{ (.*) \}\}/);
const plan = ([, event, inputs]) => {
  const full = ev(FULL, event, inputs), trial = ev(TRIAL, event, inputs), builds = trial ? ev(versExpr, event, inputs) : [];
  const compatRuns = full || trial; // compat needs the emulator app (FULL) or a trial build (TRIAL)
  return { full, trial, builds, audits: String(ev(auditExpr, event, inputs) || ""), compat: compatRuns ? ev(matrixExpr, event, inputs).map((r) => r.label) : [] };
};
t("workflow: every kind of run gets exactly the intended jobs (emulator, trial builds, Android checks, trial security checks)", () => {
  const got = Object.fromEntries(RUNS.map((r) => [r[0], plan(r)]));
  assert.deepEqual(got["upload to a test branch"], { full: false, trial: false, builds: [], audits: "", compat: [] });
  assert.deepEqual(got["merge request into main"], { full: true, trial: false, builds: [], audits: "", compat: ["Android 11", "Android 15"] });
  assert.deepEqual(got["manual full, no trial"], { full: true, trial: false, builds: [], audits: "", compat: ["Android 11", "Android 15"] });
  assert.deepEqual(got["manual quick with a trial chosen (ignored)"], { full: false, trial: false, builds: [], audits: "", compat: [] });
  assert.deepEqual(got["manual trial, 8.6.0"], { full: false, trial: true, builds: ["8.6.0"], audits: "8.6.0", compat: ["Android 11 + Capacitor 8.6.0 trial", "Android 15 + Capacitor 8.6.0 trial"] });
  assert.deepEqual(got["manual trial, both"], { full: false, trial: true, builds: ["7.6.10", "8.6.0"], audits: "7.6.10 8.6.0",
    compat: ["Android 11 + Capacitor 7.6.10 trial", "Android 15 + Capacitor 7.6.10 trial", "Android 11 + Capacitor 8.6.0 trial", "Android 15 + Capacitor 8.6.0 trial"] });
  assert.deepEqual(got["manual full + 7.6.10"].compat, ["Android 11", "Android 15", "Android 11 + Capacitor 7.6.10 trial", "Android 15 + Capacitor 7.6.10 trial"]);
});
t("workflow: each trial app is tested under the name its build uploads, and normal rows are unchanged", () => {
  const rows = ev(matrixExpr, "workflow_dispatch", { level: "full", cap_trial: "both" });
  for (const r of rows.filter((x) => /trial/.test(x.label))) assert.equal(r.apk, `flipscout-cap-trial-${r.label.match(/Capacitor ([\d.]+)/)[1]}-apk`);
  assert.ok(wf.includes("name: flipscout-cap-trial-${{ matrix.v }}-apk"));
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.label, r.api, r.apk]), [["Android 11", 30, "flipscout-emulator-test-apk"], ["Android 15", 35, "flipscout-emulator-test-apk"]]);
  assert.deepEqual(rows.filter((r) => /trial/.test(r.label)).map((r) => r.api), [30, 35, 30, 35], "trials on Android 11 (API 30) and Android 15 (API 35)");
});
t("trial versions: every Capacitor package the live build installs has an exact version for each trial, plugins on the same major", () => {
  const tr = JSON.parse(fs.readFileSync(new URL("./ci/cap-trials.json", import.meta.url), "utf8"));
  const live = (fs.readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8").match(/npm install ([^\n]+)/)[1]).split(/\s+/).filter((p) => p.startsWith("@capacitor/")).map((p) => p.replace(/@[^@/]+$/, ""));
  assert.equal(live.length, 6);
  for (const v of ["7.6.10", "8.6.0"]) { assert.deepEqual(Object.keys(tr[v]).sort(), [...live].sort(), v);
    for (const [n, x] of Object.entries(tr[v])) { assert.match(x, /^\d+\.\d+\.\d+$/, n + " exact"); assert.equal(x.split(".")[0], v.split(".")[0], `${n} on Capacitor ${v.split(".")[0]}`); } }
  assert.deepEqual(["core", "cli", "android"].map((p) => tr["7.6.10"]["@capacitor/" + p]), ["7.6.10", "7.6.10", "7.6.10"]);
});
console.log(`\n${n} checks passed`);
