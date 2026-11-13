"""End-to-end smoke tests for the /api/v1 contract and the one-origin setup.

Tests use httpx TestClient against the FastAPI app directly, so they do not
require network access, the Docker build or a running uvicorn.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from main import PLACES, app


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


def _assert_error_shape(payload: dict, expected_code: str) -> None:
    assert "error" in payload, payload
    err = payload["error"]
    assert set(err.keys()) == {"code", "message"}, err
    assert err["code"] == expected_code, err
    assert isinstance(err["message"], str) and err["message"].strip()


def test_health(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_root_serves_new_frontend(client: TestClient) -> None:
    resp = client.get("/")
    assert resp.status_code == 200
    body = resp.text
    # Stable markers from frontend-design/dist/index.html.
    assert "<title>Свой Владик — Ленинский район</title>" in body
    assert "maplibre-gl" in body


def test_places_list_shape(client: TestClient) -> None:
    resp = client.get("/api/v1/places")
    assert resp.status_code == 200
    data = resp.json()
    assert set(data.keys()) >= {"items", "total"}
    assert isinstance(data["items"], list)
    assert data["total"] == len(data["items"])


def test_place_by_existing_id(client: TestClient) -> None:
    # Guard: the suite assumes real POI data is present.
    assert PLACES, "Expected at least one place in data/geo/*.geojson for tests"
    place_id = PLACES[0].id
    resp = client.get(f"/api/v1/places/{place_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == place_id


def test_place_unknown_id_is_not_found(client: TestClient) -> None:
    resp = client.get("/api/v1/places/osm-node-000000")
    assert resp.status_code == 404
    _assert_error_shape(resp.json(), "NOT_FOUND")


def test_place_malformed_id_is_validation_error(client: TestClient) -> None:
    # Contains characters outside [A-Za-z0-9_-].
    resp = client.get("/api/v1/places/not%20valid!")
    assert resp.status_code == 422
    _assert_error_shape(resp.json(), "VALIDATION_ERROR")


def test_unknown_api_v1_path_is_not_found(client: TestClient) -> None:
    resp = client.get("/api/v1/nope")
    assert resp.status_code == 404
    _assert_error_shape(resp.json(), "NOT_FOUND")


def test_wrong_method_is_method_not_allowed(client: TestClient) -> None:
    resp = client.post("/api/v1/places")
    assert resp.status_code == 405
    _assert_error_shape(resp.json(), "METHOD_NOT_ALLOWED")


def test_legacy_api_prefix_is_gone(client: TestClient) -> None:
    resp = client.get("/api/places")
    assert resp.status_code == 404
    _assert_error_shape(resp.json(), "NOT_FOUND")


def test_walks_endpoint_shape(client: TestClient) -> None:
    resp = client.get("/api/v1/walks")
    assert resp.status_code == 200
    data = resp.json()
    assert set(data.keys()) >= {"items", "total"}
    assert isinstance(data["items"], list)
    assert data["total"] == len(data["items"])


def test_quest_endpoint_shape(client: TestClient) -> None:
    resp = client.get("/api/v1/quest")
    assert resp.status_code == 200
    data = resp.json()
    assert set(data.keys()) >= {"items", "total"}


def test_data_mount_serves_geojson(client: TestClient) -> None:
    resp = client.get("/data/geo/leninsky-boundary.geojson")
    assert resp.status_code == 200
    # FastAPI/Starlette serves .geojson as application/octet-stream by default,
    # so check content rather than Content-Type.
    assert resp.content.lstrip().startswith(b"{")


def test_openapi_has_no_legacy_api_paths(client: TestClient) -> None:
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    paths = resp.json().get("paths", {})
    for path in paths:
        if path.startswith("/api/"):
            assert path.startswith("/api/v1/"), (
                f"Unexpected non-v1 API path in OpenAPI: {path}"
            )
