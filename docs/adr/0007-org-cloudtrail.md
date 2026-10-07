# 0007. Use the organization's CloudTrail trail

Status: accepted (2026-10-07)

## Context

The plan puts CloudTrail in the Guardrails stack. The workload account already sits under an organization trail that records management events in every region. A second trail would pay for a second copy of the same events and split the audit record across two buckets.

## Decision

Guardrails creates no trail. The organization trail is the account's audit log. GuardDuty reads CloudTrail management events on its own, with or without a trail.

## Consequences

- The audit log lives in the organization's bucket, outside this account, so nothing in the lab (including the agents) can read or alter it. Phase 5's explicit deny on CloudTrail still applies to the CloudTrail API.
- If the account leaves the organization, Guardrails needs a trail again.
