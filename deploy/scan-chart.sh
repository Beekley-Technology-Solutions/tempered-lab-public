#!/usr/bin/env bash
# Chart gate: lint and render every stage, then Trivy's Kubernetes checks on the result, failing on any
# finding at any severity. Trivy only checks built-in workload kinds, so each Rollout is relabelled a
# Deployment for the scan (same pod template); otherwise a root, privileged, limitless pod would pass.
#   deploy/scan-chart.sh        (TRIVY overrides the binary)
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
# Placeholders shaped like the real thing: an ECR repository and a digest.
image=(--set image.repository=111111111111.dkr.ecr.us-east-1.amazonaws.com/tempered-lab/gateway
  --set "image.digest=sha256:$(printf %064d 0)")

for values in deploy/chart/values-*.yaml; do
  stage=$(basename "$values" .yaml); stage=${stage#values-}
  helm lint deploy/chart --strict -f "$values" "${image[@]}" >/dev/null
  helm template gateway deploy/chart -n "$stage" -f "$values" "${image[@]}" |
    sed -e 's#^apiVersion: argoproj.io/v1alpha1$#apiVersion: apps/v1#' -e 's#^kind: Rollout$#kind: Deployment#' \
      >"$out/$stage.yaml"
done
grep -q "^kind: Deployment" "$out"/*.yaml || { echo "::error::no workloads rendered"; exit 1; }
"${TRIVY:-trivy}" config --exit-code 1 --quiet "$out"
echo "chart: $(ls "$out" | wc -l | tr -d ' ') stages rendered, lint and Trivy clean"
