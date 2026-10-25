// Daily price fill rules (settings, schedule, safety stop, log). Run: node tests/autofill.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const m = html.match(/\/\* AF-PURE START[\s\S]*?\*\/([\s\S]*?)\/\* AF-PURE END \*\//);
assert.ok(m, "AF-PURE block found in index.html");
const { AF_CONFIG, afConfig, afDueAt, afStopReason, afLogAdd } = new Function(m[1] + "\nreturn { AF_CONFIG, afConfig, afDueAt, afStopReason, afLogAdd };")();
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };
const H = 36e5, day = "2026-10-25", now = Date.parse("2026-10-25T18:00:00Z");
const cfg = afConfig(AF_CONFIG).cfg;

t("the shipped settings are all inside their allowed ranges", () => {
  assert.deepEqual(afConfig(AF_CONFIG).bad, []);
});
t("settings out of range are pulled back in and reported", () => {
  const { cfg: c, bad } = afConfig({ ...AF_CONFIG, pagesPerRun: 500, secondsBetweenPages: 1, hoursBetweenRuns: "x" });
  assert.equal(c.pagesPerRun, 30); assert.equal(c.secondsBetweenPages, 10); assert.equal(c.hoursBetweenRuns, 4);
  assert.deepEqual(bad.sort(), ["hoursBetweenRuns", "pagesPerRun", "secondsBetweenPages"]);
});
t("schedule: first ever run is due", () => assert.equal(afDueAt({}, now, day, cfg), true));
t("schedule: off or paused never runs", () => {
  assert.equal(afDueAt({ off: true }, now, day, cfg), false);
  assert.equal(afDueAt({ paused: true, day: "2026-10-20", at: now - 99 * H }, now, day, cfg), false);
});
t("schedule: once a day unless twice is ticked", () => {
  assert.equal(afDueAt({ day, n: 1, at: now - 10 * H }, now, day, cfg), false);
  assert.equal(afDueAt({ day, n: 1, at: now - 10 * H, twice: true }, now, day, cfg), true);
  assert.equal(afDueAt({ day, n: 2, at: now - 10 * H, twice: true }, now, day, cfg), false);
});
t("schedule: waits the minimum gap, even across midnight", () => {
  assert.equal(afDueAt({ day, n: 1, at: now - 2 * H, twice: true }, now, day, cfg), false);
  assert.equal(afDueAt({ day: "2026-10-24", n: 1, at: now - 2 * H }, now, day, cfg), false);
  assert.equal(afDueAt({ day: "2026-10-24", n: 1, at: now - cfg.hoursBetweenRuns * H }, now, day, cfg), true);
});
t("safety stop: sign-in, CAPTCHA, verification and block pages", () => {
  assert.equal(afStopReason("https://signin.ebay.co.uk/ws/eBayISAPI.dll?SignIn"), "signin");
  for (const u of ["https://www.ebay.co.uk/splashui/captcha?ap=1", "https://www.ebay.co.uk/sch/challenge", "https://www.ebay.co.uk/verify"]) assert.equal(afStopReason(u), "check", u);
  for (const tx of ["Pardon Our Interruption...", "Please verify you're a human", "Access denied", "We've noticed unusual activity", "Too many requests", "Security measure"]) assert.equal(afStopReason("https://www.ebay.co.uk/sch/i.html?_nkw=x", tx), "check", tx);
});
t("safety stop: a normal sold-listings page carries on", () => {
  assert.equal(afStopReason("https://www.ebay.co.uk/sch/i.html?_sacat=139971&_nkw=(console,ps5)&LH_Sold=1&LH_Complete=1&_ipg=240&_sop=13&_pgn=3", "PS5 Slim Disc 1TB Sold 24 Oct 2026 £320.00"), "");
});
t("run log keeps the newest runs first, up to the limit", () => {
  let log = [];
  for (let i = 1; i <= 40; i++) log = afLogAdd(log, { start: i }, 30);
  assert.equal(log.length, 30); assert.equal(log[0].start, 40); assert.equal(log[29].start, 11);
  assert.deepEqual(afLogAdd(null, { start: 1 }, 5), [{ start: 1 }]);
});
console.log(`\n${n} checks passed`);
