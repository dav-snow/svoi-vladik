"""Likes are independent of visits and idempotent per user."""
from __future__ import annotations

from fastapi.testclient import TestClient

import main


def _user(login: str) -> TestClient:
    client = TestClient(main.app)
    response = client.post("/api/v1/auth/register", json={"login": login, "password": "demo-password"})
    assert response.status_code == 201
    return client


def _place_id() -> str:
    return main.load_places()[0].id


def test_like_requires_session() -> None:
    assert TestClient(main.app).post(f"/api/v1/places/{_place_id()}/like").status_code == 401


def test_like_without_visit_is_allowed() -> None:
    client = _user("liker")
    place = _place_id()
    response = client.post(f"/api/v1/places/{place}/like")
    assert response.status_code == 200
    assert response.json() == {"liked": True, "likes": 1}
    card = client.get(f"/api/v1/places/{place}").json()
    assert card["liked_by_me"] is True
    assert card["visited_by_me"] is False
    assert card["visits"] == 0


def test_like_is_idempotent() -> None:
    client = _user("doublelike")
    place = _place_id()
    client.post(f"/api/v1/places/{place}/like")
    again = client.post(f"/api/v1/places/{place}/like")
    assert again.json() == {"liked": True, "likes": 1}


def test_delete_like_and_repeat_delete() -> None:
    client = _user("unliker")
    place = _place_id()
    client.post(f"/api/v1/places/{place}/like")
    removed = client.delete(f"/api/v1/places/{place}/like")
    assert removed.status_code == 200
    assert removed.json() == {"liked": False, "likes": 0}
    again = client.delete(f"/api/v1/places/{place}/like")
    assert again.status_code == 200
    assert again.json() == {"liked": False, "likes": 0}


def test_visits_and_likes_are_independent_counters() -> None:
    client = _user("both")
    place = _place_id()
    client.post(f"/api/v1/places/{place}/visit")
    client.post(f"/api/v1/places/{place}/like")
    card = client.get(f"/api/v1/places/{place}").json()
    assert card["visits"] == 1
    assert card["likes"] == 1
    client.delete(f"/api/v1/places/{place}/like")
    card = client.get(f"/api/v1/places/{place}").json()
    assert card["visits"] == 1  # removing a like never touches visits
    assert card["likes"] == 0
    client.delete(f"/api/v1/places/{place}/visit")
    card = client.get(f"/api/v1/places/{place}").json()
    assert card["visits"] == 0
