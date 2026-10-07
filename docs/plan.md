# Tempered Lab: build plan

The plan Tim agreed on, carried over from the original handover (where the project was called Chaos Discovery). Decisions that depart from it are recorded in [`adr/`](adr/), and an ADR wins over this file where they disagree.

## What this is

Tempered Lab shows how Tim believes software should be delivered, as a showpiece for a consulting practice focused on CI/CD and cloud. It also proves a model in which agents diagnose and repair a running system and are graded against faults that were injected on purpose.

The first workload is a "responder": a plain CRUD app over one resource, `items`, deliberately spread across four services so there are places for it to break. The app is a prop. The delivery pipeline, the chaos harness, and the agents are the product, and the harness targets any app, not just the responder ([ADR 0001](adr/0001-harness-targets-any-app.md)).

## How to work

- Work one phase at a time, in order. Stop at each phase's "Done when", report, and wait for Tim.
- Start each phase by restating it as a short task list and flagging anything here that looks wrong or out of date. Check vendor behaviour against current docs before relying on it. The list under "Verify before relying on it" names the known soft spots.
- One branch per task. Conventional Commits. Open pull requests as drafts and mark them ready once green, because the AI review is paid per run. Merge commits only.
- Never weaken a gate to get a green run. If a gate is wrong, say so and propose the change.
- Record any decision that departs from this file as an ADR in `docs/adr/`.
- Tim does these himself, so prepare exact commands and instructions for them: AWS account work, SSO, CDK bootstrap, the three hand-deployed stacks (pipeline, lifecycle, guardrails), creating the GitHub repos and the publisher GitHub App, the Telegram bot token, the Slack app, and Bedrock model access. Do not deploy to AWS unless the session has been given a role for it.
- Phase report: what was built, how it was verified (commands and output), what is assumed or unverified, and open questions.

## Rules that do not bend

Each has a reason. Follow the reason when a case is not covered.

1. **Two repos.** The private repo runs everything. A public mirror shows the code and the evidence and runs nothing. Every commit on `main` is published, so no secret, account ID, ARN, or domain goes in code or history. Keep them in GitHub environment variables and synthesize against placeholders.
2. **Build once, promote the same artifact.** GitHub Actions builds. CodePipeline promotes one release zip through staging to prod. GitHub never deploys, and no AWS credential ever reaches a pull request. GitHub's single role, `github-build`, can push and sign images and upload the release zip, and nothing else.
3. **No environment-specific values at build time.** One image runs in every stage and reads config by name from Parameter Store and Secrets Manager at start. The React app fetches per-stage values from a runtime `/config` call.
4. **Vendor names live only in adapters.** Not in service code, the experiment catalog, the SLO files, or agent prompts. Phase 7 swaps CloudWatch for Datadog, and that diff must touch only adapters and wiring.
5. **Agent limits live in IAM and the workflow, never in the prompt.** Agents run outside the cluster. The diagnoser is read-only. The healer can call seven typed actions and nothing else: no raw kubectl, no shell. Log and trace text is untrusted data.
6. **The lab is leased.** Everything that bills is torn down between sessions. Budget ceiling, lease length, and node architecture are single config values.
7. **Evidence over claims.** Every gate has a seeded defect that proves it, and every release gets an evidence record.

## Settled values

| Setting | Value |
| --- | --- |
| Region | us-east-1 |
| Accounts | A dedicated workload account, plus Tim's existing tools account for the pipeline |
| Compute | EKS with managed node groups, three `t3.medium`, x86. Images build multi-arch so Graviton is a config change. |
| IaC | CDK in TypeScript, `aws-eks-v2`, capacity type set to node groups explicitly |
| Services | FastAPI: gateway, responder, lookup, worker, plus a mock third party in an `external` namespace |
| Dependencies | Aurora PostgreSQL Serverless v2 (writer and reader), one ElastiCache node, SQS with a dead-letter queue |
| Chaos | AWS FIS plus scripted faults, driven by an experiment runner |
| Promotion | Staging, then prod, with no manual approval. The stage list can switch an approval step on. |
| Canary | Argo Rollouts, analysis against the SLO measures |
| Review rule | Required checks plus the adversarial AI review. No human-approval rule. |
| Security scans | Semgrep, Gitleaks, Trivy. No paid GitHub add-ons. IAST is deferred on price. |
| Signing | cosign with a KMS key, checked at admission by Kyverno |
| Agents | Step Functions and Lambda, Strands SDK, Claude on Bedrock, model ID in config |
| Chat channel | Telegram by default, Slack as a switch, behind one interface |
| Budget | $100 a month ceiling, $15 daily, four-hour default lease |

