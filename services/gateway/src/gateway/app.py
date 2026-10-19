"""The gateway: the only service the edge reaches.

Phase 1 serves health, build identity, runtime config, and a stub list. Public routes live under /api,
the path CloudFront sends to the ALB; /healthz is for the kubelet's probes.
"""

import os

from fastapi import APIRouter, FastAPI
from pydantic import BaseModel


class Version(BaseModel):
    """The running build. Both fields are null outside a release image."""

    version: str | None
    sha: str | None


class RuntimeConfig(BaseModel):
    """Per-stage values the web app reads at runtime, never at build time (plan rule 3)."""

    stage: str | None


class Item(BaseModel):
    id: str
    name: str


app = FastAPI(title="Tempered Lab gateway", docs_url=None, redoc_url=None, openapi_url=None)
api = APIRouter(prefix="/api")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@api.get("/version")
def version() -> Version:
    # Baked in by .github/scripts/build-image.sh; the same image runs in every stage.
    # A build without the build args bakes in empty strings; report those as "not a release" too.
    return Version(version=os.environ.get("TL_VERSION") or None, sha=os.environ.get("TL_SHA") or None)


@api.get("/config")
def config() -> RuntimeConfig:
    # Set by the chart for the stage the pod runs in.
    return RuntimeConfig(stage=os.environ.get("TL_STAGE"))


@api.get("/items")
def list_items() -> list[Item]:
    return []  # Phase 2 reads these from the responder.


app.include_router(api)
