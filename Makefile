# Every CI step is a target here, so a laptop runs exactly what the gate runs.
# Identifiers and AWS profiles come from .env (git-ignored; see docs/bootstrap.md).
-include .env
export

ZIZMOR := uvx zizmor@1.30.1
ACTIONLINT := uvx --from actionlint-py==1.7.12.25 actionlint
BASE ?= origin/main
HEAD ?= HEAD

.PHONY: install hooks check lint typecheck test synth workflow-lint commits \
        deploy-guardrails deploy-pipeline prove-build-role denylist scan-history

install:
	pnpm install --frozen-lockfile

hooks:
	git config core.hooksPath .githooks

# The PR gate, in the order CI runs it.
check: lint typecheck test synth workflow-lint

lint:
	pnpm lint

typecheck:
	pnpm typecheck

test:
	pnpm test
	.github/scripts/denylist.test.sh
	.github/scripts/scan-history.test.sh

# Placeholder identifiers, no AWS credentials. cdk-nag findings fail synth.
synth:
	cd infra && TL_PLACEHOLDERS=1 pnpm cdk synth --quiet

# actionlint predates GitHub's `$/` self-repository syntax (rhysd/actionlint#711); ignore only that message.
workflow-lint:
	$(ACTIONLINT) -ignore 'specifying action "\$$/'
	$(ZIZMOR) --offline .github

commits:
	git log --format=%s --no-merges $(BASE)..$(HEAD) | .github/scripts/check-commits.sh

# Hand-deployed, never torn down. Profiles are SSO profiles named in .env.
deploy-guardrails:
	cd infra && pnpm cdk deploy TemperedLabGuardrails --profile $(TL_WORKLOAD_PROFILE)

deploy-pipeline:
	cd infra && pnpm cdk deploy TemperedLabPipeline --profile $(TL_TOOLS_PROFILE)

prove-build-role:
	AWS_PROFILE=$(TL_TOOLS_PROFILE) infra/scripts/prove-build-role.sh

# The deny list: every identifier in .env (the admin CIDR as its bare address) plus PUBLISH_DENYLIST_EXTRA, one per line. One definition for
# both the local gate and the PUBLISH_DENYLIST secret (bootstrap step 5), so the two can't drift.
DENYLIST = printf '%s\n' "$(TL_TOOLS_ACCOUNT)" "$(TL_WORKLOAD_ACCOUNT)" "$(TL_ALERT_EMAIL)" $(firstword $(subst /, ,$(TL_ADMIN_CIDR))) $(PUBLISH_DENYLIST_EXTRA)

denylist:
	@$(DENYLIST)

# The publish gate, locally.
scan-history:
	@PUBLISH_DENYLIST="$$($(DENYLIST))" .github/scripts/scan-history.sh
