# 0001. The harness targets any app

Status: accepted (2026-10-07)

## Context

The plan treats the responder as a prop and the pipeline, chaos harness, and agents as the product. Read literally, it still lets the harness assume the responder: the experiment catalog names gateway, lookup, and worker, the SLO files name `GET /items/{id}`, and the heal actions assume the responder's deployments. Tim wants to use the harness everywhere, against other workloads such as Haven and client systems.

## Decision

The responder is the first target, not the only one. Everything under `chaos/`, `slo/`, and `agents/` reads a target definition, `targets/<name>/`, that names the target's components, namespaces, entry points, SLO objectives, data stores, and the experiments that apply to it. No harness code names a responder service, route, or table. The heal actions stay the seven typed actions, applied to components the target definition declares.

This sits beside rule 4 (vendor names only in adapters): target names live only in target definitions.

## Consequences

- A new workload is a new `targets/<name>/` directory plus whatever telemetry and permissions it needs, not a harness change.
- Tests for the runner and agents run against at least two target definitions (the responder and a minimal fake) so a responder assumption fails a test.
- The pipeline and lifecycle stay specific to this repo. Making the whole stand-up portable to another org or account was considered and is not part of this decision.
