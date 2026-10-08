# Built by .github/scripts/build-image.sh, the same script in the PR gate and the release.
# Dependencies go into a plain directory (not a venv) so the runtime doesn't need the build stage's interpreter.
FROM ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21 AS uv

FROM python:3.13-slim-trixie@sha256:bf44cdfcb76cd3b41e879bc058fc37ec5872002ccfde7fcb765e218cde0cd79c AS build
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /src
COPY pyproject.toml uv.lock ./
COPY services/gateway services/gateway
RUN uv export --frozen --no-dev --no-emit-workspace --package gateway -o /tmp/requirements.txt \
 && uv pip install --no-cache --target /app -r /tmp/requirements.txt \
 && cp -r services/gateway/src/gateway /app/gateway

# Distroless: no shell, no package manager, runs as uid 65532.
FROM gcr.io/distroless/python3-debian13:nonroot@sha256:774595d652a294b54c9bd575b2d9fdd1a4b47547dc17b8bfa4c0e953c64855b3
COPY --from=build /app /app
ARG TL_VERSION TL_SHA
ENV PYTHONPATH=/app PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TL_VERSION=${TL_VERSION} TL_SHA=${TL_SHA}
LABEL org.opencontainers.image.version=${TL_VERSION} org.opencontainers.image.revision=${TL_SHA}
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["python3", "-m", "uvicorn", "gateway.app:app", "--host", "0.0.0.0", "--port", "8080", "--no-server-header"]
