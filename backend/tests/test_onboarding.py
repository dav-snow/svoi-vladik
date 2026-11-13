"""Guided onboarding progress: per-user state, validation and cascade."""
from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

import main


def _client() -> TestClient:
    return TestClient(main.app)


def _register(client: TestClient, login: str = "newbie", password: str = "correct-horse") -> None:
    response = client.post("/api/v1/auth/register", json={"login": login, "password": password})
    assert response.status_code == 201, response.text


def test_onboarding_requires_login() -> None:
    client = _client()
    assert client.get("/api/v1/me/onboarding").status_code == 401
    assert client.put("/api/v1/me/onboarding", json={}).status_code == 401


def test_new_user_starts_pending_and_me_exposes_it() -> None:
    client = _client()
    _register(client)
    state = client.get("/api/v1/me/onboarding")
    assert state.status_code == 200
    body = state.json()
    assert body["status"] == "pending"
    assert body["step"] is None and body["interest"] is None
    assert body["started_at"] is None and body["completed_at"] is None
    me = client.get("/api/v1/me")
    assert me.status_code == 200
    assert me.json()["onboarding"]["status"] == "pending"


def test_progress_update_persists() -> None:
    client = _client()
    _register(client)
    started = client.put(
        "/api/v1/me/onboarding",
        json={"status": "in_progress", "interest": "walks", "step": "first_action"},
    )
    assert started.status_code == 200
    body = started.json()
    assert body["status"] == "in_progress"
    assert body["interest"] == "walks"
    assert body["step"] == "first_action"
    assert body["started_at"] is not None
    assert body["completed_at"] is None
    # A second partial update keeps earlier fields.
    advanced = client.put("/api/v1/me/onboarding", json={"step": "others"})
    assert advanced.status_code == 200
    assert advanced.json()["step"] == "others"
    assert advanced.json()["interest"] == "walks"
    assert advanced.json()["status"] == "in_progress"
    # Reading back returns the same state.
    assert client.get("/api/v1/me/onboarding").json()["step"] == "others"


def test_completion_sets_completed_at() -> None:
    client = _client()
    _register(client)
    client.put("/api/v1/me/onboarding", json={"status": "in_progress", "interest": "quest"})
    done = client.put("/api/v1/me/onboarding", json={"status": "completed"})
    assert done.status_code == 200
    assert done.json()["status"] == "completed"
    assert done.json()["completed_at"] is not None
    # Reopening back to in_progress clears completed_at.
    reopened = client.put("/api/v1/me/onboarding", json={"status": "in_progress"})
    assert reopened.json()["completed_at"] is None


def test_skipped_is_allowed() -> None:
    client = _client()
    _register(client)
    skipped = client.put("/api/v1/me/onboarding", json={"status": "skipped"})
    assert skipped.status_code == 200
    assert skipped.json()["status"] == "skipped"


def test_update_validation_rejects_bad_values() -> None:
    client = _client()
    _register(client)
    assert client.put("/api/v1/me/onboarding", json={"status": "nope"}).status_code == 422
    assert client.put("/api/v1/me/onboarding", json={"interest": "food"}).status_code == 422
    assert client.put("/api/v1/me/onboarding", json={"step": "Bad Step!"}).status_code == 422
    assert client.put("/api/v1/me/onboarding", json={"extra": 1}).status_code == 422


def test_onboarding_row_cascades_with_user() -> None:
    client = _client()
    _register(client)
    client.put("/api/v1/me/onboarding", json={"status": "in_progress"})
    conn = sqlite3.connect(main.db_path())
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        user_id = conn.execute("SELECT id FROM users").fetchone()[0]
        assert conn.execute(
            "SELECT COUNT(*) FROM onboarding WHERE user_id = ?", (user_id,)
        ).fetchone()[0] == 1
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
        assert conn.execute(
            "SELECT COUNT(*) FROM onboarding WHERE user_id = ?", (user_id,)
        ).fetchone()[0] == 0
    finally:
        conn.close()
