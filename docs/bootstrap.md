# Bootstrap: one-time setup Tim does by hand

Commands for everything the pipeline can't do for itself. Values in `<ANGLE_BRACKETS>` are yours. Nothing here is a secret except where noted; none of it goes in a tracked file. Real values go in `.env` (copy `.env.example`) and in GitHub variables.

Order matters: AWS checks → GitHub repos → AWS stacks → GitHub variables → first PR.

## 1. Workload account

Create the account in the organization and give your SSO user a permission set in it. Add a profile to `~/.aws/config`:

```ini
[profile tempered-lab]
sso_session = <your session>
sso_account_id = <WORKLOAD_ACCOUNT>
sso_role_name = AdministratorAccess
region = us-east-1
```

```bash
aws sso login --sso-session <your session>
```

Open Billing → Cost Explorer once in the new account. Cost Anomaly Detection needs Cost Explorer turned on, and the first time can take up to a day.

### Check what the organization already provides

Guardrails creates a GuardDuty detector, a CloudTrail trail, and (unless told otherwise) an anomaly monitor. If the organization already provides one of these, Guardrails would either fail to deploy or pay twice, so check first:

```bash
aws guardduty list-detectors --profile tempered-lab
aws cloudtrail describe-trails --profile tempered-lab \
  --query 'trailList[].{name:Name,org:IsOrganizationTrail,multiRegion:IsMultiRegionTrail}'
aws ce get-anomaly-monitors --profile tempered-lab \
  --query 'AnomalyMonitors[].[MonitorName,MonitorDimension,MonitorArn]' --output text
```

- A detector ID listed → GuardDuty is already on (probably the org's delegated admin). Tell Claude; the detector comes out of the stack.
- An organization trail listed → tell Claude; the trail comes out of the stack.
- A monitor with dimension `SERVICE` listed → put its ARN in `.env` as `TL_ANOMALY_MONITOR_ARN`. AWS allows only one per account.

### CDK bootstrap

The tools account is already bootstrapped (Haven). The workload account trusts the tools account so the pipeline can deploy into it from Phase 1:

```bash
cd infra
pnpm cdk bootstrap aws://<WORKLOAD_ACCOUNT>/us-east-1 --profile tempered-lab --trust <TOOLS_ACCOUNT> \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

## 2. GitHub: the private repo

```bash
gh repo create Beekley-Technology-Solutions/tempered-lab --private --disable-wiki \
  --description "Delivery pipeline, chaos harness, and repair agents, graded against injected faults"
R=Beekley-Technology-Solutions/tempered-lab

# Merge commits only; "Update branch" allowed so branches can be brought up to date.
gh repo edit $R --enable-merge-commit --enable-squash-merge=false --enable-rebase-merge=false \
  --delete-branch-on-merge --allow-update-branch

# Immutable OIDC subject (org@id/repo@id): survives renames, can't be claimed by a re-created repo.
gh api -X PUT repos/$R/actions/oidc/customization/sub -F use_default=true -F use_immutable_subject=true
gh api repos/$R/actions/oidc/customization/sub -q .sub_claim_prefix   # → TL_REPO_SUBJECT in .env

# Environments, both limited to main.
for env in build publish; do
  gh api -X PUT repos/$R/environments/$env \
    -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
  gh api -X POST repos/$R/environments/$env/deployment-branch-policies -f name=main -f type=branch
done
```

Push the bootstrap commit (Claude prepared it locally) before the ruleset exists, then add the ruleset:

```bash
cd ~/Code/BeekleyEngineering/tempered-lab
git remote add origin git@github.com:$R.git
git push -u origin main
gh api -X POST repos/$R/rulesets --input docs/rulesets/private-main.json
```

[`rulesets/private-main.json`](rulesets/private-main.json) mirrors Haven's: pull requests only, merge commits only, branch up to date, every gate required, no deletion or force push. Unlike Haven it has **no bypass actor**, so an admin cannot merge around a red gate either; add `"bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request"}]` if you want an emergency door.

## 3. GitHub: the public mirror

`<MIRROR_OWNER>/<MIRROR_REPO>` is still open: a public repo can't share the private repo's name in the same org.

```bash
M=<MIRROR_OWNER>/<MIRROR_REPO>
gh repo create $M --public --disable-wiki --disable-issues \
  --description "Read-only mirror of Tempered Lab. Nothing runs here."
