# SIGNING GUARD (11 Nov 2026): checks that the app's signing key (GitHub secrets KEYSTORE_B64, KEYSTORE_PASS,
# KEYSTORE_KEY_PASS) can only be used by locked, hand-started or main-only workflows. Run by tests/signing-guard.test.mjs.
#   python3 tests/ci/signing_guard.py                 check the workflow files in this folder
#   python3 tests/ci/signing_guard.py --branches      also check every branch on GitHub (needs git and fetched branches)
#   python3 tests/ci/signing_guard.py --selftest      prove it catches deliberately unsafe examples
# What it can't see (see LIMITS below): GitHub settings, and what build tools do with the key once it is on the machine.
import glob, json, os, re, subprocess, sys
import yaml

SIGN = ("KEYSTORE_B64", "KEYSTORE_PASS", "KEYSTORE_KEY_PASS")
BRANCHES = {"main", "testing", "claude/capacitor-8-upgrade"}  # the only branches allowed to sign
OWNERS = {"actions"}                                             # add-ons allowed next to the key: GitHub's own
SHA = re.compile(r"^[0-9a-f]{40}$")
DIRECT = re.compile(r"secrets\.(%s)\b" % "|".join(SIGN))
# indirect ways a workflow can reach EVERY secret, signing key included
INDIRECT = re.compile(r"toJSON\(\s*secrets\s*\)|secrets\s*\[|secrets:\s*inherit|\$\{\{\s*secrets\s*\}\}", re.I)
LIMITS = [
    "checks workflow files only: it can't read GitHub settings (who has write access, fork pull request settings, allowed add-ons)",
    "build tools (npm packages, Gradle and its plugins) run while the key is on the machine and could read it; that is true of every Android signing build",
    "a step could copy the key somewhere this guard can't follow (e.g. a script file that reads the key file); only obvious printing and uploads are checked",
    "branch conditions are checked by pattern (github.ref == 'refs/heads/<branch>'); an unusual way of writing the condition is refused, not understood",
    "on GitHub it checks the branch being tested; --branches checks all branches, but only when run where the branches are fetched",
]

def text(v):
    return json.dumps(v) if not isinstance(v, str) else v

def check(name, src):
    """problems with one workflow file (empty list = fine)"""
    p = []
    try:
        wf = yaml.safe_load(src) or {}
    except Exception as e:
        return [f"{name}: can't be read ({e})"]
    direct, indirect = bool(DIRECT.search(src)), bool(INDIRECT.search(src))
    if not (direct or indirect):
        return p
    if indirect:
        p.append(f"{name}: reaches all secrets indirectly (toJSON(secrets), secrets[...] or secrets: inherit), which includes the signing key")
    on = wf.get("on", wf.get(True, {}))
    if isinstance(on, str): on = {on: None}
    if isinstance(on, list): on = {k: None for k in on}
    for trig, cfg in (on or {}).items():
        if trig == "workflow_dispatch":
            continue
        if trig == "push":
            br = set((cfg or {}).get("branches", []) or [])
            if not br or br - {"main"} or (cfg or {}).get("tags"):
                p.append(f"{name}: a push from branches other than main can start it ({sorted(br) or 'any branch'})")
            continue
        p.append(f"{name}: started by '{trig}', which must never reach the signing key")
    for where, env in [("whole workflow", wf.get("env"))] + [(f"job {j}", (jd or {}).get("env")) for j, jd in (wf.get("jobs") or {}).items()]:
        if env and (DIRECT.search(text(env)) or INDIRECT.search(text(env))):
            p.append(f"{name}: signing secret given to the {where} (it must be given only to the steps that need it)")
    for j, jd in (wf.get("jobs") or {}).items():
        jd = jd or {}
        js = text(jd)
        if not (DIRECT.search(js) or INDIRECT.search(js)):
            continue
        if jd.get("uses"):
            p.append(f"{name}: job {j} passes secrets to another workflow ({jd['uses']})")
        cond = str(jd.get("if", ""))
        refs = re.findall(r"github\.ref\s*==\s*'refs/heads/([^']+)'", cond)
        if not refs:
            p.append(f"{name}: job {j} has no branch lock (an 'if: github.ref == ...' line)")
        elif set(refs) - BRANCHES:
            p.append(f"{name}: job {j} allows signing from branches not approved: {sorted(set(refs) - BRANCHES)}")
        if re.search(r"!=|startsWith|endsWith|contains\(|github\.head_ref|always\(\)", cond):
            p.append(f"{name}: job {j} branch lock is written in a way this guard can't confirm: {cond}")
        steps = jd.get("steps") or []
        decoded = False
        for i, st in enumerate(steps):
            st = st or {}
            u = st.get("uses")
            if u:
                ref = u.split("@", 1)[1] if "@" in u else ""
                owner = u.split("/", 1)[0]
                if owner not in OWNERS:
                    p.append(f"{name}: job {j} runs an outside add-on next to the signing key: {u}")
                if not SHA.match(ref.split()[0] if ref else ""):
                    p.append(f"{name}: job {j} add-on not pinned to an exact commit: {u}")
                if "upload-artifact" in u:
                    path = text((st.get("with") or {}).get("path", ""))
                    lines = [l.strip() for l in path.splitlines() if l.strip()]
                    if any(re.search(r"keystore|\*", l) or not re.search(r"\.(apk|aab)$", l) for l in lines):
                        p.append(f"{name}: job {j} uploads files that could include the key: {path.strip()}")
            run, senv = str(st.get("run", "")), text(st.get("env", ""))
            has = DIRECT.search(senv) or DIRECT.search(run) or INDIRECT.search(senv)
            if has and re.search(r"set -x|\bprintenv\b|^\s*env\s*$|echo \"?\$\{?KS(_PASS|_KEY_PASS)?\}?\"?\s*($|;|>)", run, re.M):
                p.append(f"{name}: job {j} step '{st.get('name', i)}' could print the signing secrets")
            if "flipscout.keystore" in run and ("base64 -d" in run or "base64 --decode" in run):
                decoded = i
        if decoded is not False:
            clean = [s for s in steps[decoded + 1:] if s and "always()" in str(s.get("if", "")) and re.search(r"rm -f[^\n]*flipscout\.keystore", str(s.get("run", "")))]
            if not clean:
                p.append(f"{name}: job {j} writes the key file but never deletes it in an always-run step")
    return p

