"""Visit marks: idempotent per user, honest counters, no tracking columns."""
from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

import main


def _user(login: str) -> TestClient:
    client = TestClient(main.app)
    response = client.post("/api/v1/auth/register", json={"login": login, "password": "demo-password"})
    assert response.status_code == 201
    return client


def _place_id() -> str:
    places = main.load_places()
    assert places, "catalogue must not be empty for these tests"
    return places[0].id


def test_visit_requires_session() -> None:
    anonymous = TestClient(main.app)
    assert anonymous.post(f"/api/v1/places/{_place_id()}/visit").status_code == 401


def test_visit_is_idempotent_per_user() -> None:
    client = _user("walker")
    place = _place_id()
    first = client.post(f"/api/v1/places/{place}/visit")
    assert first.status_code == 200
    assert first.json() == {"visited": True, "visits": 1}
    again = client.post(f"/api/v1/places/{place}/visit")
    assert again.json() == {"visited": True, "visits": 1}


def test_second_user_raises_counter_and_visited_by_me_is_personal() -> None:
    place = _place_id()
    first = _user("first-user")
    second = _user("second-user")
    first.post(f"/api/v1/places/{place}/visit")
    response = second.post(f"/api/v1/places/{place}/visit")
    assert response.json() == {"visited": True, "visits": 2}

    def marked(client: TestClient) -> dict:
        return client.get(f"/api/v1/places/{place}").json()

    assert marked(second)["visited_by_me"] is True
    assert marked(first)["visited_by_me"] is True
    anonymous = TestClient(main.app)
    card = anonymous.get(f"/api/v1/places/{place}").json()
    assert card["visits"] == 2
    assert card["visited_by_me"] is False


def test_delete_visit_decrements_and_stays_idempotent() -> None:
    client = _user("undoer")
    place = _place_id()
    client.post(f"/api/v1/places/{place}/visit")
    removed = client.delete(f"/api/v1/places/{place}/visit")
    assert removed.status_code == 200
    assert removed.json() == {"visited": False, "visits": 0}
    again = client.delete(f"/api/v1/places/{place}/visit")
    assert again.status_code == 200
    assert again.json() == {"visited": False, "visits": 0}


def test_unknown_place_is_404() -> None:
    client = _user("lost")
    assert client.post("/api/v1/places/no-such-place/visit").status_code == 404
    assert client.delete("/api/v1/places/no-such-place/visit").status_code == 404


def test_visits_table_holds_no_ip_coordinates_or_login() -> None:
    client = _user("privacy")
    client.post(f"/api/v1/places/{_place_id()}/visit")
    conn = sqlite3.connect(main.db_path())
    try:
        columns = [row[1] for row in conn.execute("PRAGMA table_info(visits)")]
        rows = conn.execute("SELECT * FROM visits").fetchall()
    finally:
        conn.close()
    assert columns == ["user_id", "place_id", "created_at"]
    assert len(rows) == 1
    flat = " ".join(str(value) for value in rows[0])
    assert "privacy" not in flat  # user_id is an opaque token, not the login
    assert "testclient" not in flat  # no client address
