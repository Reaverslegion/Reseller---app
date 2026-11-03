// Checks the PRIVATE TEST Scan service (never the live one) answers correctly.
// Run after the test service is started: TEST_URL=http://127.0.0.1:8787 TEST_APP_KEY=... node tests/e2e/service-smoke.mjs
// Writes results/service.json for the test report.
import fs from "node:fs";
import assert from "node:assert/strict";

const URL_ = process.env.TEST_URL || "http://127.0.0.1:8787", KEY = process.env.TEST_APP_KEY;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_)) { console.error("REFUSED: these tests only run against a local test service, not " + URL_); process.exit(1); }
const results = [];
const call = async (q, opt = {}) => {
  const r = await fetch(URL_ + "/?" + q, { ...opt, headers: { ...(opt.key === false ? {} : { "X-FlipScout-Key": opt.key || KEY }), ...(opt.headers || {}) } });
  let body = null; try { body = await r.json(); } catch (e) {}
  return { status: r.status, body };
};
const t = async (name, fn) => {
  try { await fn(); results.push({ area: "Test Scan service", name, status: "PASS" }); console.log("PASS", name); }
  catch (e) { results.push({ area: "Test Scan service", name, status: "FAIL", detail: String(e.message || e).slice(0, 300) }); console.log("FAIL", name, "-", e.message); }
};

await t("refuses requests with no key", async () => assert.equal((await call("deals=1", { key: false })).status, 401));
await t("refuses a wrong key", async () => assert.equal((await call("deals=1", { key: "wrong-key-123456789" })).status, 401));
await t("settings (config) load", async () => { const r = await call("config=1"); assert.equal(r.status, 200); assert.ok(r.body && "config" in r.body); });
await t("deals list loads (empty test database)", async () => { const r = await call("deals=1"); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(Array.isArray(r.body.deals)); });
await t("price book loads", async () => { const r = await call("prices=1"); assert.equal(r.status, 200, JSON.stringify(r.body)); });
await t("cloud backup saves and restores the same data", async () => {
  const data = { testRun: Date.now(), items: [{ name: "test item" }] };
  const w = await call("backup=1", { method: "POST", body: JSON.stringify(data), headers: { "content-type": "application/json" } });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const r = await call("backup=1"); assert.equal(r.status, 200);
  assert.ok(JSON.stringify(r.body).includes(String(data.testRun)), "restored backup doesn't match what was saved");
});
await t("a scan runs without crashing (talks only to fake eBay)", async () => {
  const r = await call("run=1"); assert.ok(r.status < 500, "status " + r.status + " " + JSON.stringify(r.body).slice(0, 200));
});
await t("a keyword search works (answered by fake eBay)", async () => {
  const r = await call("q=rtx%203070&max=500"); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
});
await t("every outside call went to the fake eBay, none to the real one", async () => {
  const log = fs.existsSync("fake-ebay.log") ? fs.readFileSync("fake-ebay.log", "utf8").trim().split("\n").filter(Boolean) : [];
  console.log(`  fake eBay received ${log.length} calls`);
  const src = fs.readFileSync(".test-service/worker.js", "utf8");
  for (const h of ["https://api.ebay.com", "https://auth.ebay.com", "https://fcm.googleapis.com", "https://oauth2.googleapis.com", "https://www.googleapis.com"])
    assert.ok(!src.includes(h), "test copy still has a real address: " + h);
  assert.ok(log.length > 0, "the scan made no calls at all, so this check proved nothing");
});

fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/service.json", JSON.stringify(results, null, 1));
const bad = results.filter((r) => r.status === "FAIL").length;
console.log(`\n${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