def check_dir(d=".github/workflows"):
    out = []
    for f in sorted(glob.glob(f"{d}/*.yml") + glob.glob(f"{d}/*.yaml")):
        out += check(os.path.basename(f), open(f).read())
    return out

def check_branches():
    out = {}
    refs = subprocess.run(["git", "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"], capture_output=True, text=True).stdout.split()
    for r in refs:
        if r.endswith("/HEAD") or r == "origin": continue
        files = subprocess.run(["git", "ls-tree", "--name-only", r, ".github/workflows/"], capture_output=True, text=True).stdout.split()
        probs = []
        for f in files:
            if f.endswith((".yml", ".yaml")):
                probs += check(os.path.basename(f), subprocess.run(["git", "show", f"{r}:{f}"], capture_output=True, text=True).stdout)
        out[r.replace("origin/", "", 1)] = probs
    return out

GOOD = """name: ok
on:
  workflow_dispatch:
  push:
    branches: [main]
jobs:
  build:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - name: Signing key
        env:
          KS: ${{ secrets.KEYSTORE_B64 }}
        run: echo "$KS" | base64 -d > android/app/flipscout.keystore
      - name: Remove the signing key
        if: always()
        run: rm -f android/app/flipscout.keystore
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          path: FlipScout.apk
"""
BAD = {
    "no branch lock": (GOOD.replace("    if: github.ref == 'refs/heads/main'\n", ""), "no branch lock"),
    "pull request trigger": (GOOD.replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  pull_request:\n"), "started by 'pull_request'"),
    "pull_request_target trigger": (GOOD.replace("  workflow_dispatch:\n", "  pull_request_target:\n"), "started by 'pull_request_target'"),
    "push from any branch": (GOOD.replace("    branches: [main]\n", ""), "a push from branches other than main"),
    "unapproved branch": (GOOD.replace("refs/heads/main'", "refs/heads/main' || github.ref == 'refs/heads/random'"), "not approved"),
    "outside add-on": (GOOD.replace("actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "someone/checkout@11d5960a326750d5838078e36cf38b85af677262"), "outside add-on"),
    "unpinned add-on": (GOOD.replace("actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "actions/checkout@v4"), "not pinned"),
    "no key cleanup": (GOOD.replace("        if: always()\n        run: rm -f android/app/flipscout.keystore\n", "        run: echo done\n"), "never deletes it"),
    "secret for the whole workflow": (GOOD.replace("jobs:\n", "env:\n  K: ${{ secrets.KEYSTORE_PASS }}\njobs:\n", 1), "whole workflow"),
    "indirect: toJSON(secrets)": (GOOD.replace("${{ secrets.KEYSTORE_B64 }}", "${{ toJSON(secrets) }}"), "indirectly"),
    "indirect: secrets[...]": (GOOD.replace("secrets.KEYSTORE_B64", "secrets['KEYSTORE_' + 'B64']"), "indirectly"),
    "indirect: secrets inherit": ("name: x\non: [pull_request]\njobs:\n  a:\n    uses: ./.github/workflows/build.yml\n    secrets: inherit\n", "indirectly"),
    "prints the password": (GOOD.replace('run: echo "$KS" | base64 -d > android/app/flipscout.keystore', 'run: |\n          set -x\n          echo "$KS" | base64 -d > android/app/flipscout.keystore'), "could print"),
    "uploads the android folder": (GOOD.replace("path: FlipScout.apk", "path: android/"), "could include the key"),
    "weak lock": (GOOD.replace("if: github.ref == 'refs/heads/main'", "if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/')"), "can't confirm"),
}

def selftest():
    bad = []
    if check("good.yml", GOOD): bad.append("safe example wrongly refused: " + "; ".join(check("good.yml", GOOD)))
    for k, (src, want) in BAD.items():
        got = check(k, src)
        if not any(want in g for g in got): bad.append(f"unsafe example not caught: {k} (got {got})")
    return bad

if __name__ == "__main__":
    if "--selftest" in sys.argv:
        b = selftest(); print("\n".join(b) or f"selftest: safe example accepted, all {len(BAD)} unsafe examples caught"); sys.exit(1 if b else 0)
    if "--branches" in sys.argv:
        r = check_branches(); [print(f"{'OK  ' if not v else 'FAIL'} {k}" + "".join("\n     - " + x for x in v)) for k, v in sorted(r.items())]; sys.exit(1 if any(r.values()) else 0)
    probs = check_dir(); print("\n".join(probs) or "signing guard: every workflow that can reach the signing key is locked"); sys.exit(1 if probs else 0)
