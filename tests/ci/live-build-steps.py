# Builds the TEST app using the exact steps from the live build file (.github/workflows/build.yml), so the app that
# gets tested is built the same way as the app you install. Only two steps are left out:
#   - "Run all tests" (the test pipeline runs them separately)
#   - "Signing key" (test builds don't use your signing key; Android signs them with a throwaway test key)
# If the live build file changes so a step is missing or renamed, this stops with an error instead of quietly differing.
import os, subprocess, sys, yaml

RUN = os.environ.get("RUN_NO", "0")
steps = yaml.safe_load(open(".github/workflows/build.yml"))["jobs"]["build"]["steps"]
want = ["Prepare app", "Icon and splash", "Notifications", "Version number", "Build APK"]
skip = {"Run all tests (nothing is uploaded if any fail)", "Signing key"}
named = [s.get("name") for s in steps if "run" in s]
missing = [w for w in want if w not in named]
unknown = [n for n in named if n not in want and n not in skip]
if missing or unknown:
    sys.exit(f"Live build file changed: missing {missing}, new {unknown}. Update tests/ci/live-build-steps.py.")
for s in steps:
    if s.get("name") == "Build APK" and os.environ.get("PRE_BUILD_HOOK"):
        print("::group::Test-only changes (emulator test app)", flush=True)
        subprocess.run(["bash", "-e", "-c", os.environ["PRE_BUILD_HOOK"]], check=True)
        print("::endgroup::", flush=True)
    if s.get("name") in want:
        script = s["run"].replace("${{ github.run_number }}", RUN)
        if "${{" in script:
            sys.exit(f"Step {s['name']} uses a GitHub value this script doesn't fill in")
        print(f"::group::{s['name']}", flush=True)
        subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], check=True)
        print("::endgroup::", flush=True)
print("Test app built with the live build steps")
