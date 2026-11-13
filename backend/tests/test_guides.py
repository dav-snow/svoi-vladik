"""Practical guide endpoint: eat/toilet/fun cards without map coordinates."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main
from main import app


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


def _items(client: TestClient, query: str = "") -> list[dict]:
    resp = client.get("/api/v1/guides" + query)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == len(body["items"])
    return body["items"]


def test_guides_list_shape(client: TestClient) -> None:
    items = _items(client)
    assert items, "Expected data/guides.json to have cards"
    for item in items:
        assert item["need"] in {"eat", "toilet", "fun", "lodging"}
        assert item["address"].strip()
        assert item["source_url"] and item["source_url"].startswith("https://")
        assert item["status"] == "draft"
        # Cards deliberately have no coordinates until the entrance is verified.
        assert "coordinates" not in item


def test_guides_filter_by_need(client: TestClient) -> None:
    for need in ("eat", "toilet", "fun"):
        items = _items(client, f"?need={need}")
        assert items, f"expected cards for need={need}"
        assert all(item["need"] == need for item in items)


def test_guides_toilet_and_eat_are_present(client: TestClient) -> None:
    assert len(_items(client, "?need=toilet")) >= 3
    assert len(_items(client, "?need=eat")) >= 5


def test_guides_unknown_need_is_validation_error(client: TestClient) -> None:
    resp = client.get("/api/v1/guides?need=shopping")
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_guides_extra_parameter_is_validation_error(client: TestClient) -> None:
    resp = client.get("/api/v1/guides?need=eat&radius=500")
    assert resp.status_code == 422


def test_guides_empty_result_is_200(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "load_guides", lambda: [])
    resp = client.get("/api/v1/guides?need=toilet")
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "total": 0}
