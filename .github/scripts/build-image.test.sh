#!/usr/bin/env bash
# Pins the image gate (build-image.sh): a good image passes; an image running as root, one without the
# build identity baked in, and one that doesn't answer /api/version with it each fail. Builds throwaway
# images from a tiny service, so it needs Docker but not the real services.
set -euo pipefail
script=$(cd "$(dirname "$0")" && pwd)/build-image.sh
work=$(mktemp -d)
trap 'rm -rf "$work"; docker image rm -f build-image-test:good build-image-test:root build-image-test:noid build-image-test:wrong >/dev/null 2>&1 || true' EXIT
mkdir -p "$work/services/svc"
# A stand-in service: python's http.server answering /api/version from the baked environment.
cat >"$work/services/svc/app.py" <<'PY'
import json, os
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"version": os.environ.get("ANSWER_VERSION", os.environ.get("TL_VERSION")), "sha": os.environ.get("TL_SHA")}, separators=(",", ":")).encode()
        self.send_response(200 if self.path == "/api/version" else 404); self.end_headers(); self.wfile.write(body)
HTTPServer(("0.0.0.0", 8080), H).serve_forever()
PY
dockerfile() { # $1 user, $2 extra ENV line, $3 bake identity (yes/no)
  {
    echo "FROM python:3.13-slim-trixie@sha256:bf44cdfcb76cd3b41e879bc058fc37ec5872002ccfde7fcb765e218cde0cd79c"
    echo "COPY services/svc/app.py /app.py"
    [ "$3" = yes ] && { echo "ARG TL_VERSION TL_SHA"; echo 'ENV TL_VERSION=${TL_VERSION} TL_SHA=${TL_SHA}'; }
    [ -n "$2" ] && echo "$2"
    echo "USER $1"
    echo 'ENTRYPOINT ["python3", "/app.py"]'
  } >"$work/services/svc/Dockerfile"
}
expect() { # $1 pass|fail, $2 description, $3 tag
  local rc=0
  (cd "$work" && "$script" svc "build-image-test:$3" abc123 v9.9.9) >/dev/null 2>&1 || rc=$?
  if { [ "$1" = pass ] && [ $rc != 0 ]; } || { [ "$1" = fail ] && [ $rc = 0 ]; }; then
    echo "build-image: expected $1 for $2"; exit 1
  fi
}

dockerfile 65532 "" yes;                          expect pass "a good image" good
dockerfile 0 "" yes;                              expect fail "an image running as root" root
dockerfile 65532 "" no;                           expect fail "an image without the build identity" noid
dockerfile 65532 "ENV ANSWER_VERSION=v0.0.0" yes; expect fail "an image answering with another version" wrong
echo "build-image: ok"
