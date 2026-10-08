"""The gateway: the only service the edge reaches. Phase 1 serves health, build identity, and a stub list."""

import os

from fastapi import FastAPI
from pydantic import BaseModel


class Version(BaseModel):
    """The running build. Both fields are null outside a release image."""

    version: str | None
    sha: str | None


class Item(BaseModel):
    id: str
    name: str


app = FastAPI(title="Tempered Lab gateway", docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/version")
def version() -> Version:
    # Baked in by .github/scripts/build-image.sh; the same image runs in every stage.
    # A build without the build args bakes in empty strings; report those as "not a release" too.
    return Version(version=os.environ.get("TL_VERSION") or None, sha=os.environ.get("TL_SHA") or None)


@app.get("/items")
def list_items() -> list[Item]:
    return []  # Phase 2 reads these from the responder.
