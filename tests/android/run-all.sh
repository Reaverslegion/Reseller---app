#!/bin/bash
# Runs the emulator journeys (Stage 2) and then the data-integrity audit (Stage 3) on the same virtual phone.
a=0; [ "${PART:-all}" = integrity ] || { node tests/android/journeys.mjs; a=$?; }
b=0; [ "${PART:-all}" = journeys ] || { node tests/android/integrity.mjs; b=$?; }
[ $a -eq 0 ] && [ $b -eq 0 ]
