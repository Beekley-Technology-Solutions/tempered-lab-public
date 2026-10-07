# 0005. Git hooks are plain scripts, not a hook framework

Status: accepted (2026-10-07)

## Context

The plan wants Gitleaks and Conventional Commits enforced by hook and in CI. A hook framework (pre-commit, lefthook, husky) would add a dependency and a second place to pin tool versions.

## Decision

`.githooks/` holds two shell scripts, enabled by `make hooks` (`git config core.hooksPath .githooks`). `commit-msg` calls `.github/scripts/check-commits.sh`, the same script CI runs over a pull request's commits. `pre-commit` runs `gitleaks git --staged`.

## Consequences

- Hooks are opt-in per clone. CI is the enforcement; the hook is a fast local copy of it.
- Gitleaks has to be installed on the laptop (`brew install gitleaks`).