gh api -X PUT repos/$M/actions/permissions -F enabled=false                       # Actions off
gh api -X PATCH repos/$M -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'       # free on public repos
gh api -X PUT repos/$M/private-vulnerability-reporting                             # SECURITY.md points here
```

### The publisher GitHub App

Apps are created in the browser: Settings (of `<MIRROR_OWNER>`) → Developer settings → GitHub Apps → New.

- Name: `tempered-lab-publisher`. Homepage: the mirror URL. Webhook: **off**.
- Repository permissions: **Contents: Read and write**, **Workflows: Read and write** (the mirror carries `.github/workflows`), Metadata: Read. Nothing else.
- Where can it be installed: only on this account.
- Create, then **Generate a private key** (downloads a `.pem`), note the **Client ID** and the numeric **App ID**.
- Install it on **only** `<MIRROR_REPO>`.

Then lock the mirror so only the app can write to it:

```bash
APP_ID=<numeric app id>
for f in docs/rulesets/mirror-main.json docs/rulesets/mirror-tags.json; do   # branches, then tags
  sed "s/\"APP_ID\"/$APP_ID/" $f | gh api -X POST repos/$M/rulesets --input -
done
```

## 4. AWS stacks

Fill in `.env` (all of it), then:

```bash
make install
make deploy-guardrails     # workload account. Confirm the SNS subscription email when it arrives.
make deploy-pipeline       # tools account: ECR, signing key, release bucket, github-build
make prove-build-role      # IAM simulator: must print PASS
```

The `TemperedLabPipeline` outputs are the build role ARN and the release bucket name for step 5.

## 5. GitHub variables and secrets

```bash
R=Beekley-Technology-Solutions/tempered-lab
set -a; source .env; set +a

# build environment: what release.yml synthesizes with and uploads to.
for v in TL_TOOLS_ACCOUNT TL_WORKLOAD_ACCOUNT TL_ALERT_EMAIL TL_REPO_SUBJECT TL_ANOMALY_MONITOR_ARN; do
  [ -n "${!v}" ] && gh variable set $v --env build -R $R --body "${!v}"
done
gh variable set BUILD_ROLE_ARN --env build -R $R --body "<BuildRoleArn output>"
gh variable set RELEASE_BUCKET --env build -R $R --body "<ReleaseBucket output>"

# AI review: the same federation as Haven (the org rule matches every repo in the org). Copy the four
# IDs from Haven's .github/workflows/ai-review.yml.
for v in ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID ANTHROPIC_SERVICE_ACCOUNT_ID ANTHROPIC_WORKSPACE_ID; do
  gh variable set $v -R $R --body "<value>"
done

# publish environment.
gh variable set PUBLISHER_CLIENT_ID --env publish -R $R --body "<client id>"
gh variable set MIRROR_OWNER --env publish -R $R --body "<MIRROR_OWNER>"
gh variable set MIRROR_REPO --env publish -R $R --body "<MIRROR_REPO>"
gh secret set PUBLISHER_PRIVATE_KEY --env publish -R $R < ~/Downloads/<app>.private-key.pem   # secret
# The deny list: every real identifier that must never reach the mirror, one per line. A secret so the
# values aren't readable in settings. Add domains and anything else private.
printf '%s\n' "$TL_TOOLS_ACCOUNT" "$TL_WORKLOAD_ACCOUNT" "$TL_ALERT_EMAIL" | gh secret set PUBLISH_DENYLIST --env publish -R $R
```

Then delete the `.pem` from Downloads.

## 6. Commit identity

Every commit's author email is published. If you don't want `tim@…` on the mirror, use your GitHub noreply address in this repo, and in GitHub → Settings → Emails tick "Keep my email addresses private" so merges made in the browser use it too:

```bash
git config user.email "<id>+TCBeekley@users.noreply.github.com"
```

If the deny list holds your email, `scan-history` refuses any commit authored with it, so decide before the first push.

## 7. Laptop

```bash
brew install gitleaks uv
make hooks
```