## Architecture

**Request paths.** A read runs gateway, responder, lookup, mock third party, with the cache and Aurora behind responder. A write runs gateway, responder, Aurora, then an SQS event to the worker, which writes an audit row.

**Four planes in one loop.** The runner and FIS inject faults. Services emit OpenTelemetry. SLO burn-rate alarms fire and are normalized into one `IncidentOpened` event. The diagnose agent investigates, the heal agent acts through typed actions, and a judge scores the run against the runner's ground truth.

**Nothing public runs.** The API sits on an internal load balancer reached through CloudFront. Every caller is a signed-in user or the load generator's service identity. The React UI and control room sit behind Cognito with MFA. Locust runs on Fargate inside the VPC.

## Repo layout

```
infra/            CDK app, one file per stack, stages from a list
services/         gateway/ responder/ lookup/ worker/ mock-thirdparty/
deploy/           Helm chart and rollouts
slo/              OpenSLO files, compiled per provider
policy/           admission policies, cdk-nag rules
web/              React: CRUD UI and control room
loadgen/          Locust scenarios
ops/              lifecycle steps, leftover sweep, chat bot (Telegram, Slack)
chaos/            catalog.yaml, runner/, injectors/
agents/           diagnose/ heal/ tools/ (telemetry/ has one adapter per backend) judge/
defects/          seeded bad changes, kept as patches
docs/adr/         one decision record per choice
Makefile          every CI step as a target, plus up and down
CLAUDE.md         standards the AI reviewer enforces
.github/          workflows/ scripts/build-image.sh actions/setup/
```

## Stacks

Hand-deployed and never torn down: **Pipeline** (tools account: CodePipeline V2, one CodeBuild deployer in the VPC, ECR with immutable tags, versioned release bucket, `github-build` role), **Lifecycle** (tools account: up and down state machine, lease timer, chat bot), **Guardrails** (budgets, anomaly detection, alert topic, CloudTrail, GuardDuty), **Results** (ground-truth, incident, and score tables, evidence bucket).

Come and go with the lab: **Network, Cluster, Delivery** (Argo Rollouts, Kyverno), **Data, App, Edge, Observability, Chaos, Agents**.

## Delivery pipeline

| Stage | What runs | Blocks on |
| --- | --- | --- |
| Pull request gate | Lint, strict type-check, tests with an 80% coverage floor, contract tests, models match migrations, every image built by the release's own script but not pushed, assembly synthesized with placeholder digests, cdk-nag. Under 15 minutes. No AWS credentials. | Any failure |
| Security | Semgrep, Gitleaks, Trivy (vulnerabilities and licences), diff-aware with inline comments, plus workflow linting. Full scans on main and weekly. | High or critical finding |
| Review | The org's adversarial Claude review, through workload identity federation | `VERDICT: BLOCK` |
| Release | Build once, push by digest to immutable tags, add `vMAJOR.MINOR.BUILD` to the same digest, SBOM, signature, provenance, one assembly pinned to the digests and proved by reading the templates, zip with chart and `release.json`, upload, then tag from a job that runs no repo code | Failed build, signing, digest proof, or bundle scan |
| Staging | `cdk deploy` for the stage, the chart from the same zip, the smoke script | Failed deploy or smoke |
| Prod canary | Same zip, signature checked at admission, migrations, 20% of traffic, SLO analysis | A burn, which aborts the rollout |
| Publish | Full-history scan for secrets and identifiers, then push `main` and tags to the mirror through the publisher app | Any finding |
| Nightly | Playwright and ZAP against staging, mutation tests, image rescan, drift check, posture scans, chaos suite, defect replays | Opens or updates one issue per job |

When the lab is down the pipeline records the release and stops. The next spin-up deploys the newest one. Publish runs after Release, not after the prod canary ([ADR 0003](adr/0003-publish-after-release.md)).

## Lifecycle and budget guards

One state machine in the tools account drives the pipeline's CodeBuild deployer. Commands: `/up [hours]`, `/down`, `/extend [hours]`, `/status`, from the chat channel or `make up` and `make down`.

**Up:** refuse if the ceiling is hit; deploy shared stacks, then staging and prod from the last approved release; seed data and start load; wait for traffic, then deploy SLOs and alarms; smoke; start the lease.

