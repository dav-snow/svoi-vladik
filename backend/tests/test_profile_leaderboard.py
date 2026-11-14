"""Profile shows own marks; leaderboard ranks by visits only and leaks nothing."""
from __future__ import annotations

from fastapi.testclient import TestClient

import main


def _user(login: str) -> TestClient:
    client = TestClient(main.app)
    response = client.post("/api/v1/auth/register", json={"login": login, "password": "demo-password"})
    assert response.status_code == 201
    return client


def _place_ids(count: int) -> list[str]:
    places = main.load_places()
    assert len(places) >= count, f"catalogue needs at least {count} places for this test"
    return [place.id for place in places[:count]]


def test_profile_matches_marks() -> None:
    client = _user("profiled")
    visited = _place_ids(3)[:2]
    liked = _place_ids(3)[2:3]
    for place in visited:
        client.post(f"/api/v1/places/{place}/visit")
    for place in liked:
        client.post(f"/api/v1/places/{place}/like")
    profile = client.get("/api/v1/me/profile")
    assert profile.status_code == 200
    body = profile.json()
    assert body["user"]["login"] == "profiled"
    assert body["stats"] == {"visits": 2, "likes": 1}
    assert sorted(body["visited_place_ids"]) == sorted(visited)
    assert body["liked_place_ids"] == liked


def test_profile_requires_session() -> None:
    assert TestClient(main.app).get("/api/v1/me/profile").status_code == 401


def test_leaderboard_ranks_by_visits_not_likes() -> None:
    places = _place_ids(3)
    busy = _user("busy")
    for place in places:
        busy.post(f"/api/v1/places/{place}/visit")
    lazy = _user("lazy")
    lazy.post(f"/api/v1/places/{places[0]}/visit")
    for place in places:
        lazy.post(f"/api/v1/places/{place}/like")  # likes must not move the rank
    response = TestClient(main.app).get("/api/v1/leaderboard")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert body["items"][0] == {"login": "busy", "visits": 3, "likes": 0}
    assert body["items"][1] == {"login": "lazy", "visits": 1, "likes": 3}


def test_leaderboard_equal_visits_sorted_by_login() -> None:
    place = _place_ids(1)[0]
    for login in ("zeta", "alpha"):
        _user(login).post(f"/api/v1/places/{place}/visit")
    items = TestClient(main.app).get("/api/v1/leaderboard").json()["items"]
    assert [item["login"] for item in items] == ["alpha", "zeta"]


def test_registered_user_without_visits_is_listed_with_zero() -> None:
    place = _place_ids(1)[0]
    only_likes = _user("onlylikes")
    only_likes.post(f"/api/v1/places/{place}/like")
    _user("walker").post(f"/api/v1/places/{place}/visit")
    items = TestClient(main.app).get("/api/v1/leaderboard").json()["items"]
    assert [item["login"] for item in items] == ["walker", "onlylikes"]
    assert items[0]["visits"] == 1
    assert items[1] == {"login": "onlylikes", "visits": 0, "likes": 1}


def test_leaderboard_limit_validation() -> None:
    place = _place_ids(1)[0]
    for login in ("one", "two"):
        _user(login).post(f"/api/v1/places/{place}/visit")
    client = TestClient(main.app)
    limited = client.get("/api/v1/leaderboard?limit=1").json()
    assert len(limited["items"]) == 1
    assert limited["total"] == 2
    assert client.get("/api/v1/leaderboard?limit=0").status_code == 422
    assert client.get("/api/v1/leaderboard?limit=21").status_code == 422
    assert client.get("/api/v1/leaderboard?limit=abc").status_code == 422
    assert client.get("/api/v1/leaderboard?limit=1&limit=2").status_code == 422
    assert client.get("/api/v1/leaderboard?extra=1").status_code == 422


def test_leaderboard_exposes_only_login_visits_likes() -> None:
    place = _place_ids(1)[0]
    _user("minimal").post(f"/api/v1/places/{place}/visit")
    items = TestClient(main.app).get("/api/v1/leaderboard").json()["items"]
    assert items
    for item in items:
        assert set(item.keys()) == {"login", "visits", "likes"}


def test_broken_db_keeps_places_up_with_zero_counters(monkeypatch) -> None:
    monkeypatch.setenv("DB_PATH", str(main.REPO_ROOT / "backend"))  # unopenable as a database
    client = TestClient(main.app)
    places = client.get("/api/v1/places")
    assert places.status_code == 200
    card = places.json()["items"][0]
    assert card["visits"] == 0 and card["likes"] == 0
    assert card["visited_by_me"] is False and card["liked_by_me"] is False
    board = client.get("/api/v1/leaderboard")
    assert board.status_code == 200
    assert board.json() == {"items": [], "total": 0}
    assert client.post(f"/api/v1/places/{card['id']}/visit").status_code in {401, 503}
    # Writes against a broken database must be 503 for a logged-in shape too:
    assert client.post("/api/v1/auth/register", json={"login": "nobody1", "password": "demo-password"}).status_code == 503
