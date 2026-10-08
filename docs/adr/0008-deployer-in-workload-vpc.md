# 0008. The deployer runs in the workload VPC, not the tools account

Status: accepted (2026-10-08)

## Context

The plan puts "one CodeBuild deployer in the VPC" in the Pipeline stack, which lives in the tools account. The deployer has to run Helm against the cluster, watch the Argo Rollouts canary, and run the smoke script. The cluster's API is private, with the public endpoint limited to Tim's address. A tools-account build can't get there: CodeBuild doesn't support shared VPC subnets, and CodeBuild's published IP ranges are shared by every customer in the region, so allow-listing them would open the endpoint to all of them.

## Decision

The deployer is a CodeBuild project in the workload account's lab VPC, created by the Delivery stack and torn down with the lab. CodePipeline in the tools account invokes it as a cross-account action through a role in the workload account. Its EKS access entry is limited to the `staging` and `prod` namespaces. CloudFormation deploys still run from the tools account through the CDK bootstrap roles.

CodePipeline's built-in EKS deploy action was considered: it can run Helm in the workload subnets, but a second mechanism would still be needed to watch the canary and run the smoke script.

## Consequences

- Cross-account actions need a customer-managed KMS key on the pipeline's artifact bucket (`crossAccountKeys: true`), about $1 a month.
- While the lab is down the project doesn't exist; the pipeline's stage-entry condition skips the deploy stages (the "pipeline guard").
