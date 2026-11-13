#!/bin/bash
# Runs the emulator journeys (Stage 2), the data-integrity audit (Stage 3) and the Stage 4 checks on the same virtual phone.
# PART: all, journeys, integrity (Stage 3 only), stage4 (Stage 4 only), or none (targeted re-runs of other jobs)
if [ "${PART:-all}" = none ]; then echo '[{"area":"Android emulator","name":"main emulator suites","status":"NOT TESTED","detail":"skipped on purpose in this targeted re-run"}]' > results/skipped.json 2>/dev/null || { mkdir -p results; echo '[{"area":"Android emulator","name":"main emulator suites","status":"NOT TESTED","detail":"skipped on purpose in this targeted re-run"}]' > results/skipped.json; }; exit 0; fi
# PART=back: only the focused Back-button investigation (tests/android/back-check.mjs), nothing else
if [ "${PART:-all}" = back ]; then node tests/android/back-check.mjs; exit $?; fi
# PART=toolkit: only the reseller toolkit checks (tests/android/toolkit.mjs), which install the "before" app (OLD_APK) themselves
if [ "${PART:-all}" = toolkit ]; then node tests/android/toolkit.mjs; exit $?; fi
a=0; case "${PART:-all}" in integrity|stage4) ;; *) node tests/android/journeys.mjs; a=$?;; esac
b=0; [ "${PART:-all}" = journeys ] || { node tests/android/integrity.mjs; b=$?; }
# last: the release build (production settings, throwaway key) replaces the test app and is checked
c=0; [ -n "${RELEASE_APK:-}" ] && { node tests/android/release-check.mjs; c=$?; }
if [ "${DIAG:-}" = 1 ]; then
  # TEST-ONLY diagnostics: Android's full "not responding" traces (/data/anr needs adb root, which test emulator images
  # allow) and the phone's final state. Failures here are ignored and never change the result.
  mkdir -p diag; { adb root; sleep 3; adb wait-for-device; } >diag/adb-root.txt 2>&1 || true
  adb shell ls -la /data/anr >diag/anr-list.txt 2>&1 || true
  adb pull /data/anr diag/anr >>diag/anr-list.txt 2>&1 || true
  adb shell dumpsys activity anr >diag/dumpsys-activity-anr.txt 2>&1 || true
  adb shell dumpsys window >diag/dumpsys-window.txt 2>&1 || true
  adb shell dumpsys input >diag/dumpsys-input.txt 2>&1 || true
  ls -la diag diag/anr 2>/dev/null | head -40 || true
fi
[ $a -eq 0 ] && [ $b -eq 0 ] && [ $c -eq 0 ]
