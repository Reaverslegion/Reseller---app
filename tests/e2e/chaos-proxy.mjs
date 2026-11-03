// "Bad network" switch between the test app and the private test Scan service.
// The phone talks to port 8789; this passes requests on to the test service (8787) unless told to misbehave.
// Control (from the test machine only): GET http://127.0.0.1:8791/mode?m=normal|slow|down|error|cut  and  /stats  /reset
//   slow  = every answer delayed (default 9 s)      down  = connection refused-style failure (socket destroyed at once)
//   error = Scan service answers 500                 cut   = connection dropped half-way through an answer
// It also counts every request by type, so tests can check e.g. that pressing a button 5 times sent 1 request.
import http from "node:http";

const TARGET = +(process.env.CHAOS_TARGET || 8787), PORT = +(process.env.CHAOS_PORT || 8789), CTRL = +(process.env.CHAOS_CTRL || 8791);
let mode = "normal", delay = 9000, stats = {};
const kind = (u) => { const q = new URL(u, "http://x").searchParams; return [...q.keys()].filter((k) => k !== "key")[0] || "(none)"; };

http.createServer((req, res) => {
  const k = kind(req.url); stats[k] = (stats[k] || 0) + 1;
  if (req.method === "OPTIONS" || mode === "normal" || mode === "slow" || mode === "cut") {
    const go = () => {
      const p = http.request({ host: "127.0.0.1", port: TARGET, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        if (mode === "cut" && req.method !== "OPTIONS") { r.once("data", (c) => { res.write(c.slice(0, Math.max(1, c.length >> 1))); res.socket && res.socket.destroy(); }); return; }
        r.pipe(res);
      });
      p.on("error", () => { try { res.socket && res.socket.destroy(); } catch (e) {} });
      req.pipe(p);
    };
    if (mode === "slow" && req.method !== "OPTIONS") setTimeout(go, delay); else go();
    return;
  }
  if (mode === "down") { req.socket.destroy(); return; }
  if (mode === "error") {
    res.writeHead(500, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
    return res.end(JSON.stringify({ error: "internal error (test: simulated server failure)" }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`bad-network switch on ${PORT} -> ${TARGET}`));

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/mode") { mode = u.searchParams.get("m") || "normal"; if (u.searchParams.get("ms")) delay = +u.searchParams.get("ms"); }
  if (u.pathname === "/reset") stats = {};
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ mode, delay, stats }));
}).listen(CTRL, "127.0.0.1", () => console.log(`bad-network control on ${CTRL}`));
