# Tempered Lab

A lab for two ideas about running software:

1. **How it should be delivered.** Every change passes the same gates, is built once, signed, and promoted unchanged from staging to a production canary that aborts on an SLO burn. No human approval, no AWS credential near a pull request, and every gate is proved by a defect seeded to trip it.
2. **Whether agents can run it.** Faults are injected on purpose, with the ground truth recorded. A diagnose agent investigates through read-only tools; a heal agent acts through seven typed actions and nothing else. A judge scores both against what was actually injected.

The workload is a plain CRUD app split across four services so there are places for it to break. It is a prop; the pipeline, the chaos harness, and the agents are the product, and the harness is built to target other apps too.

## Status

Phase 0, foundations: guardrails, the build identity, the pull-request gate, and the publish path to this mirror. The [plan](docs/plan.md) lists all eight phases and what "done" means for each.

## How this repository works

This is a read-only mirror. The private repository runs everything; each released commit is scanned for secrets and private identifiers, then pushed here with its tag. Nothing runs in this repository.

- [Plan](docs/plan.md) · [Decisions](docs/adr/) · [Threat model](docs/threat-model.md) · [Security](SECURITY.md)

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
