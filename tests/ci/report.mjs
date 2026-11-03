// Builds the testing report from every results/*.json file the test jobs produced.
// Each check is PASS, FAIL, NOT TESTED or PARTIALLY TESTED. A check only counts as PASS if it actually ran and passed:
// anything planned but not built yet, or whose job didn't run, is listed as NOT TESTED.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] || "results";
const rows = [];
if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir, { recursive: true })) if (String(f).endsWith(".json")) {
  try { rows.push(...JSON.parse(fs.readFileSync(path.join(dir, String(f)), "utf8"))); } catch (e) { rows.push({ area: "Report", name: "could not read " + f, status: "FAIL" }); }
}
// every area the system is meant to cover; an area with no results is NOT TESTED
const AREAS = ["Unit tests", "Build", "Test Scan service", "Android emulator", "User journeys", "Unusual behaviour", "Deals: app vs database",
  "Dependency vulnerabilities", "Security", "Accessibility", "Performance"];
// a job that failed before it could record any results is a FAIL, never "not tested"
let jobs = {}; try { jobs = JSON.parse(process.env.JOB_RESULTS || "{}"); } catch (e) {}
for (const [a, res] of Object.entries(jobs)) if (!rows.some((r) => r.area === a) && res !== "success")
  rows.push({ area: a, name: "the job stopped before recording results", status: res === "skipped" ? "NOT TESTED" : "FAIL", detail: "job result: " + res });
for (const a of AREAS) if (!rows.some((r) => r.area === a)) rows.push({ area: a, name: "(not set up yet, or its job didn't run)", status: "NOT TESTED" });

const icon = { PASS: "✅ PASS", FAIL: "❌ FAIL", "NOT TESTED": "⬜ NOT TESTED", "PARTIALLY TESTED": "🟨 PARTIALLY TESTED" };
const count = (s) => rows.filter((r) => r.status === s).length;
let md = `# FlipScout testing report\n\n`;
md += `Branch **${process.env.GITHUB_REF_NAME || "?"}**, version ${String(process.env.GITHUB_SHA || "").slice(0, 7)}, run ${process.env.GITHUB_RUN_NUMBER || "?"}\n\n`;
md += `**${count("PASS")} passed · ${count("FAIL")} failed · ${count("PARTIALLY TESTED")} partly tested · ${count("NOT TESTED")} not tested**\n\n`;
md += `| Area | Check | Result | Details |\n|---|---|---|---|\n`;
for (const a of [...new Set([...AREAS, ...rows.map((r) => r.area)])]) for (const r of rows.filter((x) => x.area === a))
  md += `| ${a} | ${String(r.name).replace(/\|/g, "/")} | ${icon[r.status] || r.status} | ${String(r.detail || "").replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 200)} |\n`;
fs.writeFileSync("test-report.md", md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
// one short line per area, readable from the run's page without downloading anything
for (const a of [...new Set(rows.map((r) => r.area))]) {
  const rs = rows.filter((r) => r.area === a), st = rs.map((r) => r.status);
  const s = st.includes("FAIL") ? "FAIL" : st.every((x) => x === "PASS") ? "PASS" : st.every((x) => x === "NOT TESTED") ? "NOT TESTED" : "PARTIALLY TESTED";
  console.log(`::notice title=${a}: ${s}::${rs.filter((r) => r.status === "PASS").length}/${rs.length} passed${rs.filter((r) => r.status === "FAIL").map((r) => " | FAIL: " + r.name).join("").slice(0, 400)}`);
}
process.exit(count("FAIL") ? 1 : 0);
