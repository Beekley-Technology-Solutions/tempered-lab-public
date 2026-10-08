import pytest
from fastapi.testclient import TestClient
from gateway.app import app

client = TestClient(app)


def test_healthz() -> None:
    assert client.get("/healthz").json() == {"status": "ok"}


def test_version_outside_a_release_is_null(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TL_VERSION", raising=False)
    monkeypatch.delenv("TL_SHA", raising=False)
    assert client.get("/api/version").json() == {"version": None, "sha": None}


def test_version_reports_the_baked_build(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TL_VERSION", "v1.2.3")
    monkeypatch.setenv("TL_SHA", "abc123")
    assert client.get("/api/version").json() == {"version": "v1.2.3", "sha": "abc123"}


def test_config_reports_the_runtime_stage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TL_STAGE", "staging")
    assert client.get("/api/config").json() == {"stage": "staging"}


def test_items_stub_is_empty() -> None:
    response = client.get("/api/items")
    assert response.status_code == 200
    assert response.json() == []


def test_only_api_routes_and_health_are_served() -> None:
    for path in ("/docs", "/redoc", "/openapi.json", "/version", "/items", "/config"):
        assert client.get(path).status_code == 404
