#!/usr/bin/env bash
# Release images, in the steps release.yml runs them. Every step is idempotent: tags are immutable, so a
# re-run finds what the first run pushed and checks it names the same thing instead of pushing again.
#   release-images.sh push  <service> <arch> <sha> <version>  build (gate's script) and push <sha>-<arch>
#   release-images.sh index <service> <sha> <version>         multi-arch index, tagged <sha> and <version>
#   release-images.sh sign  <sha> <version> <out.json>        sign + SBOM + provenance per service, verify,
#                                                             write {service: digest}
#   release-images.sh prove <images.json> <sha>               digest proof: each digest is ECR's <sha> index
#                                                             and carries our signature
# Needs REGISTRY (<account>.dkr.ecr.<region>.amazonaws.com) and AWS credentials for the build role.
set -euo pipefail
: "${REGISTRY:?REGISTRY is not set}"
KEY=awskms:///alias/tempered-lab/image-signing
PUBKEY=policy/image-signing.pub
SIGNING_CONFIG=deploy/cosign-signing-config.json # no transparency log (ADR 0009)

repo() { echo "tempered-lab/$1"; }
digest_of() { # <repo> <tag>: the digest ECR holds for a tag, or nothing
  aws ecr describe-images --repository-name "$1" --image-ids imageTag="$2" \
    --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true
}
services() { for d in services/*/Dockerfile; do basename "$(dirname "$d")"; done; }

cmd=$1
shift
case $cmd in
push)
  service=$1 arch=$2 sha=$3 version=$4
  tag="$sha-$arch"
  if [ -n "$(digest_of "$(repo "$service")" "$tag")" ]; then
    echo "::notice::$service:$tag already pushed; keeping it"
    exit 0
  fi
  .github/scripts/build-image.sh "$service" "$REGISTRY/$(repo "$service"):$tag" "$sha" "$version"
  docker push --quiet "$REGISTRY/$(repo "$service"):$tag"
  ;;

index)
  service=$1 sha=$2 version=$3
  r=$(repo "$service")
  if [ -z "$(digest_of "$r" "$sha")" ]; then
    docker buildx imagetools create -t "$REGISTRY/$r:$sha" "$REGISTRY/$r:$sha-amd64" "$REGISTRY/$r:$sha-arm64"
  fi
  digest=$(digest_of "$r" "$sha")
  [ -n "$digest" ] || { echo "::error::no index for $r:$sha"; exit 1; }
  # The version as a second tag on the same digest, without a rebuild; a re-run must find the same digest.
  tagged=$(digest_of "$r" "$version")
  if [ -z "$tagged" ]; then
    aws ecr batch-get-image --repository-name "$r" --image-ids imageDigest="$digest" --output json >manifest.json
    aws ecr put-image --repository-name "$r" --image-tag "$version" --image-digest "$digest" \
      --image-manifest "$(jq -r '.images[0].imageManifest' manifest.json)" \
      --image-manifest-media-type "$(jq -r '.images[0].imageManifestMediaType' manifest.json)" >/dev/null
    rm manifest.json
  elif [ "$tagged" != "$digest" ]; then
    echo "::error::$r:$version already names $tagged, not $digest"
    exit 1
  fi
  echo "::notice::$r $version = $sha = $digest"
  ;;

sign)
  sha=$1 version=$2 out=$3
  run="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
  echo '{}' >"$out"
  for service in $(services); do
    r=$(repo "$service")
    digest=$(digest_of "$r" "$sha")
    ref="$REGISTRY/$r@$digest"
    # SLSA v1 provenance: what was built, from which commit, by which run. Ours, signed by our key (ADR 0009).
    jq -n --arg repo "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" --arg sha "$sha" --arg version "$version" \
      --arg run "$run" --arg workflow "$GITHUB_WORKFLOW_REF" '{
        buildDefinition: {
          buildType: "https://github.com/Beekley-Technology-Solutions/tempered-lab/release/v1",
          externalParameters: { workflow: $workflow, version: $version },
          resolvedDependencies: [{ uri: ("git+" + $repo + "@" + $sha), digest: { gitCommit: $sha } }]
        },
        runDetails: { builder: { id: $workflow }, metadata: { invocationId: $run } }
      }' >provenance.json
    syft -q "$ref" -o spdx-json=sbom.spdx.json
    # Each record is a tagless OCI referrer in ECR, so immutable tags never collide.
    cosign sign --yes --key "$KEY" --signing-config "$SIGNING_CONFIG" "$ref"
    cosign attest --yes --key "$KEY" --signing-config "$SIGNING_CONFIG" --type spdxjson --predicate sbom.spdx.json "$ref"
    cosign attest --yes --key "$KEY" --signing-config "$SIGNING_CONFIG" --type slsaprovenance1 --predicate provenance.json "$ref"
    # Verify with the committed public key, the same one admission uses.
    cosign verify --key "$PUBKEY" --insecure-ignore-tlog "$ref" >/dev/null
    for type in spdxjson slsaprovenance1; do
      cosign verify-attestation --key "$PUBKEY" --insecure-ignore-tlog --type "$type" "$ref" >/dev/null
    done
    jq --arg s "$service" --arg d "$digest" '.[$s] = $d' "$out" >"$out.tmp" && mv "$out.tmp" "$out"
    rm -f provenance.json sbom.spdx.json
    echo "::notice::signed $ref (signature, SBOM, provenance verified)"
  done
  ;;

prove)
  images=$1 sha=$2
  [ "$(jq 'length' "$images")" -gt 0 ] || { echo "::error::$images names no images"; exit 1; }
  for service in $(services); do
    want=$(jq -r --arg s "$service" '.[$s] // empty' "$images")
    have=$(digest_of "$(repo "$service")" "$sha")
    [ -n "$want" ] || { echo "::error::$images has no digest for $service"; exit 1; }
    [ "$want" = "$have" ] || { echo "::error::$service: release names $want, ECR's $sha index is $have"; exit 1; }
    cosign verify --key "$PUBKEY" --insecure-ignore-tlog "$REGISTRY/$(repo "$service")@$want" >/dev/null ||
      { echo "::error::$service@$want is not signed by the release key"; exit 1; }
  done
  echo "digest proof: $(jq -r 'keys | join(", ")' "$images") match ECR and carry the release signature"
  ;;

*)
  echo "usage: release-images.sh push|index|sign|prove ..." >&2
  exit 2
  ;;
esac
