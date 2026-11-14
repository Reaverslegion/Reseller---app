// Drives the REAL FlipScout app on an Android emulator.
//  - Taps and typing go through Android itself ("adb shell input tap / text / keyevent"): the same touch and keyboard
//    events a finger makes, so buttons that don't respond to a real tap are caught.
//  - To find WHERE a button is, and to check what appeared, it reads the app's screen through Chrome's developer
//    connection (the app is a web view inside the Android app). Android's own screen dump gives the web view's position.
//  - Screenshots are real phone screenshots (adb screencap). Crashes are read from the phone's system log.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { DIAG, diagEvent, diagSnap } from "./diag.mjs";

export const PKG = "com.reaverslegion.flipscout";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const adb = (...a) => execFileSync("adb", a, { encoding: "utf8", timeout: 90000, maxBuffer: 64 << 20 });
export const sh = (cmd) => adb("shell", cmd);

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.wait = new Map(); this.handlers = []; this.closed = false;
    ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && this.wait.has(d.id)) { const [ok, bad] = this.wait.get(d.id); this.wait.delete(d.id); d.error ? bad(new Error(d.error.message)) : ok(d.result); } else if (d.method) this.handlers.forEach((h) => h(d)); });
    ws.addEventListener("close", () => { this.closed = true; for (const [, [, bad]] of this.wait) bad(new Error("app connection closed")); this.wait.clear(); }); }
  static connect(url) { return new Promise((ok, bad) => { const ws = new WebSocket(url); const t = setTimeout(() => bad(new Error("connect timeout")), 15000);
    ws.addEventListener("open", () => { clearTimeout(t); ok(new CDP(ws)); }); ws.addEventListener("error", () => { clearTimeout(t); bad(new Error("can't connect to the app's web view")); }); }); }
  send(method, params = {}) { if (this.closed) return Promise.reject(new Error("app connection closed")); const id = ++this.id;
    return new Promise((ok, bad) => { this.wait.set(id, [ok, bad]); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.wait.has(id)) { this.wait.delete(id); bad(new Error(method + " timed out")); } }, 30000); }); }
  on(fn) { this.handlers.push(fn); }
  close() { try { this.ws.close(); } catch (e) {} }
}

