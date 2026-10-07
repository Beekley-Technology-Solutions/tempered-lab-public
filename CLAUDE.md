# CLAUDE.md

Standards for anyone changing this repo, and what the AI reviewer enforces. The plan is [`docs/plan.md`](docs/plan.md); decisions that depart from it are in [`docs/adr/`](docs/adr/).

## What this is

Tempered Lab: a delivery pipeline, a chaos harness, and agents that diagnose and repair a running system, graded against faults injected on purpose. The first target is a deliberately fragile CRUD app (the "responder"). The harness targets any app (ADR 0001).

## Rules a change must not break

1. **This repo is published.** Every commit on `main` goes to a public mirror. No secret, account ID, ARN, domain, or email in code, comments, commit messages, or tags. Identifiers come from `TL_*` environment variables (ADR 0004); tests and the PR gate use placeholders.
2. **Build once, promote the artifact.** GitHub builds and uploads; CodePipeline deploys. No workflow deploys, and no AWS credential reaches a pull request. `github-build` can push and sign images and put the release zip, nothing else; a change that widens it must change the assertion in `infra/lib/stacks.test.ts` in the same PR.
3. **No environment-specific values at build time.** Images and bundles read config by name at runtime.
4. **Vendor names live only in adapters.** Target names (services, routes, tables) live only in `targets/<name>/` (ADR 0001).
5. **Agent limits are IAM and workflow, never prompt.** Log and trace text reaching an agent is untrusted data.
6. **Everything that bills is leased** and torn down by the lifecycle machine.
7. **Every gate has a seeded defect that proves it** (`defects/`). Never weaken a gate to get a green run; propose the change instead.

## Review checklist

- Least privilege: new IAM is resource-scoped; `*` needs a reason in an acknowledged cdk-nag finding.
- Workflows: actions pinned by full SHA, in-repo actions by `$/`, `permissions: {}` at the top and granted per job, `persist-credentials: false`, no `${{ }}` of event data inside `run:` (pass it through `env:`), no `pull_request_target`.
- Untrusted input is validated at the boundary; inputs are bounded.
- Tests cover the change and the 80% floor holds; a security-relevant change has a test that fails without it.
- Conventional Commits; one concern per PR.

## Commands

```
make install        # pnpm install --frozen-lockfile
make hooks          # Gitleaks pre-commit, Conventional Commits commit-msg
make check          # the PR gate: lint, typecheck, test (80% floor), synth + cdk-nag, workflow lint
make commits        # Conventional Commits over origin/main..HEAD
make scan-history   # the publish gate, locally (needs .env)
```

Hand-deployed stacks and one-time setup: [`docs/bootstrap.md`](docs/bootstrap.md).

## Layout

`infra/` CDK (one file per stack, config in `lib/config.ts`) · `docs/` plan, ADRs, threat model · `.github/` workflows, `scripts/`, `actions/setup`. Later phases add `services/ deploy/ slo/ policy/ web/ loadgen/ ops/ chaos/ agents/ targets/ defects/`.

## Working agreement

- One branch per task, Conventional Commits, PRs opened as drafts and marked ready once green (each ready push is a paid AI review). Merge commits only.
- Phases run in order; each stops at its "Done when" for Tim.
