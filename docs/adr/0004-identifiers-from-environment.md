# 0004. Identifiers come from the environment, never from code

Status: accepted (2026-10-07)

## Context

Rule 1 keeps account IDs, ARNs, domains, and secrets out of code because every commit is published. Haven, the reference repo, fixes account IDs in `infra/bin` and commits its Anthropic federation IDs in the AI-review workflow. Neither can carry over.

## Decision

The CDK app reads every identifier from `TL_*` environment variables (`infra/lib/config.ts`). On a laptop they come from a git-ignored `.env` that the Makefile loads; in GitHub Actions they come from environment variables on the `build` environment. `TL_PLACEHOLDERS=1` substitutes obvious placeholders for synth in the PR gate. Without it, a missing value fails synth rather than deploying a placeholder. The AI-review federation IDs are repository variables.

Non-identifying settings (region, budget ceiling, daily budget, lease hours, node architecture) are constants in the same file, overridable by `TL_*` variables.

CDK context lookups are avoided, because `cdk.context.json` keys embed the account ID; it is git-ignored as a backstop.

## Consequences

- The publish scan can deny-list the real values exactly, with no false positives.
- Release tag messages and `release.json` must not name the registry or account; they name the digest and the run.