export class App {
  // pkg: which app to drive (the real app's package by default; the phone TEST app has its own)
  constructor(shotDir, pkg = PKG) { this.pkg = pkg; this.shotDir = shotDir; this.n = 0; this.jsErrors = []; this.events = []; this.phase = ""; this.shots = []; fs.mkdirSync(shotDir, { recursive: true }); }
  // ---------- phone ----------
  install(apk) { adb("install", "-r", "-g", apk); try { sh(`pm grant ${this.pkg} android.permission.POST_NOTIFICATIONS`); } catch (e) {} }
  pid() { try { return sh(`pidof ${this.pkg}`).trim(); } catch (e) { return ""; } }
  startLog(file) { try { adb("logcat", "-c"); } catch (e) {} this.logFile = file; this.logcat = spawn("adb", ["logcat", "-v", "time"], { stdio: ["ignore", fs.openSync(file, "a"), "ignore"] }); }
  // crashes since `from` (byte offset in the log): app crash, "not responding", web view crash
  crashesSince(from = 0) { const t = fs.existsSync(this.logFile) ? fs.readFileSync(this.logFile, "utf8").slice(from) : "";
    const out = []; const L = t.split("\n");
    L.forEach((l, i) => { if (/FATAL EXCEPTION|ANR in com\.reaverslegion|Process com\.reaverslegion\.flipscout .*has died|renderer.*crash|Fatal signal/i.test(l) && /reaverslegion|chromium|FATAL|Fatal signal/.test(l)) out.push(L.slice(i, i + 4).join(" | ").slice(0, 400)); });
    return out; }
  // the last few phone-system lines about the app, its web view, memory or freezes (to explain a dropped link)
  recentSystemLog() { try { return fs.readFileSync(this.logFile, "utf8").split("\n").slice(-4000).filter((l) => /flipscout|webview|sandboxed/i.test(l) && /Killing|died|lowmemory|lmkd|crash|ANR|FATAL|signal/i.test(l)).slice(-2).join(" | ").slice(0, 250); } catch (e) { return ""; } }
  logSize() { try { return fs.statSync(this.logFile).size; } catch (e) { return 0; } }
  async launch() { diagEvent("launch"); sh(`monkey -p ${this.pkg} -c android.intent.category.LAUNCHER 1`); for (let i = 0; i < 40 && !this.pid(); i++) await sleep(500); this.appPid = this.pid(); if (!this.appPid) throw new Error("the app did not start"); await this.connect(); }
  async stop() { diagEvent("force-stop"); sh(`am force-stop ${this.pkg}`); if (this.main) this.main.close(); this.main = null; await sleep(800); }
  async home() { sh("input keyevent 3"); await sleep(1500); }
  async resume() { sh(`monkey -p ${this.pkg} -c android.intent.category.LAUNCHER 1`); await sleep(2500); }
  // the emulator itself can be slow on GitHub's small machines: turn off "isn't responding" pop-ups, and close any that appear
  prepPhone() { for (const c of ["settings put global hide_error_dialogs 1", "settings put global window_animation_scale 0", "settings put global transition_animation_scale 0", "settings put global animator_duration_scale 0", "svc power stayon true", "input keyevent 82"]) { try { sh(c); } catch (e) {} } }
  async unblock() { for (let i = 0; i < 3; i++) { let f = ""; try { f = sh("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"); } catch (e) { return; }
      if (!/Not Responding|isn't responding|Application Error/i.test(f)) return; this.unblocked = (this.unblocked || 0) + 1;
      // TEST-ONLY diagnostics (DIAG=1 only): record Android's state while the "isn't responding" box is still showing
      if (DIAG) { diagEvent("ANR BOX FOUND, closing it with Back", { during: this.phase || null, focus: f.trim().slice(0, 300) }); diagSnap(`ANR box ${this.phase || ""}`); }
      sh("input keyevent 4"); await sleep(2000); } }
  alive() { const p = this.pid(); return !!p && p === this.appPid; }
  async tapXY(x, y) { diagEvent("tap", [Math.round(x), Math.round(y)]); sh(`input tap ${Math.round(x)} ${Math.round(y)}`); }
  async key(code) { diagEvent("key", code); sh(`input keyevent ${code}`); await sleep(400); }
  async back() { await this.key(4); await sleep(500); }
  async type(text) { const t = String(text).replace(/'/g, "");
    // Android's "input text" can drop letters when a web view gets a long string at once, so type a few at a time
    for (let i = 0; i < t.length; i += 6) { sh(`input text '${t.slice(i, i + 6).replace(/ /g, "%s")}'`); await sleep(120); } await sleep(300); }
  // tap a box, replace what's in it with `text` (typed through the phone's keyboard), check it really holds that text, then leave the box
  async fill(spec, text, c = this.main, prep = null) { let got = "", why = "";
    if (this.netQuiet) await this.netQuiet();   // wait until the app has finished loading (it redraws when data arrives)
    const target = spec.sel ? JSON.stringify(spec.sel) : "null";
    // watch for the page redrawing itself (read-only: records what asked for each redraw)
    await this.eval(`(()=>{if(!window.__rw&&typeof render==="function"){const r=render;window.__rs=[];window.render=function(){window.__rs.push(Date.now()+" "+String(new Error().stack).split("\\n").slice(2,5).map(x=>x.trim().replace(/^at /,"").replace(/\\(?https:\\/\\/localhost\\/?/,"").slice(0,40)).join(" < "));return r.apply(this,arguments)};window.__rw=1}window.__rs=[];return 1})()`, c).catch(() => {});
    for (let a = 0; a < 4; a++) {
      if (prep) await prep();
      await this.tap(spec, c);
      // only type once the phone's keyboard focus is really in that box (a redraw can remove the box under the finger)
      const f = await this.eval(`(()=>{const a=document.activeElement,t=${target}&&document.querySelector(${target});return{ok:!!a&&(t?a===t:/INPUT|TEXTAREA/.test(a.tagName)),now:a?(a.id||a.tagName):"none",there:!!t}})()`, c);
      if (!f.ok && spec.sel && /^#[\w-]+$/.test(spec.sel)) {
        // second try: tap where Android itself says the box is (still a real tap), and note how far that is from the calculated spot
        const nb = this.nativeById(spec.sel.slice(1));
        if (nb) { const calc = await this.locate(spec, c).catch(() => null); this.posNotes = (this.posNotes || []).concat(`${spec.sel}: calculated ${calc ? Math.round(calc.x) + "," + Math.round(calc.y) : "?"}, Android says ${Math.round(nb.x)},${Math.round(nb.y)}`);
          await this.tapXY(nb.x, nb.y); await sleep(900);
          const g = await this.eval(`(()=>{const a=document.activeElement,t=${target}&&document.querySelector(${target});return!!a&&a===t})()`, c);
          if (g) { await this.selectAll(); await this.key(67); await this.type(text); got = await this.eval("document.activeElement&&document.activeElement.value", c); if (got === String(text)) break; } } }
      if (!f.ok) { const rs = await this.eval("(window.__rs||[]).slice(-3).join(' || ')", c).catch(() => "");
        why = `focus went to ${f.now}${f.there ? "" : " (the box had disappeared)"}${rs ? "; page redrawn by: " + rs : "; no redraw"}`; await sleep(1500); continue; }
      await this.selectAll(); await this.key(67); await this.type(text);
      got = await this.eval("document.activeElement&&document.activeElement.value", c); if (got === String(text)) break; why = `box holds "${String(got).slice(0, 25)}…"`; }
    if (got !== String(text)) throw new Error(`couldn't type "${String(text).slice(0, 22)}…" into ${spec.sel || spec.text}: ${why}`);
    await this.key(61); await this.hideKeyboard(); }
  async selectAll() { try { sh("input keycombination 113 29"); } catch (e) { sh("input keyevent 123"); for (let i = 0; i < 80; i++) sh("input keyevent 67"); } await sleep(300); }
  keyboardShown() { try { return /mInputShown=true/.test(sh("dumpsys input_method")); } catch (e) { return false; } }
  // close the phone's keyboard like a person would: tap a blank spot in the app's top bar (the title area), so the box
  // loses focus and Android hides the keyboard. Only if focus is still in a box after that, press Back once.
  async hideKeyboard(c = this.main) {
    const inBox = () => this.eval(`!!document.activeElement&&/INPUT|TEXTAREA/.test(document.activeElement.tagName)`, c).catch(() => false);
    if (!(await inBox())) return;
    const b = await this.calibrate(c), spot = await this.eval(`(()=>{const busy=e=>!!(e&&e.closest&&e.closest("button,a,input,select,textarea,summary,label,[onclick],[role=button],[tabindex]"));
      for(const y of [6,14,24,40,60,90])for(const fx of [0.5,0.35,0.65,0.2,0.8]){const x=innerWidth*fx,e=document.elementFromPoint(x,y);if(e&&!busy(e))return{x,y}}return null})()`, c).catch(() => null);
    if (!spot) { await this.key(4); await sleep(700); return; }
    await this.tapXY(b.l + spot.x * b.k, b.t + spot.y * b.k); await sleep(900);
    if (await inBox()) { await this.key(4); await sleep(700); } }
  async shot(name) { const f = `${this.shotDir}/${String(++this.n).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 50)}.png`;
    try { fs.writeFileSync(f, execFileSync("adb", ["exec-out", "screencap", "-p"], { maxBuffer: 64 << 20, timeout: 30000 })); this.shots.push(f); return f; } catch (e) { return null; } }
  // ---------- the app's web view ----------
  async connect(match = (t) => /^https:\/\/localhost/.test(t.url), isMain = true) {
    let last = "";
    for (let i = 0; i < 40; i++) {
      try {
        const sock = sh("cat /proc/net/unix").split("\n").map((l) => (l.match(/@(webview_devtools_remote_\d+)/) || [])[1]).filter(Boolean);
        const mine = sock.find((s) => s.endsWith("_" + this.appPid)) || sock[0];
        if (mine) { adb("forward", "tcp:9222", "localabstract:" + mine);
          const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
          const t = list.find((x) => x.type === "page" && match(x));
          if (t) { const c = await CDP.connect(t.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, "ws://127.0.0.1:9222"));
            await c.send("Runtime.enable"); await c.send("Inspector.enable").catch(() => {});
            const tag = isMain ? "app" : "browser";
            c.on((e) => { if (/^Inspector\.(detached|targetCrashed)$/.test(e.method) || e.method === "Runtime.executionContextsCleared")
              this.events.push(`${new Date().toISOString().slice(11, 19)} ${this.phase} [${tag}] ${e.method}${e.params && e.params.reason ? " (" + e.params.reason + ")" : ""}`); });
            c.on((e) => { if (e.method === "Runtime.exceptionThrown" && !/FlipScout harmless test/.test(JSON.stringify(e.params))) this.jsErrors.push({ phase: this.phase, msg: String((e.params.exceptionDetails.exception || {}).description || e.params.exceptionDetails.text).slice(0, 300) }); });
            if (isMain) { if (this.main) this.main.close(); this.main = c; } return c; }
          last = "web view found, app page not open yet"; } else last = "no web view debug socket yet";
      } catch (e) { last = e.message; }
      await sleep(1000);
    }
    throw new Error("couldn't connect to the app's screen: " + last);
  }
  async eval(expr, c = this.main) {
    if (c && c.closed && c === this.main) { this.appPid = this.pid() || this.appPid; await this.connect(); c = this.main; }
    const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("check failed in app: " + (r.exceptionDetails.exception || {}).description); return r.result.value; }
  async waitFor(expr, ms = 15000, what = expr, c = this.main) { const t = Date.now(); let v;
    while (Date.now() - t < ms) { try { v = await this.eval(expr, c); if (v) return v; } catch (e) {} await sleep(300); }
    throw new Error(`waited ${Math.round(ms / 1000)}s but ${what} never appeared`); }
  text(c = this.main) { return this.eval("document.body.innerText", c); }
  async waitText(re, ms = 15000, c = this.main) { const src = re instanceof RegExp ? re.source : String(re);   // the words are a pattern: "a|b" means either
    return this.waitFor(`(()=>{const m=document.body.innerText.match(new RegExp(${JSON.stringify(src)},"i"));return m&&m[0]})()`, ms, `"${re}" on screen`, c); }
  // where the web view sits on the phone screen, from Android's own screen dump (largest web view = the one in front)
  webviewBounds() {
    for (let i = 0; i < 8; i++) {
      try { sh("uiautomator dump /sdcard/ui.xml >/dev/null 2>&1"); const x = sh("cat /sdcard/ui.xml");
        const B = [...x.matchAll(/class="android\.webkit\.WebView"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)].map((m) => ({ l: +m[1], t: +m[2], r: +m[3], b: +m[4] }));
        if (B.length) { B.sort((a, b) => (b.r - b.l) * (b.b - b.t) - (a.r - a.l) * (a.b - a.t)); this.lastBounds = B[0]; this.lastDump = x; return B[0]; }
      } catch (e) {}
    }
    if (this.lastBounds) return this.lastBounds;
    throw new Error("couldn't find the app's screen area");
  }
  // Android's own position for a web page box with this id (web views list their boxes by id): a second opinion on where to tap
  nativeById(id) { for (let i = 0; i < 4; i++) { try { sh("uiautomator dump /sdcard/ui.xml >/dev/null 2>&1"); const x = sh("cat /sdcard/ui.xml");
      const m = x.match(new RegExp('resource-id="' + id + '"[^>]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"'));
      if (m) return { x: (+m[1] + +m[3]) / 2, y: (+m[2] + +m[4]) / 2, l: +m[1], t: +m[2], r: +m[3], b: +m[4] }; } catch (e) {} } return null; }
  nativeButton(text) { this.webviewBounds(); const m = [...(this.lastDump || "").matchAll(/<node [^>]*?(?:text|content-desc)="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)].find((m) => m[1].trim().toLowerCase() === text.toLowerCase());
    return m ? { x: (+m[2] + +m[4]) / 2, y: (+m[3] + +m[5]) / 2 } : null; }
  // find a control by its words (or a CSS selector), scroll it into view, and return its centre in phone pixels
  async locate(spec, c = this.main) {
    const find = `(function(spec){const vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"&&!e.closest('[style*="display: none"]')};
      const norm=s=>String(s||"").replace(/\\s+/g," ").trim().toLowerCase(),lab=e=>norm(e.innerText||e.value||e.getAttribute("aria-label")||e.placeholder||"");
      let L=[...document.querySelectorAll(spec.sel||'button,a,input,select,textarea,summary,[onclick],[role=button]')];
      const sheet=document.getElementById("sheet"),onb=document.getElementById("onb");
      if(spec.text){const t=norm(spec.text);L=L.filter(e=>spec.exact?lab(e)===t:lab(e).includes(t))}
      L=L.filter(vis);if(!spec.sel)L=L.filter(e=>!L.some(o=>o!==e&&e.contains(o)));
      if(sheet&&sheet.classList.contains("on")){const inS=L.filter(e=>sheet.contains(e));if(inS.length)L=inS}
      if(onb&&getComputedStyle(onb).display!=="none"){const inO=L.filter(e=>onb.contains(e));if(inO.length)L=inO}
      const pick=document.getElementById("pick");if(pick&&pick.style.display==="block"){const inP=L.filter(e=>pick.contains(e));if(inP.length)L=inP}
      const e=L[spec.nth||0];if(!e)return{missing:L.length};if(!spec._swiped){const de=document.documentElement,sb=de.style.scrollBehavior;de.style.scrollBehavior="auto";e.scrollIntoView({block:"center",inline:"center"});de.style.scrollBehavior=sb}
      const r=e.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,top=document.elementFromPoint(cx,cy);
      return{x:cx,y:cy,w:innerWidth,h:innerHeight,covered:top&&top!==e&&!e.contains(top)&&!(top.contains&&top.contains(e))?(top.id||top.className||top.tagName):null,label:lab(e).slice(0,60)}})`;
    let r;
    // older Android web views (Chrome 109 on the emulator) scroll to the wrong place for boxes inside a folded section, so once
    // swiping has started the page is no longer asked to scroll: the swipes do it, like a person
    spec = { ...spec };
    for (let i = 0; i < 16; i++) { r = await this.eval(`${find}(${JSON.stringify(spec)})`, c);
      // off the visible screen (the emulator's web view sometimes ignores "scroll into view"): swipe with a real finger
      // movement, like a person scrolling, then look again (only when its centre is outside the screen).
      if (r && r.missing === undefined && (r.y > r.h - 2 || r.y < 2)) { const [W, H] = (sh("wm size").match(/(\d+)x(\d+)/) || [0, 1080, 1920]).slice(1).map(Number);
        const up = r.y > r.h - 2; const far = Math.abs(up ? r.y - r.h / 2 : r.h / 2 - r.y) > r.h * 0.6, a = far ? 0.75 : 0.62, z = far ? 0.25 : 0.38;
        sh(`input swipe ${W / 2} ${Math.round(H * (up ? a : z))} ${W / 2} ${Math.round(H * (up ? z : a))} 500`); spec._swiped = true; this.swipes = (this.swipes || 0) + 1; await sleep(900); continue; }
      if (r && !r.missing && r.missing !== 0 && !r.covered) break; await sleep(700); }
    if (!r || r.missing !== undefined) throw new Error(`couldn't find "${spec.text || spec.sel}" on screen`);
    if (r.y > r.h - 2 || r.y < 2) { const g = await this.eval(`(()=>{const d=document.documentElement;return"page scrolled "+Math.round(scrollY)+" of "+(d.scrollHeight-innerHeight)+" possible, screen "+innerHeight+" tall, control at "+Math.round(${r.y})+"; browser "+((navigator.userAgent.match(/Chrome\\/[\\d.]+/)||[""])[0])})()`, c).catch(() => "");
      throw new Error(`"${spec.text || spec.sel}" stayed off the visible screen even after swiping (${g})`); }
    if (r.covered) {
      // Known limit of the emulator's older web view (Chrome 109): inside a folded section that has been opened, where a box is
      // drawn and where a touch lands disagree. The owner verified on a real phone (4 Nov 2026) that these boxes work.
      const old = await this.eval(`(()=>{const e=document.querySelector(${JSON.stringify(spec.sel || "")});const v=+((navigator.userAgent.match(/Chrome\\/(\\d+)/)||[])[1]||999);return v<=110&&!!e&&!!e.closest("details")})()`, c).catch(() => false);
      if (old) throw new Error(`EMULATOR LIMIT: "${spec.text || spec.sel}" is inside an opened folded section, which the emulator's older web view (Chrome 109) can't tap reliably; works on a real phone`);
      throw new Error(`"${spec.text || spec.sel}" is covered by something else (${r.covered})`); }
    await sleep(250);
    const b = await this.calibrate(c);
    return { x: b.l + r.x * b.k, y: b.t + r.y * b.k, px: r.x, py: r.y, label: r.label };
  }
  // Where the web view sits on the phone screen: one real tap in the middle of the screen, which the app is told to
  // ignore, reports where it landed inside the page. Measured once per screen (again after rotating).
  async calibrate(c = this.main) {
    this.cal = this.cal || new Map(); if (this.cal.has(c)) return this.cal.get(c);
    const [W, H] = (sh("wm size").match(/(\d+)x(\d+)/) || []).slice(1).map(Number), cx = Math.round(W / 2), cy = Math.round(H / 2);
    for (let a = 0; a < 3; a++) {
      await this.eval(`(function(){window.__cal=null;const ev=["pointerdown","pointerup","touchstart","touchend","mousedown","mouseup","click"];
        const h=e=>{e.preventDefault();e.stopImmediatePropagation();if(!window.__cal&&e.type==="pointerdown")window.__cal={x:e.clientX,y:e.clientY,w:innerWidth}};
        window.__calh=h;ev.forEach(n=>window.addEventListener(n,h,{capture:true,passive:false}));return 1})()`, c);
      await this.tapXY(cx, cy); await sleep(600);
      const r = await this.eval(`(function(){const r=window.__cal;const ev=["pointerdown","pointerup","touchstart","touchend","mousedown","mouseup","click"];ev.forEach(n=>window.removeEventListener(n,window.__calh,true));return r})()`, c);
      if (r && r.w) { const k = W / r.w, b = { l: cx - r.x * k, t: cy - r.y * k, k }; this.cal.set(c, b); return b; }
    }
    throw new Error("couldn't measure where the app is on the screen (calibration tap not received)");
  }
  // Tap a control with a real touch, then check where the touch actually landed inside the app (a listener that only
  // watches). If the screen had shifted (e.g. the keyboard pushed it up), correct the position and tap once more.
  async tap(spec, c) { if (typeof spec === "string") spec = { text: spec }; c = c || this.main;
    const p = await this.locate(spec, c);
    const mark = String(Math.random());
    await this.eval(`(()=>{window.__lt=null;window.__tm=${JSON.stringify(mark)};addEventListener("pointerdown",e=>{window.__lt={x:e.clientX,y:e.clientY}},{capture:true,once:true,passive:true});return 1})()`, c).catch(() => {});
    await this.tapXY(p.x, p.y); await sleep(150);
    // if the tap opened a new page (the marker is gone), it clearly arrived: never tap again
    const st = await this.eval("({lt:window.__lt,same:window.__tm===" + JSON.stringify(mark) + "})", c).catch(() => ({ lt: null, same: false }));
    let lt = st.lt, b = this.cal && this.cal.get(c);
    if (!st.same) { await sleep(spec.wait ?? 700); return p; }
    if (!lt && !spec._again) { // the touch never reached the app (e.g. the keyboard was over it): close the keyboard, try again
      this.missed = (this.missed || 0) + 1; await this.hideKeyboard(c); await sleep(500); return this.tap({ ...spec, _again: true }, c); }
    if (lt && b) { const off = Math.hypot(lt.x - p.px, lt.y - p.py);
      b.l = p.x - lt.x * b.k; b.t = p.y - lt.y * b.k;     // where the app really is now
      if (off > 12) { this.missed = (this.missed || 0) + 1; if (spec._again) throw new Error(`taps on "${spec.text || spec.sel}" keep landing ${Math.round(off)}px away`);
        await sleep(600); return this.tap({ ...spec, _again: true }, c); } }
    await sleep(spec.wait ?? 700); return p; }
}

// ---------- results: every step is PASS / FAIL / NOT TESTED, with a screenshot when it fails ----------
export class Results {
  // file: where rows are saved — after EVERY row, so a crash or time-out part-way never loses what already ran.
  // If the script itself crashes, a FAIL row says so (it must never look like a pass).
  constructor(app, file) { this.app = app; this.rows = []; this.file = file;
    if (file) { const self = this; self.rows.push = function (...r) { const n = Array.prototype.push.apply(this, r); self.save(); return n; };
      const die = (e) => { try { self.rows.push({ area: "Test run", name: `${file}: the test script itself stopped`, status: "FAIL", detail: String((e && e.stack) || e).slice(0, 300) }); } catch (x) {} process.exit(1); };
      process.on("uncaughtException", die); process.on("unhandledRejection", die); } }
  save() { if (!this.file) return; try { fs.mkdirSync("results", { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.rows, null, 1)); } catch (e) {} }
  // opts.expectCrash: the journey crashes the app on purpose (to test crash capture); only an unexpected end fails
  async journey(area, name, fn, opts = {}) {
    const app = this.app, logAt = app.logSize(), errAt = app.jsErrors.length; app.phase = name;
    // start each journey from a clean screen: close a list or picker left open by an earlier journey (phone's Back button)
    try { await app.unblock(); if (app.beforeJourney) await app.beforeJourney();
      // the in-app browser (Fill) left open on top of the app: close it with its own Done button
      for (let i = 0; i < 2; i++) { let open = false; try { open = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).some((t) => t.type === "page" && !/^https:\/\/localhost/.test(t.url) && /^https?:/.test(t.url)); } catch (e) {} if (!open) break;
        const d = app.nativeButton("Done"); if (d) await app.tapXY(d.x, d.y); else await app.back(); await sleep(2000); }
      await app.hideKeyboard();
      for (let i = 0; i < 2 && await app.eval(`document.getElementById("sheet").classList.contains("on")||document.getElementById("pick").style.display==="block"`); i++) { await app.back(); await sleep(600); } } catch (e) {}
    let failed = null, steps = 0, passed = 0;
    const step = async (what, f) => {
      steps++;
      // opts.independent: the steps don't depend on each other, so a failed step doesn't stop the rest of the journey
      if (failed && !opts.independent) { this.rows.push({ area, name: `${name} › ${what}`, status: "NOT TESTED", detail: "not run because an earlier step failed" }); return; }
      let note = "";
      try { await app.unblock();
        try { await f(); }
        catch (e) { if (!/connection closed|connect timeout|can't connect/.test(String(e.message))) throw e;
          // the link to the app's screen dropped (seen on slow emulators): note why, reconnect and try the step once more
          note = "retried once after the link to the app dropped" + (app.recentSystemLog() ? ": " + app.recentSystemLog() : "");
          app.appPid = app.pid() || app.appPid; await app.connect();
          try { await f(); } catch (e2) { e2.message = `retried after the link to the app dropped (${String(e.message).slice(0, 80)}), then: ${e2.message}`; throw e2; } }
        passed++; this.rows.push({ area, name: `${name} › ${what}`, status: note ? "PARTIALLY TESTED" : "PASS", detail: note }); }
      catch (e) { failed = what; if (DIAG) { diagEvent("STEP FAILED", { journey: name, step: what, error: String(e.message || e).slice(0, 200) }); diagSnap(`FAIL ${name} ${what}`); }
        const lim = /^EMULATOR LIMIT/.test(String(e.message)), s = await app.shot(`${lim ? "LIMIT" : "FAIL"} ${name} ${what}`);
        this.rows.push({ area, name: `${name} › ${what}`, status: lim ? "PARTIALLY TESTED" : "FAIL", detail: String(e.message || e).slice(0, 300), shot: s }); }
    };
    try { await fn(step); } catch (e) { this.rows.push({ area, name: `${name} › (journey stopped)`, status: "FAIL", detail: String(e.message || e).slice(0, 300) }); failed = failed || "stopped"; }
    const crashes = app.crashesSince(logAt), errs = app.jsErrors.slice(errAt);
    const crashArea = opts.crashArea || this.crashArea || "Android emulator";
    if (opts.expectCrash) this.rows.push({ area: crashArea, name: `${name}: running again after the deliberate test crash`, status: app.alive() ? "PASS" : "FAIL", detail: `${crashes.length} crash line(s) in the phone's log, all from the deliberate test` });
    else this.rows.push({ area: crashArea, name: `${name}: no crash`, status: crashes.length || !app.alive() ? "FAIL" : "PASS", detail: crashes.length ? crashes[0] : !app.alive() ? "the app stopped running" : "" });
    this.rows.push({ area: crashArea, name: `${name}: no app errors`, status: errs.length ? "FAIL" : "PASS", detail: errs.map((e) => e.msg).join(" || ").slice(0, 300) });
    if (!app.alive()) { try { await app.launch(); } catch (e) {} }
    return !failed;
  }
  add(area, name, status, detail = "") { this.rows.push({ area, name, status, detail }); }
}
