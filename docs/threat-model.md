# Threat model

Scope: Phase 0 (the repositories, the pipeline identity, and the publish path), with the later phases' threats listed so they have an owner. Updated whenever a phase adds a trust boundary.

## Assets

| Asset | Why it matters |
| --- | --- |
| The tools account | Holds the pipeline, ECR, release bucket, and signing key, and is shared with other projects |
| The workload account | Runs the lab; a compromise bills, and reaches the data and the agents' permissions |
| The image signing key | A signature is what admission trusts (Phase 1) |
| The release zip | What CodePipeline deploys, unchanged, to staging and prod |
| The private repo's history | Holds identifiers that must never reach the mirror |
| The publisher app key | Can write to the public mirror |
| The budget | $100 a month; a leaked or runaway resource spends it |

## Trust boundaries

1. **Pull request → CI.** Code from a branch runs in the PR gate with a read-only token and no AWS credentials.
2. **`main` → AWS.** Only jobs in the `build` environment (limited to `main`) can assume `github-build`, matched by immutable repository ID.
3. **Private → public.** The publish jobs move commits across; the scan stands between.
4. **AWS release → environments.** CodePipeline in the tools account deploys through the workload account's CDK bootstrap roles (Phase 1).
5. **Telemetry → agents.** Log and trace text is attacker-influenced input to a model (Phase 5).
6. **Chat → lifecycle.** A chat message can start or stop the lab (Phase 1).

## Threats and controls

| # | Threat | Control | Proved by |
| --- | --- | --- | --- |
| T1 | A PR exfiltrates AWS credentials | PR workflows have no `id-token` and no AWS role; the role's trust requires `environment:build` | Trust-policy assertion in `infra/lib/stacks.test.ts` |
| T2 | A forked or renamed repo assumes the role | Exact `sub` match on the immutable `org@id/repo@id` subject | Same test; `prove-build-role.sh` |
| T3 | The build role is used to deploy, delete, or read | Identity policy limited to ECR push to our repos, `kms:Sign`, and `PutObject` on one key | Exact action-list assertion; IAM simulator run in `prove-build-role.sh` |
| T4 | A re-run or attacker replaces a promoted image | ECR tags immutable; the assembly pins digests (Phase 1) | ECR config assertion; digest proof in release (Phase 1) |
| T5 | A compromised third-party action | Every action pinned by SHA, in-repo actions by `$/`; zizmor in the gate; Dependabot with a 7-day cooldown | Seeded tag-pinned action |
| T6 | `pull_request_target` runs PR code with secrets | zizmor `dangerous-triggers` | Seeded workflow |
| T7 | Event data injected into a `run:` script | Event fields reach scripts only through `env:`; zizmor `template-injection` | Gate |
| T8 | A secret or identifier reaches the mirror | Identifiers only in environment variables; Gitleaks in hook, PR, and full history; deny list of real values over every file, message, author, and tag; push protection on the mirror | Seeded AWS key and account ID |
| T9 | The publisher key writes elsewhere | App installed on the mirror only; token requested for that one repo; the job that holds it runs no repo code | Workflow review |
| T10 | Tag or release metadata leaks the registry or account | `release.json` and tag messages carry version, SHA, and run URL only | Scan T8 |
| T11 | A malicious dependency in the gate | Frozen lockfile; Trivy; Dependabot cooldown; no install scripts approved by pnpm | Seeded CVE dependency |
| T12 | Runaway spend | Budgets (monthly and daily) to the alert topic; anomaly detection; lease and forced tear-down (Phase 1) | Alerts fire once in Phase 3 |
| T13 | Account compromise goes unnoticed | CloudTrail (all regions, file validation); GuardDuty with EKS audit logs; high-severity findings to the alert topic | — |
| T14 | The AI reviewer is steered by the PR | The reviewer never sees the title, description, or commits; only the diff and linked issue | Org action design |

## Later phases (owner noted, not yet controlled)

- **Admission bypass** (Phase 1): Kyverno verifies the cosign signature against the KMS public key; a hand-pushed image is the seeded defect.
- **Cluster endpoint exposure** (Phase 1): public endpoint limited to Tim's address; CodeBuild's path to it is a listed soft spot.
- **Chat hijack** (Phase 1): one allow-listed user ID; the bot can only start the lifecycle machine; Telegram polls, so there's no endpoint.
- **Prompt injection through telemetry** (Phase 5): the diagnoser is read-only by IAM, tool output is data, and FIS fingerprints are stripped.
- **A harmful heal action** (Phase 6): seven typed, validated actions; two per incident; cooldowns; a kill switch; failover always needs approval.
- **FIS as a privilege path** (Phase 4): the FIS role is the named exception to admission policy, in the two lab namespaces only.
