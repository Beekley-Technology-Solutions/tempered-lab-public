#!/usr/bin/env bash
# Pins deploy/cosign-signing-config.json to ADR 0009 with the real cosign: a signature made with it verifies
# only when the transparency log is ignored, so nothing was logged. Seeded defect: a config naming a Rekor log
# (an unreachable local one, never the public log) makes signing reach for it, so cosign reads the config.
# Throwaway key and a local registry; needs Docker and cosign, no network beyond pulling the registry image.
# If the config ever named the public log, the first sign would put one throwaway entry there and fail here.
set -euo pipefail
config=$(cd "$(dirname "$0")/../.." && pwd)/deploy/cosign-signing-config.json
image=registry@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8 # registry:3
work=$(mktemp -d)
cid=$(docker run -d --rm -p 127.0.0.1::5000 "$image")
trap 'docker stop "$cid" >/dev/null; rm -rf "$work"' EXIT
ref=localhost:$(docker port "$cid" 5000 | cut -d: -f2)/img:1
docker tag "$image" "$ref" && docker push -q "$ref" >/dev/null # the registry image, pushed into itself
export COSIGN_PASSWORD=
(cd "$work" && cosign generate-key-pair >/dev/null 2>&1)
fail() { echo "signing-config: $1"; exit 1; }

cosign sign --yes --key "$work/cosign.key" --signing-config "$config" "$ref" >/dev/null 2>&1 ||
  fail "signing with the repo's config failed"
cosign verify --key "$work/cosign.pub" --insecure-ignore-tlog "$ref" >/dev/null 2>&1 ||
  fail "the signature doesn't verify"
cosign verify --key "$work/cosign.pub" "$ref" >/dev/null 2>&1 &&
  fail "the signature has a transparency log entry"

cat >"$work/rekor.json" <<'JSON'
{ "mediaType": "application/vnd.dev.sigstore.signingconfig.v0.2+json",
  "rekorTlogUrls": [{ "url": "http://127.0.0.1:9", "majorApiVersion": 1, "validFor": { "start": "2020-01-01T00:00:00Z" }, "operator": "test" }],
  "rekorTlogConfig": { "selector": "ANY" }, "tsaConfig": {} }
JSON
out=$(cosign sign --yes --timeout 30s --key "$work/cosign.key" --signing-config "$work/rekor.json" "$ref" 2>&1) &&
  fail "a config naming a log still signed, so cosign ignores the config"
[[ $out == *127.0.0.1:9* ]] || fail "a config naming a log failed for another reason: $out"
echo "signing-config: ok"
