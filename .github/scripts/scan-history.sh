#!/usr/bin/env bash
# Publish gate: nothing private reaches the public mirror. Runs Gitleaks over every commit, then looks
# for the deny list (the real account IDs, emails, domains: one per line in $PUBLISH_DENYLIST) in every
# file at every commit, every commit message and author, and every tag message. Prints where, never what.
set -euo pipefail
[ -n "${PUBLISH_DENYLIST//[[:space:]]/}" ] || { echo "::error::PUBLISH_DENYLIST is empty; an empty deny list proves nothing"; exit 1; }

gitleaks git --log-opts=--all --redact --no-banner .

list=$(mktemp)
trap 'rm -f "$list"' EXIT
printf '%s\n' "$PUBLISH_DENYLIST" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;/^$/d' >"$list"
found=0
# ponytail: one git grep over every revision; fine to thousands of commits, then scan only new ones.
if git rev-list --all | xargs git grep -I -i -l -F -f "$list"; then found=1; fi
while read -r commit; do
  if git log -1 --format='%an %ae %cn %ce%n%B' "$commit" | grep -qiF -f "$list"; then
    echo "commit message or author: $commit"
    found=1
  fi
done < <(git rev-list --all)
while read -r tag; do
  if git for-each-ref --format='%(contents)%(taggeremail)' "$tag" | grep -qiF -f "$list"; then
    echo "tag message: $tag"
    found=1
  fi
done < <(git for-each-ref --format='%(refname)' refs/tags)
[ "$found" = 0 ] || { echo "::error::Deny-listed identifiers found above; rewrite before publishing"; exit 1; }
echo "History clean: $(git rev-list --all | wc -l | tr -d ' ') commits, $(wc -l <"$list" | tr -d ' ') deny-listed values"
