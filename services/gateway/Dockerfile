# Built by .github/scripts/build-image.sh, the same script in the PR gate and the release.
# Dependencies go into a plain directory (not a venv) so the runtime doesn't need the build stage's interpreter.
FROM ghcr.io/astral-sh/uv:0.13.1@sha256:4a1f3666816dafadd20ceb71eac9a7d56d7ef30279f7d64048519ab901ada336 AS uv

FROM python:3.13-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f AS build
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /src
COPY pyproject.toml uv.lock ./
COPY services/gateway services/gateway
RUN uv export --frozen --no-dev --no-emit-workspace --package gateway -o /tmp/requirements.txt \
 && uv pip install --no-cache --target /app -r /tmp/requirements.txt \
 && cp -r services/gateway/src/gateway /app/gateway

# Distroless: no shell, no package manager, runs as uid 65532.
FROM gcr.io/distroless/python3-debian13:nonroot@sha256:f47f5807043391605425f2bd162b25f50cebdc90640bacc804e0177608fe5c65
COPY --from=build /app /app
ARG TL_VERSION TL_SHA
ENV PYTHONPATH=/app PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TL_VERSION=${TL_VERSION} TL_SHA=${TL_SHA}
LABEL org.opencontainers.image.version=${TL_VERSION} org.opencontainers.image.revision=${TL_SHA}
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["python3", "-m", "uvicorn", "gateway.app:app", "--host", "0.0.0.0", "--port", "8080", "--no-server-header"]
