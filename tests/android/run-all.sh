#!/bin/bash
# Runs the emulator journeys (Stage 2) and then the data-integrity audit (Stage 3) on the same virtual phone.
node tests/android/journeys.mjs; a=$?
node tests/android/integrity.mjs; b=$?
[ $a -eq 0 ] && [ $b -eq 0 ]
