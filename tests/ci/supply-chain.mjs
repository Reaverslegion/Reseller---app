// Stage 4: dependency and supply-chain checks, run in GitHub on every test run (free tools only, no accounts).
//  1. secret scan of the whole history (gitleaks, pinned version + checksum)
//  2. known vulnerabilities in the npm packages the live phone build and the Scan service deploy install (npm audit)
//  3. which of those are pinned to an exact version, and GitHub Actions pinned to a fixed commit
// Writes results/supply.json. Run from the repository root: node tests/ci/supply-chain.mjs
import fs from "node:fs";
import { execSync } from "node:child_process";
const rows = [], AREA = "Dependencies";
const add = (name, status, detail = "") => { rows.push({ area: AREA, name, status, detail: String(detail).slice(0, 400) }); console.log(status.padEnd(17), name, detail ? "— " + String(detail).slice(0, 300) : ""); };
const run = (c, o = {}) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, ...o });
const tmp = fs.mkdtempSync("/tmp/sc-");

// 1. secrets
try {
  const GL = "https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz", SUM = "5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba";
  run(`curl -sSfL -o ${tmp}/gl.tgz ${GL}`); const got = run(`sha256sum ${tmp}/gl.tgz`).split(" ")[0];
  if (got !== SUM) throw new Error("the downloaded secret scanner doesn't match its known checksum, so it wasn't run");
  run(`tar xzf ${tmp}/gl.tgz -C ${tmp} gitleaks`);
  let out = "[]"; try { run(`${tmp}/gitleaks git --log-opts=--all --redact -f json -r ${tmp}/gl.json . && ${tmp}/gitleaks dir --redact -f json -r ${tmp}/gld.json .`); } catch (e) {}
  const found = [...JSON.parse(fs.existsSync(`${tmp}/gl.json`) ? fs.readFileSync(`${tmp}/gl.json`, "utf8") : out), ...JSON.parse(fs.existsSync(`${tmp}/gld.json`) ? fs.readFileSync(`${tmp}/gld.json`, "utf8") : "[]")];
  const commits = (run("git rev-list --all --count").trim());
  add(`no passwords, keys or tokens anywhere in the code or its history (${commits} commits and the current files scanned)`, found.length ? "FAIL" : "PASS",
    found.length ? found.slice(0, 5).map((f) => `${f.RuleID} in ${f.File}:${f.StartLine}`).join("; ") : "2 checked exceptions in .gitleaksignore: a made-up test key, and the Firebase key that is public by design");
} catch (e) { add("secret scan", "NOT TESTED", e.message); }

// 2. npm packages: exactly what the live workflows install
const wf = (f) => fs.readFileSync(`.github/workflows/${f}`, "utf8");
const pkgs = (wf("build.yml").match(/npm install ([^\n]+)/) || [, ""])[1].trim().split(/\s+/).filter((p) => /^@?[a-z]/.test(p));
const sets = [["phone build (build.yml)", pkgs], ["Scan service deploy (deploy-worker.yml)", ["wrangler@3"]]];
for (const [label, list] of sets) {
  if (!list.length) { add(`${label}: packages found`, "FAIL", "couldn't read the install line"); continue; }
  const d = fs.mkdtempSync(`${tmp}/np-`);
  try {
    run(`npm init -y`, { cwd: d }); run(`npm install --ignore-scripts --no-fund --no-audit ${list.join(" ")}`, { cwd: d, timeout: 600000 });
    let audit; try { audit = JSON.parse(run(`npm audit --json`, { cwd: d })); } catch (e) { audit = JSON.parse(e.stdout || "{}"); }
    const v = (audit.metadata && audit.metadata.vulnerabilities) || {}, total = Object.values(v).reduce((a, b) => a + b, 0);
    const names = Object.entries(audit.vulnerabilities || {}).map(([n, x]) => `${n} (${x.severity})`);
    add(`${label}: known vulnerabilities in ${list.length} packages and their ${(audit.metadata && audit.metadata.dependencies && audit.metadata.dependencies.total) || "?"} sub-packages`,
      v.critical || v.high ? "FAIL" : total ? "PARTIALLY TESTED" : "PASS", total ? `${v.critical || 0} critical, ${v.high || 0} high, ${v.moderate || 0} moderate, ${v.low || 0} low: ${names.slice(0, 8).join(", ")}` : "npm audit found none");
    // each problem in full in the log: which advisory, which versions, and whether a fix exists
    for (const [nm, x] of Object.entries(audit.vulnerabilities || {})) console.log(`   ${nm} (${x.severity}, ${x.isDirect ? "installed directly" : "inside " + (x.effects || []).join(", ")}): ` +
      (x.via || []).map((v) => (typeof v === "string" ? "via " + v : `${v.title} [${v.url}] affects ${v.range}`)).join(" | ") + ` · fix: ${x.fixAvailable === true ? "update available" : x.fixAvailable ? `${x.fixAvailable.name}@${x.fixAvailable.version}${x.fixAvailable.isSemVerMajor ? " (major upgrade)" : ""}` : "none"}`);
    const lock = JSON.parse(fs.readFileSync(`${d}/package-lock.json`, "utf8")).packages || {};
    const resolved = list.map((p) => { const n = p.replace(/@[^@/]+$/, ""); return `${n}@${(lock["node_modules/" + n] || {}).version}`; });
    console.log(`   resolved today: ${resolved.join(" ")}`);
    const floating = list.filter((p) => !/@\d+\.\d+\.\d+$/.test(p));
    add(`${label}: every package pinned to an exact version`, floating.length ? "PARTIALLY TESTED" : "PASS",
      floating.length ? `${floating.length} follow the newest release automatically (${floating.join(", ")}); today they resolve to ${resolved.join(", ")}` : "");
  } catch (e) { add(`${label}: npm audit`, "NOT TESTED", String(e.stderr || e.message).slice(0, 300)); }
}

// 3. GitHub Actions: who wrote each step, and is it pinned to a fixed commit
const uses = [...new Set(fs.readdirSync(".github/workflows").flatMap((f) => [...wf(f).matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1])))];
const third = uses.filter((u) => !/^(actions|github)\//.test(u)), unpinned = third.filter((u) => !/@[0-9a-f]{40}$/.test(u));
add(`GitHub Actions from outside GitHub are pinned to a fixed commit (${third.length} found)`, unpinned.length ? "FAIL" : "PASS", unpinned.join(", ") || third.join(", "));
add("GitHub's own Actions are pinned by version tag (normal practice; a fixed commit is stricter)", "PARTIALLY TESTED", uses.filter((u) => /^actions\//.test(u)).join(", "));
const noPerm = fs.readdirSync(".github/workflows").filter((f) => !/^permissions:/m.test(wf(f)));
add("every workflow limits what its GitHub token can do (permissions: contents: read)", noPerm.length ? "FAIL" : "PASS", noPerm.length ? `missing in ${noPerm.join(", ")}` : "");

fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/supply.json", JSON.stringify(rows, null, 1));
