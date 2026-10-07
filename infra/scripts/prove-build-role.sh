#!/usr/bin/env bash
# Evidence for "the build role can upload a release and do nothing else": asks IAM's policy simulator
# about every action the role needs and a list of things it must never do. Needs read access to IAM in
# the tools account (run by Tim, not CI: the build role itself can't call the simulator).
#   AWS_PROFILE=<tools> infra/scripts/prove-build-role.sh
set -euo pipefail
out() { aws cloudformation describe-stacks --stack-name TemperedLabPipeline --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
role=$(out BuildRoleArn) bucket=$(out ReleaseBucket) key=$(out SigningKeyArn)
account=$(cut -d: -f5 <<<"$role") region=$(cut -d: -f4 <<<"$key")
repo="arn:aws:ecr:$region:$account:repository/tempered-lab/gateway"
release="arn:aws:s3:::$bucket/releases/tempered-lab.zip"

fail=0
check() { # check <allowed|implicitDeny> <action> <resource>
  local got
  got=$(aws iam simulate-principal-policy --policy-source-arn "$role" --action-names "$2" --resource-arns "$3" \
    --query 'EvaluationResults[0].EvalDecision' --output text)
  printf '%-14s %-38s %s\n' "$got" "$2" "${3##*:}"
  [ "$got" = "$1" ] || { echo "  ^ expected $1"; fail=1; }
}

echo "== must be allowed"
for a in ecr:PutImage ecr:InitiateLayerUpload ecr:UploadLayerPart ecr:CompleteLayerUpload ecr:BatchGetImage ecr:DescribeImages; do check allowed "$a" "$repo"; done
check allowed ecr:GetAuthorizationToken "*"
for a in kms:Sign kms:GetPublicKey; do check allowed "$a" "$key"; done
check allowed s3:PutObject "$release"

echo "== must be denied"
check implicitDeny s3:PutObject "arn:aws:s3:::$bucket/releases/other.zip"
for a in s3:GetObject s3:DeleteObject s3:PutObjectAcl s3:DeleteObjectVersion; do check implicitDeny "$a" "$release"; done
for a in s3:PutBucketPolicy s3:DeleteBucket s3:PutBucketVersioning; do check implicitDeny "$a" "arn:aws:s3:::$bucket"; done
for a in ecr:BatchDeleteImage ecr:DeleteRepository ecr:SetRepositoryPolicy ecr:PutImageTagMutability ecr:PutLifecyclePolicy; do check implicitDeny "$a" "$repo"; done
check implicitDeny ecr:CreateRepository "arn:aws:ecr:$region:$account:repository/tempered-lab/new"
check implicitDeny ecr:PutImage "arn:aws:ecr:$region:$account:repository/other/repo"
for a in kms:Decrypt kms:Encrypt kms:ScheduleKeyDeletion kms:PutKeyPolicy kms:CreateGrant; do check implicitDeny "$a" "$key"; done
check implicitDeny sts:AssumeRole "arn:aws:iam::$account:role/cdk-hnb659fds-deploy-role-$account-$region"
check implicitDeny iam:PassRole "arn:aws:iam::$account:role/any"
check implicitDeny iam:CreateRole "arn:aws:iam::$account:role/any"
for a in cloudformation:CreateStack cloudformation:UpdateStack codepipeline:StartPipelineExecution codebuild:StartBuild eks:DescribeCluster ssm:GetParameter secretsmanager:GetSecretValue; do
  check implicitDeny "$a" "*"
done

[ "$fail" = 0 ] && echo "PASS: $role can push, sign, and upload the release, and nothing else checked." || { echo "FAIL"; exit 1; }
