# 0002. Workflow linting is actionlint plus zizmor

Status: accepted (2026-10-07)

## Context

The plan asks for "a workflow linter" and seeds two defects it must stop: an action pinned by tag, and `pull_request_target` with a checkout. actionlint checks syntax, expressions, and shell, and catches neither.

## Decision

Run both in the PR gate (`make workflow-lint`): actionlint for correctness and zizmor for security. zizmor's default `unpinned-uses` policy (since v1.20) requires a SHA pin on every action, and its `dangerous-triggers` audit flags `pull_request_target`. No zizmor config, so the defaults are the policy.

zizmor runs `--offline`: the online audits need a token that can read the org's private `.github` repo, which the PR's `GITHUB_TOKEN` cannot, and Dependabot already covers vulnerable action versions.

## Consequences

- In-repo actions use GitHub's self-repository form (`uses: $/.github/actions/setup`, July 2026), which zizmor requires and which can't load an action written to disk by an earlier step. actionlint 1.7.12 predates it and has had no release since March 2026 (rhysd/actionlint#711, #719), so the Makefile ignores that one message. If actionlint stays dormant, drop it and rely on zizmor plus GitHub's own workflow validation.
- Calls to the org's reusable workflows and AI-review action are SHA-pinned as well, and Dependabot moves the pins.
- Those org workflows still reference some actions by tag internally (`actions/checkout@v7`, `anthropics/claude-code-action@v1`, `security-config@main`). Our pin does not reach them; fixing that belongs in the org `.github` repo.
