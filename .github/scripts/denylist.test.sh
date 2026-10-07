#!/usr/bin/env bash
# `make denylist` feeds both the local publish gate and the PUBLISH_DENYLIST secret (bootstrap step 5).
# A value it drops reaches the public mirror unchecked, so pin its output for zero, one, and many extras.
# Command-line values override .env, so this never reads real identifiers.
set -euo pipefail
cd "$(dirname "$0")/../.."

check() { # $1: expected output; the rest: PUBLISH_DENYLIST_EXTRA values
  local want=$1 got
  shift
  got=$(make -s --no-print-directory denylist TL_TOOLS_ACCOUNT=111111111111 TL_WORKLOAD_ACCOUNT=222222222222 \
    TL_ALERT_EMAIL=alerts@example.com PUBLISH_DENYLIST_EXTRA="$*")
  [ "$got" = "$want" ] || { printf 'denylist with extras "%s"\nwant:\n%s\ngot:\n%s\n' "$*" "$want" "$got"; exit 1; }
}

base=$'111111111111\n222222222222\nalerts@example.com'
check "$base"
check "$base"$'\nexample.org' example.org
check "$base"$'\nexample.org\nexample.net\n333333333333' example.org example.net 333333333333
echo "denylist: ok"
