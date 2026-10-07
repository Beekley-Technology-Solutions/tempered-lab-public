# 0006. Admins can merge past a red gate, through a pull request only

Status: accepted (2026-10-07)

## Context

The plan requires every gate on `main` with no human-approval rule. This is a one-person operation: if a gate breaks for reasons outside the change (a scanner outage, a bad upstream rule, an expired federation), nobody else can fix it, and a fix to the gate itself has to get through the gate.

## Decision

The `main` ruleset has one bypass actor: the repository admin role, in `pull_request` mode. An admin can merge a pull request whose checks are red (`gh pr merge --admin`). Nobody can push to `main` directly, delete it, or force-push.

## Consequences

- Every bypass is a merged pull request with its red checks attached, and GitHub records it in the ruleset's insights. That's the audit trail; the phase report lists any bypass used.
- "A rule-breaking pull request cannot merge" is proved by the merge being refused without `--admin`.
- The hatch does not reach the mirror: release still runs the full-history scan before publishing, whatever the merge did.
