// "Back up now" feedback (11 Nov 2026): runs the app's own backup code from index.html (the lines from CAKEY to the end of
// cloudPush) with a stand-in Scan service, and checks: "Backing up…" straight away, button disabled while saving, success
// only after the Scan service confirms, a clear failure + "Try again", a stalled connection stops after the time limit,
// a screen-reader status line, double taps = one upload, and the uploaded backup is exactly the same text as before.
// Run: node tests/backup-feedback.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const a = html.indexOf('const CAKEY="flipscout_cloud_at"'), b = html.indexOf("async function cloudCheck(");
assert.ok(a > 0 && b > a, "backup code found in index.html");
const CODE = html.slice(a, b);
assert.match(html, /<div id="bk_st"[^>]*role="status"[^>]*aria-live="polite"/, "status line is announced by screen readers");
assert.match(html, /<button id="bk_now" onclick="backupNow\(\)"/, "Back up now uses the new handler");

function load({ reply, ms } = {}) {
  const els = { bk_now: { disabled: false, textContent: "Back up now", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }, bk_st: { textContent: "" } };
  const store = {}, calls = [], toasts = [], seen = [];
  const env = {
    S: { set: { url: "https://svc.example", key: "k".repeat(48) }, items: [{ n: "item" }], base: [] }, H: () => ({ cats: [] }), tab: "settings",
    $: (id) => els[id], toast: (m) => toasts.push(m), render: () => {}, esc: (x) => x, document: { activeElement: null },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
    fetch: (url, o = {}) => { calls.push({ url, o }); return new Promise((res, rej) => {
      if (o.signal) o.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); });
      const r = reply ? reply(calls.length) : { status: 200, body: { ok: true } }; if (r === "stall") return;
      if (r === "offline") return rej(new TypeError("Failed to fetch"));
      setTimeout(() => res({ ok: r.status < 400, status: r.status, json: async () => r.body }), 5); }); },
  };
  const names = Object.keys(env);
  const src = (ms ? CODE.replace("const BK_MS=20000", `const BK_MS=${ms}`) : CODE) + "\nreturn { backupNow, cloudPush, state: () => BKUP, err: () => cloudErr, BK_MS };";
  const api = new Function(...names, src)(...names.map((n) => env[n]));
  // a tiny watcher: what the button and status line show at each moment
  const look = () => ({ btn: els.bk_now.textContent, disabled: els.bk_now.disabled, busy: els.bk_now.attrs["aria-busy"], status: els.bk_st.textContent });
  return { ...api, els, calls, toasts, store, look, env };
}
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };

await t("success: 'Backing up…' and disabled at once; 'Backed up at HH:MM' only after the Scan service confirms", async () => {
  const A = load(), p = A.backupNow(), mid = A.look();
  assert.equal(mid.btn, "Backing up…"); assert.equal(mid.disabled, true); assert.equal(mid.busy, "true"); assert.equal(mid.status, "Backing up…");
  assert.equal(A.store.flipscout_cloud_at, undefined, "nothing marked saved before the reply");
  await p; const end = A.look();
  assert.match(end.status, /^Backed up at \d\d:\d\d\.$/); assert.equal(end.disabled, false); assert.equal(end.btn, "Back up now"); assert.ok(A.store.flipscout_cloud_at);
});
await t("server refuses (error 500): clear failure, 'Try again', never 'Backed up'", async () => {
  const A = load({ reply: () => ({ status: 500, body: { error: "internal error" } }) }); await A.backupNow(); const e = A.look();
  assert.match(e.status, /^Backup failed: internal error\. Tap Try again\.$/); assert.equal(e.btn, "Try again"); assert.equal(e.disabled, false);
  assert.ok(!A.toasts.some((x) => /Backed up/.test(x))); assert.equal(A.store.flipscout_cloud_at, undefined);
});
await t("server answers 200 but with an error message: still a failure", async () => {
  const A = load({ reply: () => ({ status: 200, body: { error: "storage full" } }) }); await A.backupNow(); assert.match(A.look().status, /Backup failed: storage full/);
});
await t("no connection: 'Backup failed: no connection', then Try again works", async () => {
  let k = 0; const A = load({ reply: () => (++k === 1 ? "offline" : { status: 200, body: { ok: true } }) });
  await A.backupNow(); assert.match(A.look().status, /Backup failed: no connection/); assert.equal(A.look().btn, "Try again");
  await A.backupNow(); assert.match(A.look().status, /^Backed up at/); assert.equal(A.calls.length, 2);
});
await t("stalled connection: stops after the time limit with an honest message (may not have saved)", async () => {
  const A = load({ reply: () => "stall", ms: 50 }), t0 = Date.now(); await A.backupNow();
  assert.ok(Date.now() - t0 < 2000, "gave up after the limit"); assert.match(A.look().status, /no answer from your Scan service within 20 seconds \(it may not have saved\)/);
  assert.equal(A.look().disabled, false); assert.equal(A.look().btn, "Try again");
  assert.equal(load().BK_MS, 20000, "the real limit is 20 seconds");
});
await t("double tap while saving: only one upload", async () => {
  const A = load(); const p1 = A.backupNow(), p2 = A.backupNow(); await Promise.all([p1, p2]); assert.equal(A.calls.length, 1);
});
await t("not connected: says so, sends nothing", async () => {
  const A = load(); A.env.S.set.key = ""; await A.backupNow(); assert.match(A.look().status, /not connected/); assert.equal(A.calls.length, 0);
});
await t("the uploaded backup is exactly the app's data, as before (format and contents unchanged)", async () => {
  const A = load(); await A.backupNow(); const c = A.calls[0];
  assert.equal(c.url, "https://svc.example?backup=1"); assert.equal(c.o.method, "POST"); assert.equal(c.o.headers["Content-Type"], "text/plain");
  assert.equal(c.o.body, JSON.stringify(A.env.S)); assert.equal(c.o.headers["X-FlipScout-Key"], "k".repeat(48));
});
await t("automatic backups unchanged: no time limit added, no status line or button change", async () => {
  const A = load(); await A.cloudPush(false); assert.equal(A.calls[A.calls.length - 1].o.signal, undefined); assert.equal(A.look().status, ""); assert.equal(A.look().btn, "Back up now");
});
console.log(`\n${n} checks passed`);