**Down:** refuse during an experiment or open incident unless forced; mark the lab down; uninstall Helm releases and wait for the load balancer to go; destroy lab stacks in reverse; sweep for leftovers that bill; report session cost.

**Guards:** lease timer (automatic tear-down, warning 30 minutes before); monthly budget with alerts at 50%, 80%, and forecast 100%; at 100% actual a forced tear-down and a lock on spin-up; daily budget; a daily leftover sweep while down. Budget data lags by hours, so the lease is the real guard.

The Telegram bot polls, so it adds no public endpoint. It obeys one allow-listed user ID and can only start the lifecycle machine. Slack uses signed requests to an endpoint that exists only while Slack is the active channel.

## Phases

### Phase 0: Foundations
Guardrails stack first. Two repos (private, and an empty mirror with Actions off). `github-build` role trusted only for the `build` environment by immutable repository ID. Protected `main` as in Tim's Haven repo: pull requests only, merge commits, branch up to date, every gate required. CODEOWNERS, PR template, Conventional Commits by hook and in CI, grouped Dependabot. Call the org's reusable security, AI review, and DAST workflows pinned to a SHA. Workflow hygiene: SHA-pinned actions, least-privilege permissions, concurrency groups, no untrusted input in scripts, a workflow linter. `Makefile` mirrors CI. Gitleaks in hook and CI; push protection on the mirror. Publisher GitHub App. `SECURITY.md`, licence, mirror README, `CLAUDE.md`, ADRs, `docs/threat-model.md`.
**Done when:** an empty stack deploys from the laptop, the build role can upload a release and do nothing else, a rule-breaking pull request cannot merge, and the publish job pushes a scanned commit to the mirror.

