#!/bin/bash
# Runs the emulator journeys (Stage 2), the data-integrity audit (Stage 3) and the Stage 4 checks on the same virtual phone.
# PART: all, journeys, integrity (Stage 3 only) or stage4 (Stage 4 only)
a=0; case "${PART:-all}" in integrity|stage4) ;; *) node tests/android/journeys.mjs; a=$?;; esac
b=0; [ "${PART:-all}" = journeys ] || { node tests/android/integrity.mjs; b=$?; }
[ $a -eq 0 ] && [ $b -eq 0 ]
