# Builds the TEST app using the exact steps from the live build file (.github/workflows/build.yml), so the app that
# gets tested is built the same way as the app you install. Only two steps are left out:
#   - "Run all tests" (the test pipeline runs them separately)
#   - "Signing key" (test builds never see your signing key: a throwaway key with a random password is made on the
#     test machine for each build, used once, never printed and never saved)
# If the live build file changes so a step is missing or renamed, this stops with an error instead of quietly differing.
import json, os, re, secrets, subprocess, sys, yaml

RUN = os.environ.get("RUN_NO", "0")
steps = yaml.safe_load(open(".github/workflows/build.yml"))["jobs"]["build"]["steps"]
want = ["Prepare app", "Icon and splash", "Notifications", "Crash capture", "Release settings", "Version number", "Build APK"]
skip = {"Run all tests (nothing is uploaded if any fail)", "Signing key"}
named = [s.get("name") for s in steps if "run" in s]
missing = [w for w in want if w not in named]
unknown = [n for n in named if n not in want and n not in skip]
if missing or unknown:
    sys.exit(f"Live build file changed: missing {missing}, new {unknown}. Update tests/ci/live-build-steps.py.")
env = dict(os.environ)
for s in steps:
    if s.get("name") == "Build APK" and not os.path.exists("android/app/flipscout.keystore"):
        pw = secrets.token_hex(16)
        print(f"::add-mask::{pw}", flush=True)
        env["KS_PASS"] = pw; env.pop("KS_KEY_PASS", None)
        subprocess.run(["keytool", "-genkeypair", "-keystore", "android/app/flipscout.keystore", "-alias", "androiddebugkey", "-keyalg", "RSA",
                        "-keysize", "2048", "-validity", "3", "-storepass", pw, "-keypass", pw, "-dname", "CN=FlipScout TEST ONLY"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("throwaway test signing key made (valid 3 days, never saved)", flush=True)
    if s.get("name") == "Build APK" and os.environ.get("PRE_BUILD_HOOK"):
        print("::group::Test-only changes (emulator test app)", flush=True)
        subprocess.run(["bash", "-e", "-c", os.environ["PRE_BUILD_HOOK"]], check=True, env=env)
        print("::endgroup::", flush=True)
    if s.get("name") in want:
        script = s["run"].replace("${{ github.run_number }}", RUN)
        # PHONE TEST BUILD (never the live build): a separate app, "FlipScout TEST", with its own package name, so it installs
        # NEXT TO your real app and can't touch it or its data. Push alerts are off in it (Firebase only knows the real app).
        if os.environ.get("PHONE_TEST") and s.get("name") == "Prepare app":
            script, k = re.subn(r'npx cap init "FlipScout" com\.reaverslegion\.flipscout\b', 'npx cap init "FlipScout TEST" com.reaverslegion.flipscout.test', script)
            if k != 1: sys.exit("PHONE_TEST: the app name/package line in build.yml changed; update live-build-steps.py")
            print("PHONE TEST: app named 'FlipScout TEST', package com.reaverslegion.flipscout.test", flush=True)
        if os.environ.get("PHONE_TEST") and s.get("name") == "Notifications" and os.path.exists("google-services.json"):
            os.remove("google-services.json"); print("PHONE TEST: Firebase file left out (alerts off in the test app)", flush=True)
        # TRIAL ONLY (never the live build): CAP_TRIAL=8 builds with Capacitor 8 to see what an upgrade would change
        if os.environ.get("CAP_TRIAL") and s.get("name") == "Prepare app":
            v = os.environ["CAP_TRIAL"]
            script, k = re.subn(r"@capacitor/([a-z-]+)@[0-9.]+", lambda m: f"@capacitor/{m.group(1)}@{v}", script)
            print(f"TRIAL: {k} Capacitor packages switched to version {v}", flush=True)
        if "${{" in script:
            sys.exit(f"Step {s['name']} uses a GitHub value this script doesn't fill in")
        print(f"::group::{s['name']}", flush=True)
        subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], check=True, env=env)
        if os.environ.get("PHONE_TEST") and s.get("name") == "Prepare app":
            # a clear "TEST" label on every screen and in the version, so it can't be mistaken for the real app
            f = "www/index.html"; h = open(f).read()
            h, k = re.subn(r'VER="2\.0\.(\d+)"', r'VER="2.0.\1-TEST"', h)
            h = h.replace("</body>", '<div style="position:fixed;left:0;right:0;bottom:calc(env(safe-area-inset-bottom,0px) + 64px);text-align:center;pointer-events:none;z-index:99999"><span style="background:#b42318;color:#fff;font:700 12px sans-serif;padding:3px 10px;border-radius:10px">TEST BUILD</span></div></body>', 1)
            # LOCKED to the separate test Scan service: every request goes there, whatever is typed into the app's settings,
            # so the TEST app can never reach your real Scan service or your real cloud backup. Address and throwaway key come
            # from the phone-test workflow (never printed); without them the build stops rather than make an unlocked TEST app.
            tu, tk = os.environ.get("TEST_SVC_URL", ""), os.environ.get("TEST_SVC_KEY", "")
            if not re.match(r"^https://flipscout-phonetest\.[a-z0-9-]+\.workers\.dev$", tu) or not re.match(r"^[0-9a-f]{48}$", tk):
                sys.exit("PHONE TEST: test service address/key missing or not the test service; refusing to build an unlocked TEST app")
            old = 'const kfetch=(url,key,qs,o)=>{o=o||{};'
            if h.count(old) != 1: sys.exit("PHONE TEST: kfetch not found exactly once; update live-build-steps.py")
            h = h.replace(old, 'const kfetch=(url,key,qs,o)=>{url=TEST_SVC;key=TEST_KEY;o=o||{};', 1)
            old2 = 'let S=load(),'
            if h.count(old2) != 1: sys.exit("PHONE TEST: S=load() not found exactly once; update live-build-steps.py")
            h = h.replace(old2, f'const TEST_SVC={json.dumps(tu)},TEST_KEY={json.dumps(tk)};let S=load();S.set.url=TEST_SVC;S.set.key=TEST_KEY;S.set.admin=true;let ', 1)
            open(f, "w").write(h); print(f"PHONE TEST: TEST label added (version changed: {k}); locked to the test service {tu}", flush=True)
        print("::endgroup::", flush=True)
print("Test app built with the live build steps")
