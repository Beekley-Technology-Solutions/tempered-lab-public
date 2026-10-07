# 0003. Publish to the mirror after Release, not after the prod canary

Status: accepted (2026-10-07)

## Context

The delivery table places Publish after the prod canary, in the CodePipeline that lives in AWS. Phase 0 defines Publish as a GitHub job that pushes through the publisher app. The lab is leased and is down most of the time, and while it is down the pipeline records a release and stops. Tying the mirror to prod would hold every commit back until the next spin-up, and would put a GitHub App key in AWS.

## Decision

Publish runs in `release.yml`, after the release zip is uploaded and the commit is tagged: a scan job (full-history Gitleaks plus a deny list of the real identifiers) and then a push job that holds the app token and runs no repo code. It does not wait for a deployment.

## Consequences

- The mirror shows every released commit whether or not the lab is up. Evidence of a deployment (canary result, release evidence record) is published separately through the evidence branch in Phase 6.
- The app's private key lives only in the `publish` GitHub environment, limited to `main`.
