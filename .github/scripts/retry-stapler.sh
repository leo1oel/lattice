#!/usr/bin/env bash
# Usage: retry-stapler.sh <staple|validate> <path>
#
# Both stapler actions look the notarization ticket up in Apple's CloudKit.
# The Intel runners have lost that connection both right after an accepted
# submission and while validating the mounted app, so a network drop is
# retried before it fails the build. A missing or invalid ticket still fails
# every attempt.
set -euo pipefail

for attempt in 1 2 3 4 5; do
  xcrun stapler "$@" && exit 0
  if ((attempt == 5)); then exit 1; fi
  sleep $((attempt * 15))
done
