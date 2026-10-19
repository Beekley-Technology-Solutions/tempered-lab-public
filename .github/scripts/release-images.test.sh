#!/usr/bin/env bash
# Pins the release's image steps (release-images.sh) against a fake ECR: push and index keep what a first run
# pushed, a version tag naming another digest fails, sign records each service's digest, and the digest
# proof fails on a wrong, missing, or unsigned digest. A re-run of sign adds only missing records, and an AWS
# error other than "no such tag" fails instead of reading as "not pushed". aws, cosign, docker, and syft are
# stubs on PATH.
set -euo pipefail
script=$(cd "$(dirname "$0")" && pwd)/release-images.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/services/a" "$work/services/b" "$work/.github/scripts"
touch "$work/services/a/Dockerfile" "$work/services/b/Dockerfile"
# ECR: "<repo> <tag> <digest>" per line; SIGNED: "<sig|attestation type> <digest>"; AWS_FAIL: an error to raise.
export ECR=$work/ecr SIGNED=$work/signed CALLS=$work/calls AWS_FAIL=
touch "$ECR" "$SIGNED" "$CALLS"

cat >"$work/.github/scripts/build-image.sh" <<'SH'
#!/usr/bin/env bash
echo "build $*" >>"$CALLS"
SH
cat >"$work/bin/aws" <<'SH'
#!/usr/bin/env bash
op=$2
shift 2
while [ $# -gt 0 ]; do
  case $1 in --repository-name) r=$2 ;; --image-ids) id=$2 ;; --image-tag) t=$2 ;; --image-digest) d=$2 ;; esac
  shift
done
[ -z "$AWS_FAIL" ] || { echo "An error occurred ($AWS_FAIL)" >&2; exit 254; }
case $op in
describe-images) awk -v r="$r" -v t="${id#imageTag=}" '$1 == r && $2 == t { print $3; f = 1 } END { exit !f }' "$ECR" ||
  { echo "An error occurred (ImageNotFoundException)" >&2; exit 254; } ;;
batch-get-image) echo '{"images":[{"imageManifest":"{}","imageManifestMediaType":"application/vnd.oci.image.index.v1+json"}]}' ;;
put-image) echo "$r $t $d" >>"$ECR" ;;
esac
SH
cat >"$work/bin/cosign" <<'SH'
#!/usr/bin/env bash
ref=${*: -1} kind=sig
[[ $* =~ --type\ ([a-z0-9]+) ]] && kind=${BASH_REMATCH[1]}
echo "cosign $1 $kind $ref" >>"$CALLS"
case $1 in
sign | attest) [ -n "${COSIGN_DROP:-}" ] || echo "$kind ${ref#*@}" >>"$SIGNED" ;; # DROP: signs, records nothing
verify | verify-attestation) grep -qxF "$kind ${ref#*@}" "$SIGNED" ;;
esac
SH
cat >"$work/bin/docker" <<'SH'
#!/usr/bin/env bash
echo "docker $*" >>"$CALLS"
if [ "$1 $2" = "buildx imagetools" ]; then
  ref=${5#*/}
  echo "${ref%:*} ${ref##*:} sha256:index-${ref%:*}" | sed 's#index-tempered-lab/#index-#' >>"$ECR"
fi
SH
printf '#!/usr/bin/env bash\n' >"$work/bin/syft"
chmod +x "$work"/bin/* "$work/.github/scripts/build-image.sh"

export PATH=$work/bin:$PATH REGISTRY=registry.example GITHUB_SERVER_URL=https://github.example \
  GITHUB_REPOSITORY=org/repo GITHUB_RUN_ID=1 GITHUB_WORKFLOW_REF=org/repo/.github/workflows/release.yml@refs/heads/main
expect() { # $1 pass|fail, $2 description, then the script's arguments
  local want=$1 what=$2 rc=0
  shift 2
  (cd "$work" && "$script" "$@") >/dev/null 2>&1 || rc=$?
  if { [ "$want" = pass ] && [ $rc != 0 ]; } || { [ "$want" = fail ] && [ $rc = 0 ]; }; then
    echo "release-images: expected $want for $what"
    exit 1
  fi
}
fail() { echo "release-images: $1"; exit 1; }

echo "tempered-lab/a abc-amd64 sha256:old" >>"$ECR"
AWS_FAIL=ThrottlingException expect fail "an AWS error that isn't \"no such tag\"" push a arm64 abc v1.0.1
grep -q "build\|docker push" "$CALLS" && fail "push built after an AWS error"
expect pass "a push whose tag is already in ECR" push a amd64 abc v1.0.1
grep -q "build\|docker push" "$CALLS" && fail "push rebuilt a tag ECR already has"
expect pass "a push of a new tag" push a arm64 abc v1.0.1
grep -q "^build a registry.example/tempered-lab/a:abc-arm64 abc v1.0.1$" "$CALLS" || fail "push didn't build"
grep -q "^docker push --quiet registry.example/tempered-lab/a:abc-arm64$" "$CALLS" || fail "push didn't push"

expect pass "a first index" index a abc v1.0.1
expect pass "an index of b" index b abc v1.0.1
grep -q "^tempered-lab/a v1.0.1 sha256:index-a$" "$ECR" || fail "index didn't tag the version on the index digest"
expect pass "a re-run of index" index a abc v1.0.1
[ "$(grep -c " v1.0.1 " "$ECR")" = 2 ] || fail "a re-run of index tagged the version again"
echo "tempered-lab/a v1.0.2 sha256:other" >>"$ECR"
expect fail "a version tag naming another digest" index a abc v1.0.2

expect pass "signing every service" sign abc v1.0.1 images.json
[ "$(jq -c . "$work/images.json")" = '{"a":"sha256:index-a","b":"sha256:index-b"}' ] || fail "sign wrote $(cat "$work/images.json")"
for kind in sig spdxjson slsaprovenance1; do
  grep -qxF "$kind sha256:index-b" "$SIGNED" || fail "sign didn't add $kind to b"
done
: >"$CALLS"
expect pass "a re-run of sign" sign abc v1.0.1 images.json
grep -E -q "^cosign (sign|attest) " "$CALLS" && fail "a re-run of sign signed again"
sed -i.bak '/^slsaprovenance1 sha256:index-a$/d' "$SIGNED"
expect pass "a re-run of sign after a partial run" sign abc v1.0.1 images.json
[ "$(grep -E "^cosign (sign|attest) " "$CALLS")" = "cosign attest slsaprovenance1 registry.example/tempered-lab/a@sha256:index-a" ] ||
  fail "a partial re-run should add only a's provenance"
sed -i.bak '/^sig sha256:index-b$/d' "$SIGNED"
COSIGN_DROP=1 expect fail "a signature that doesn't verify once made" sign abc v1.0.1 dropped.json
echo "sig sha256:index-b" >>"$SIGNED"

expect pass "the digest proof of a signed release" prove images.json abc
jq '.a = "sha256:other"' "$work/images.json" >"$work/wrong.json"
expect fail "a release naming another digest" prove wrong.json abc
jq 'del(.b)' "$work/images.json" >"$work/missing.json"
expect fail "a release missing a service" prove missing.json abc
echo '{}' >"$work/empty.json"
expect fail "a release naming no images" prove empty.json abc
sed -i.bak '/^sig sha256:index-b$/d' "$SIGNED"
expect fail "an unsigned image" prove images.json abc
rm -r "$work/services"
expect fail "a release of no services naming no images" prove empty.json abc
echo "release-images: ok"
