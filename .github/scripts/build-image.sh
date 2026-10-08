#!/usr/bin/env bash
# Build one service image with its identity baked in, then prove it: the env vars, a non-root user, and a
# running container that reports them on /api/version. The PR gate and the release both call this, so a PR
# proves exactly what a release will build.
#   build-image.sh <service> <image ref> <git sha> <version> [extra docker build args...]
set -euo pipefail
service=$1 image=$2 sha=$3 version=$4
shift 4

docker build -f "services/$service/Dockerfile" --build-arg "TL_SHA=$sha" --build-arg "TL_VERSION=$version" \
  -t "$image" "$@" .

env=$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$image")
grep -qx "TL_SHA=$sha" <<<"$env" && grep -qx "TL_VERSION=$version" <<<"$env" ||
  { echo "::error::TL_SHA / TL_VERSION are not baked into $image"; exit 1; }
user=$(docker image inspect -f '{{.Config.User}}' "$image")
[[ -n $user && ${user%%:*} != 0 && ${user%%:*} != root ]] || { echo "::error::$image runs as root ('$user')"; exit 1; }

# Run it read-only, as the cluster will, and ask it who it is.
name=build-image-$$
docker run -d --rm --name "$name" --read-only -p 127.0.0.1::8080 "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
port=$(docker port "$name" 8080/tcp | head -1 | cut -d: -f2)
for _ in $(seq 1 30); do
  got=$(curl -fsS "http://127.0.0.1:$port/api/version" 2>/dev/null) && break
  sleep 1
done
want=$(printf '{"version":"%s","sha":"%s"}' "$version" "$sha")
[ "${got:-}" = "$want" ] || { echo "::error::/api/version said '${got:-nothing}', expected $want"; docker logs "$name" | tail -20; exit 1; }
echo "$image: $version ($sha), user $user, /api/version ok"
