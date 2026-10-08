from collections.abc import AsyncIterator

import httpx
import pytest

from gateway.app import app

# Driven through httpx's ASGI transport: no server, no Starlette TestClient.
pytestmark = pytest.mark.anyio


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gateway") as c:
        yield c


async def test_healthz(client: httpx.AsyncClient) -> None:
    assert (await client.get("/healthz")).json() == {"status": "ok"}


async def test_version_outside_a_release_is_null(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("TL_VERSION", raising=False)
    monkeypatch.delenv("TL_SHA", raising=False)
    assert (await client.get("/version")).json() == {"version": None, "sha": None}


async def test_version_treats_empty_build_args_as_null(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TL_VERSION", "")
    monkeypatch.setenv("TL_SHA", "")
    assert (await client.get("/version")).json() == {"version": None, "sha": None}


async def test_version_reports_the_baked_build(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TL_VERSION", "v1.2.3")
    monkeypatch.setenv("TL_SHA", "abc123")
    assert (await client.get("/version")).json() == {"version": "v1.2.3", "sha": "abc123"}


async def test_items_stub_is_empty(client: httpx.AsyncClient) -> None:
    response = await client.get("/items")
    assert response.status_code == 200
    assert response.json() == []


async def test_no_interactive_docs(client: httpx.AsyncClient) -> None:
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert (await client.get(path)).status_code == 404