### Phase 1: Walking skeleton
Network, account baseline, cluster (API endpoint closed except Tim's address; `staging` and `prod` namespaces), add-ons, delivery stack, default-deny network policies, pipeline stack, lifecycle stack, pipeline guard. Gateway with `/healthz`, `/version`, and a stub `GET /items` on a minimal non-root image. Helm chart with a Rollout and canary step behind an internal ALB. One build script for gate and release that asserts commit and version are baked in. The full pipeline above. React shell on S3 and CloudFront with security headers and a WAF rate limit. Node architecture as one config value.
**Done when:** a merged pull request reaches staging and then prod unaided as a signed image through a canary; a hand-pushed image is refused; nothing but CloudFront answers from the internet; the released commit appears in the mirror; a tear-down then spin-up needs no manual cleanup and leaves nothing billing.

### Phase 2: Service graph and load
Data stack (staging gets its own database, queues, and cache prefix). Responder, lookup, worker, mock. Pod Identity per service. Closed API with bounded inputs. Two replicas in prod, one in staging. **Leave the first version naive about resilience: default timeouts, no retries, no circuit breaker, no spread rules. Phase 4 must find these gaps. Security is not part of that experiment.** Alembic migrations, expand then contract. React UI behind Cognito. Locust at 20 requests per second, 80% reads. Contract tests in the gate. Nightly Playwright and ZAP against staging. Bundle scan.
**Done when:** an hour of load with zero errors, a written item reaches the audit table within seconds, and one night's end-to-end and DAST runs come back clean.

### Phase 3: Observability and steady state
OpenTelemetry auto-instrumentation only. Structured logs with trace IDs. 24 hours of fault-free load to record p50, p99, and error rate. Five SLOs as OpenSLO files compiled to CloudWatch: availability and latency on `GET /items/{id}` and on `POST /items`, plus queue age. Start at 99% goals, latency thresholds about double baseline p99, rolling one-day interval. A 5-minute burn-rate alarm per SLO, threshold near 5, in one composite alarm, normalized to `IncidentOpened`. Edge alarm on ALB 5xx with missing data as breaching. A separate, looser stop alarm (ALB 5xx above 50% for five minutes) used only by FIS. Canary analysis on the same measures. Deploy markers. Delivery measures. No alarms on causes such as CPU or restarts; those are evidence for the diagnoser.
**Done when:** steady-state numbers are in the repo, every alarm has fired and cleared once, and the canary has stopped one bad build unaided.

### Phase 4: Chaos by hand
FIS access and its pod requirements, recorded as a named exception to the admission policy in the two lab namespaces. `catalog.yaml`. Injector adapters. FIS templates with the stop alarm. Scripted faults built from the defect patches as signed, experiment-only releases, never merged to main. Runner state machine that records ground truth. Run everything twice with no agent. Then harden one finding at a time and keep before and after numbers.
**Done when:** every experiment has a baseline, and what still fails to recover needs a decision: roll back, degrade, scale, or restart.

### Phase 5: Diagnose agent
`IncidentOpened` starts the workflow. Read-only typed tools through a `TelemetryProvider` interface, plus Kubernetes reads, deploy markers, and data-store status. Explicit denies on FIS, CloudTrail, and the ground-truth table. Tool wrappers strip FIS fingerprints. Output is JSON: fault class, component, evidence with the tool call behind each item, confidence, recommended action. Caps on tool calls and run time. Judge. Control room. Postmortem issue from structured fields only.
**Done when:** fault class is right in at least 80% of runs, each miss is explained, and a no-fault blip ends in `none`.

### Phase 6: Heal agent and continuous chaos
Seven typed actions with validation, dry-run, and audit. Workflow: diagnose, propose, approve in the chat channel, act, verify the alarm clears, record. Kill switch, two actions per incident, cooldowns, hourly budget. Shadow mode first. Graduate one action class at a time to automatic after ten clean runs; failover never. After a rollback, open a revert pull request and hold promotions to that service while the incident is open. Random scheduled experiments. Evidence record per release and a scoreboard, published through the evidence branch.
**Done when:** across a week of scheduled faults every decision-class fault recovers faster than its baseline, with zero harmful actions.

### Phase 7: Swap proof
Datadog adapters for the collector, SLO compiler, incident normalizer, `TelemetryProvider`, and canary analysis. Edge and stop alarms stay on CloudWatch.
**Done when:** the swap's diff touches only adapters, collector config, and one stack, and scores match the CloudWatch runs within noise.

## Reference tables

**Experiments (correct response).** One responder pod killed (none). All gateway pods killed (none; proves the edge alarm). Node terminated (none once spread). Slow third party (degraded reads). Third party unreachable (degraded reads). Cache unreachable (none if fallback holds, else scale responder). Aurora failover (none; restart only if connections stay stuck). CPU stress on responder (scale out). Worker stopped (scale it back). Poison message (none if the dead-letter queue catches it; escalate). Bad build failing at once (none; canary aborts). Bad build failing 15 minutes after promotion (roll back). Bad config, pool of one (roll back). One AZ cut off (none). Hold three or four out of tuning for final scoring. An unnecessary action counts as a failure.

**Heal actions.** `restart_rollout`, `scale_deployment` (2 to 6), `rollback_deployment`, `set_degraded_reads`, `redrive_dlq`, `failover_database` (always needs approval), `escalate`.

**Scoring.** Time to detect, diagnosis accuracy, action accuracy, time to recover against the no-agent baseline, harm.

**Seeded defects (gate that must stop each).** SQL by string concatenation (Semgrep, AI review, nightly ZAP). Committed AWS key, fake but valid in shape (Gitleaks). Dependency with a critical CVE (Trivy). Open security group in CDK (cdk-nag). Root container with no limits (Trivy config, admission). Action pinned by tag (workflow lint). Endpoint with no authorization check (AI review, contract tests). Coverage below 80% (coverage gate). Hand-pushed image (signature check). Build failing 30% of writes (canary). Secret or account ID reaching main (publish scan, mirror push protection). `pull_request_target` with a checkout (workflow lint). Assembly naming the wrong digest (digest proof). Stage URL baked into a bundle (bundle scan).

## Verify before relying on it

- `aws-eks-v2` defaults to Auto Mode, which does not support the FIS actions that terminate, stop, or reboot instances. Set node groups explicitly.
- An SLO cannot target an operation until that operation has reported metrics. Deploy SLOs after traffic.
- The ALB is created by the controller, not CloudFormation. Uninstall Helm releases before `cdk destroy`.
- FIS pod actions need `readOnlyRootFilesystem: false` on targets, and the network faults need root in the injected container.
- A dead gateway reports nothing, so SLO alarms can stay silent. The edge alarm covers it.
- If the wake-up alarm were also the FIS stop condition, the fault would lift as the agent woke. Keep them separate.
- Whether the FIS pod image runs on arm64, before any move to Graviton.
- CloudFront reaching an internal ALB, and CodeBuild reaching a cluster whose public endpoint is restricted.
- Deferred, do not build yet: IAST, and the AWS DevOps Agent baseline.
