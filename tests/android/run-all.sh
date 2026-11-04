#!/bin/bash
# Runs the emulator journeys (Stage 2), the data-integrity audit (Stage 3) and the Stage 4 checks on the same virtual phone.
# PART: all, journeys, integrity (Stage 3 only), stage4 (Stage 4 only), or none (targeted re-runs of other jobs)
if [ "${PART:-all}" = none ]; then echo '[{"area":"Android emulator","name":"main emulator suites","status":"NOT TESTED","detail":"skipped on purpose in this targeted re-run"}]' > results/skipped.json 2>/dev/null || { mkdir -p results; echo '[{"area":"Android emulator","name":"main emulator suites","status":"NOT TESTED","detail":"skipped on purpose in this targeted re-run"}]' > results/skipped.json; }; exit 0; fi
a=0; case "${PART:-all}" in integrity|stage4) ;; *) node tests/android/journeys.mjs; a=$?;; esac
b=0; [ "${PART:-all}" = journeys ] || { node tests/android/integrity.mjs; b=$?; }
# last: the release build (production settings, throwaway key) replaces the test app and is checked
c=0; [ -n "${RELEASE_APK:-}" ] && { node tests/android/release-check.mjs; c=$?; }
[ $a -eq 0 ] && [ $b -eq 0 ] && [ $c -eq 0 ]
