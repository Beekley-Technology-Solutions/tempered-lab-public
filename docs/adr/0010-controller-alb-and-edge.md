# 0010. The ALB belongs to the load balancer controller; the edge finds it by name

Status: accepted (2026-10-08)

## Context

Prod canaries send 20% of traffic to the new version and analyse it. Argo Rollouts can split traffic exactly only on an ALB managed by the AWS Load Balancer Controller through an Ingress. CloudFront must reach that ALB, which is internal, through a VPC origin, and a VPC origin needs the ALB's ARN and the ALB to be active first.

## Decision

- One internal ALB, created by the controller from an Ingress group with a fixed load balancer name, serves both stages (path or host rules per stage).
- Argo Rollouts uses its ALB traffic routing: the canary step is a real 20% weight.
- The Edge stack is deployed after the charts. It looks the ALB up by its fixed name at deploy time and creates the VPC origin from it. The ALB's security group admits only CloudFront's origin-facing prefix list.
- Tear-down uninstalls the Helm releases and waits for the ALB to go before destroying the stacks (already in the plan).

The alternative, a CloudFormation-owned ALB with pods attached by TargetGroupBinding, was rejected: without a traffic router the canary weight is approximated by replica counts.

## Consequences

- Spin-up order: cluster → delivery → charts → edge. A VPC origin takes up to 15 minutes to create.
- Recreating the Ingress group changes the ALB's ARN, which forces a VPC-origin update; the group is never deleted outside tear-down.
- The VPC avoids `use1-az3`, where VPC origins are not supported (zone names map to zone IDs per account; see `infra/lib/config.ts`).
