#!/usr/bin/env bash
# Pins the publish gate's deny-list scan (issue #4): a value in any file at any commit, in any commit
# message, or in any tag message fails it, including when the match sits in one batch of many.
# Gitleaks is stubbed out; this tests our scan, not theirs.
set -euo pipefail
scan=$(cd "$(dirname "$0")" && pwd)/scan-history.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin" && printf '#!/bin/sh\nexit 0\n' >"$work/bin/gitleaks" && chmod +x "$work/bin/gitleaks"
export PATH="$work/bin:$PATH" PUBLISH_DENYLIST=$'987654321098\nprivate.example'

repo() { # a fresh repo with five clean commits
  rm -rf "$work/r" && git init -q "$work/r" && cd "$work/r"
  for i in 1 2 3 4 5; do echo "$i" >f && git add f && git -c user.name=t -c user.email=t@t commit -qm "chore: $i"; done
}
commit() { git -c user.name=t -c user.email=t@t commit -q --allow-empty "$@"; }
expect() { # $1 pass|fail, $2 what
  local out rc=0
  out=$(SCAN_BATCH=1 "$scan" 2>&1) || rc=$?
  if { [ "$1" = pass ] && [ $rc != 0 ]; } || { [ "$1" = fail ] && [ $rc = 0 ]; }; then
    printf 'scan-history: expected %s for %s\n%s\n' "$1" "$2" "$out"; exit 1
  fi
}

repo; expect pass "clean history"
# The value lives only in one old commit, so every other batch of one has no match.
repo; echo 987654321098 >leak && git add leak && commit -m "chore: add" && git rm -q leak && commit -m "chore: remove"
for i in 6 7 8; do echo "$i" >f && git add f && commit -m "chore: $i"; done
expect fail "a value in one old commit's file"
repo; commit -m "chore: see 987654321098"; expect fail "a commit message"
repo; git -c user.name=t -c user.email=t@private.example commit -q --allow-empty -m "chore: x"; expect fail "an author email"
repo; git -c user.name=t -c user.email=t@t tag -a v1 -m "image at 987654321098"; expect fail "a tag message"
repo; PUBLISH_DENYLIST=" " expect fail "an empty deny list"
echo "scan-history: ok"
