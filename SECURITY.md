# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Please don't open a public issue.

## Scope

This is a lab. Its workload is deliberately fragile and has faults injected into it on purpose; resilience gaps in the responder are expected and are not vulnerabilities. Its security controls are not deliberately weakened: the pipeline, the build identity, the admission policies, the edge, and the agents' permissions are all in scope.

## What protects this repo

Every gate, and the defect that proves it, is listed in [`docs/plan.md`](docs/plan.md) under "Seeded defects". The threat model is [`docs/threat-model.md`](docs/threat-model.md).
