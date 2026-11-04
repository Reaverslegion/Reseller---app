# Builds the TEST app using the exact steps from the live build file (.github/workflows/build.yml), so the app that
# gets tested is built the same way as the app you install. Only two steps are left out:
#   - "Run all tests" (the test pipeline runs them separately)
#   - "Signing key" (test builds never see your signing key: a throwaway key with a random password is made on the
#     test machine for each build, used once, never printed and never saved)
# If the live build file changes so a step is missing or renamed, this stops with an error instead of quietly differing.
import os, re, secrets, subprocess, sys, yaml

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
        # TRIAL ONLY (never the live build): CAP_TRIAL=8 builds with Capacitor 8 to see what an upgrade would change
        if os.environ.get("CAP_TRIAL") and s.get("name") == "Prepare app":
            v = os.environ["CAP_TRIAL"]
            script, k = re.subn(r"@capacitor/([a-z-]+)@[0-9.]+", lambda m: f"@capacitor/{m.group(1)}@{v}", script)
            print(f"TRIAL: {k} Capacitor packages switched to version {v}", flush=True)
        if "${{" in script:
            sys.exit(f"Step {s['name']} uses a GitHub value this script doesn't fill in")
        print(f"::group::{s['name']}", flush=True)
        subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], check=True, env=env)
        print("::endgroup::", flush=True)
print("Test app built with the live build steps")
