#!/usr/bin/env bash
# Conventional Commits: one subject per line on stdin. The commit-msg hook feeds it one subject; the PR
# gate feeds it every commit in the PR (merge commits excluded).
#   git log --format=%s --no-merges origin/main..HEAD | .github/scripts/check-commits.sh
set -euo pipefail
types='feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert'
pattern="^(${types})(\([a-z0-9._/-]+\))?!?: [^ ].{0,99}$"
bad=0
while IFS= read -r subject; do
  [ -z "$subject" ] && continue
  # git's own subjects for merges, reverts, and autosquash are fine.
  [[ $subject =~ ^(Merge |Revert \"|fixup! |squash! |amend! ) ]] && continue
  if ! [[ $subject =~ $pattern ]]; then
    echo "::error::Not a Conventional Commit (type(scope): subject, at most 100 characters): $subject"
    bad=1
  fi
done
[ "$bad" = 0 ] || { echo "Types: ${types//|/, }. See https://www.conventionalcommits.org/" >&2; exit 1; }
