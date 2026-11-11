// SIGNING GUARD (11 Nov 2026): every workflow that can reach the app's signing key must be locked to approved branches,
// started only by hand or by main, use only GitHub's own add-ons pinned to exact commits, and delete the key file after
// the build. The checks live in tests/ci/signing_guard.py (Python, because it reads the workflow files properly).
// First it proves the guard catches deliberately unsafe examples, then it checks this branch's real workflow files.
// Run: node tests/signing-guard.test.mjs
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const root = new URL("..", import.meta.url).pathname, guard = new URL("./ci/signing_guard.py", import.meta.url).pathname;
const run = (...a) => spawnSync("python3", ["-I", guard, ...a], { cwd: root, encoding: "utf8" });
const self = run("--selftest");
assert.equal(self.error, undefined, "python3 is needed for the signing guard");
assert.equal(self.status, 0, "the signing guard missed an unsafe example:\n" + self.stdout + self.stderr);
const real = run();
assert.equal(real.status, 0, "a workflow can reach the signing key unsafely:\n" + real.stdout + real.stderr);
console.log(self.stdout.trim() + "\n" + real.stdout.trim());
