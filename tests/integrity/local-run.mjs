// FOR DEVELOPING ON A COMPUTER: runs the Stage 3 audit in a desktop browser (Chromium, phone-sized) against the local test
// Scan service (local-service.mjs) and fake eBay. The real check runs on the Android emulator in GitHub (tests/android/integrity.mjs).
// Run: TEST_APP_KEY=... node tests/integrity/local-run.mjs [sizes, e.g. 200,837]
import fs from "node:fs";
import { createRequire } from "node:module";
import { runAudit } from "./audit.mjs";
import { runStage4 } from "../stage4/app-checks.mjs";
const require = createRequire(import.meta.url), { chromium } = require(process.env.PW || "playwright");
const KEY = process.env.TEST_APP_KEY, sizes = (process.argv[2] || "200").split(",").map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 393, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }), page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
const URL_ = "file://" + new URL("../../index.html", import.meta.url).pathname;
const find = async (spec) => { if (typeof spec === "string") spec = { text: spec };
  const h = await page.evaluateHandle((spec) => { const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase(), lab = (e) => norm(e.innerText || e.value || e.getAttribute("aria-label") || e.placeholder || "");
    let L = [...document.querySelectorAll(spec.sel || "button,a,input,select,textarea,summary,[onclick],[role=button]")];
    if (spec.text) { const t = norm(spec.text); L = L.filter((e) => (spec.exact ? lab(e) === t : lab(e).includes(t))); }
    L = L.filter(vis); if (!spec.sel) L = L.filter((e) => !L.some((o) => o !== e && e.contains(o)));
    for (const id of ["pick", "sheet", "onb"]) { const p = document.getElementById(id); if (p && getComputedStyle(p).display !== "none" && (id !== "sheet" || p.classList.contains("on"))) { const i = L.filter((e) => p.contains(e)); if (i.length) L = i; } }
    return L[spec.nth || 0] || null; }, spec);
  const el = h.asElement(); if (!el) throw new Error(`couldn't find "${spec.text || spec.sel}"`); return el; };
const drv = {
  eval: (expr) => page.evaluate(expr),
  async waitFor(expr, ms = 15000, what = expr) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await page.evaluate(expr)) return true; } catch (e) {} await sleep(250); } throw new Error(`waited ${ms / 1000}s for ${what}`); },
  waitText(re, ms = 15000) { return this.waitFor(`new RegExp(${JSON.stringify(re)},"i").test(document.body.innerText)`, ms, re); },
  async tap(spec) { const el = await find(spec); await el.scrollIntoViewIfNeeded(); await el.tap(); await sleep(400); },
  async fill(spec, text) { const el = await find(spec); await el.tap(); await el.fill(String(text)); await el.press("Tab"); await sleep(300); },
  async relaunch() { await page.reload(); await sleep(800); },
  async back() { await page.evaluate("onBack()"); await sleep(400); },
  shot: (name) => page.screenshot({ path: `screenshots/${name.replace(/[^a-z0-9]+/gi, "-")}.png` }).catch(() => {}),
  menu: () => drv.tap({ sel: "#nav button", nth: 2 }), dealsTab: () => drv.tap({ sel: "#nav button", nth: 0 }),
};
const rows = [], R = {
  add: (area, name, status, detail = "") => rows.push({ area, name, status, detail }),
  async journey(area, name, fn) { let failed = false; await fn(async (what, f) => { if (failed) return rows.push({ area, name: `${name} › ${what}`, status: "NOT TESTED" });
    try { await f(); } catch (e) { failed = true; rows.push({ area, name: `${name} › ${what}`, status: "FAIL", detail: String(e.message).slice(0, 300) }); } }); },
};
fs.mkdirSync("screenshots", { recursive: true });
// set the app up the way a new user would: welcome guide, connect, popular categories, admin tools (for Scan now)
await page.goto(URL_); await sleep(800);
for (let i = 0; i < 3; i++) await drv.tap({ text: "Next", exact: true });
await drv.tap("Private seller"); await drv.tap("Start using FlipScout"); await drv.tap("Connect now");
await drv.fill({ sel: "#s_url" }, `http://127.0.0.1:8787#${KEY}`); await drv.dealsTab(); await drv.tap("Start with popular categories"); await sleep(1500);
await drv.menu(); for (let i = 0; i < 7; i++) await (await find({ sel: "div[onclick]", text: "FlipScout version" })).tap(); await drv.dealsTab();
if (process.env.STAGE4) await runStage4(drv, R); else await runAudit(drv, R, { sizes });
for (const r of rows) console.log(`${r.status.padEnd(16)} ${r.name}${r.detail ? "  — " + r.detail : ""}`);
console.log("page errors:", errors.length ? errors.slice(0, 5) : "none");
await b.close();
