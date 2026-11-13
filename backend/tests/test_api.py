"""End-to-end smoke tests for the /api/v1 contract and the one-origin setup.

Tests use httpx TestClient against the FastAPI app directly, so they do not
require network access, the Docker build or a running uvicorn.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import main
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


def test_place_route_url_is_ready_2gis_link(client: TestClient) -> None:
    # Each place carries a ready-to-use 2GIS pedestrian route URL built from its
    # coordinates, with a literal '|' separator (not %7C). The frontend uses it
    # as-is, so the destination must be prefilled.
    resp = client.get("/api/v1/places")
    items = resp.json()["items"]
    assert items
    for place in items:
        url = place["route_url"]
        coords = place["coordinates"]
        assert url is not None
        assert "%7C" not in url
        assert "points/|" in url
        expected = (
            "https://2gis.ru/directions/tab/pedestrian/points/"
            f"|{coords['lng']},{coords['lat']}"
        )
        assert url == expected


def test_place_card_has_route_url(client: TestClient) -> None:
    place_id = PLACES[0].id
    resp = client.get(f"/api/v1/places/{place_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert "route_url" in body
    assert "points/|" in body["route_url"]


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


@pytest.mark.parametrize("name", [
    "leninsky-boundary.geojson",
    "leninsky-poi-candidates.geojson",
])
def test_data_geojson_served_from_data_geo(client: TestClient, name: str) -> None:
    # The two Leninsky GeoJSON files are served from data/geo/ (single source of
    # truth), not from the frontend data folder. The test fails if these routes
    # disappear or point elsewhere.
    resp = client.get(f"/data/{name}")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/geo+json")
    body = json.loads(resp.content)
    assert body.get("type") == "FeatureCollection", body.get("type")
    # Content matches data/geo/... (compare by feature count).
    source = main.REPO_ROOT / "data" / "geo" / name
    expected = json.loads(source.read_text(encoding="utf-8"))
    assert len(body["features"]) == len(expected["features"])


def test_openapi_exposes_exact_path_set(client: TestClient) -> None:
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    paths = set(resp.json().get("paths", {}))
    assert paths == {
        "/health",
        "/api/v1/places",
        "/api/v1/places/{place_id}",
        "/api/v1/guides",
        "/api/v1/walks",
        "/api/v1/quest",
        "/api/v1/quest/{quest_id}/answer",
        "/api/v1/quest/{quest_id}/complete",
        "/api/v1/map-data/{filename}",
        "/api/v1/auth/register",
        "/api/v1/auth/login",
        "/api/v1/auth/logout",
        "/api/v1/me",
        "/api/v1/me/profile",
        "/api/v1/me/onboarding",
        "/api/v1/places/{place_id}/visit",
        "/api/v1/places/{place_id}/like",
        "/api/v1/leaderboard",
        "/api/v1/test-empty",
        "/api/v1/test-error",
        "/data/leninsky-boundary.geojson",
        "/data/leninsky-poi-candidates.geojson",
    }, paths


def test_internal_error_is_sanitised(monkeypatch: pytest.MonkeyPatch) -> None:
    # Force an unexpected exception inside the /api/v1/walks handler. With
    # raise_server_exceptions=False the TestClient returns the app's 500
    # response instead of re-raising, so we can assert the sanitised body.
    secret = "leaky-internal-detail-xyz"

    def boom(*args, **kwargs):
        raise RuntimeError(secret)

    monkeypatch.setattr(main, "load_collection", boom)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/walks")
    assert resp.status_code == 500
    _assert_error_shape(resp.json(), "INTERNAL_ERROR")
    assert secret not in resp.text
    assert "Traceback" not in resp.text
    assert "RuntimeError" not in resp.text
