"""Demo auth: scrypt hashes, HttpOnly session cookie, honest 401 and 429."""
from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

import main


def _client() -> TestClient:
    return TestClient(main.app)


def _register(client: TestClient, login: str = "kostya", password: str = "correct-horse") -> object:
    return client.post("/api/v1/auth/register", json={"login": login, "password": password})


def _db_rows(query: str) -> list[tuple]:
    conn = sqlite3.connect(main.db_path())
    try:
        return conn.execute(query).fetchall()
    finally:
        conn.close()


def test_register_sets_httponly_lax_cookie_and_me_works() -> None:
    client = _client()
    response = _register(client)
    assert response.status_code == 201
    assert response.json()["user"]["login"] == "kostya"
    assert "id" in response.json()["user"]
    cookie_header = response.headers["set-cookie"]
    assert "sv_session=" in cookie_header
    assert "httponly" in cookie_header.lower()
    assert "samesite=lax" in cookie_header.lower()
    assert "path=/" in cookie_header.lower()
    me = client.get("/api/v1/me")
    assert me.status_code == 200
    assert me.json()["user"]["login"] == "kostya"


def test_register_duplicate_login_conflicts() -> None:
    client = _client()
    assert _register(client).status_code == 201
    second = _register(TestClient(main.app))
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "CONFLICT"


def test_login_right_and_wrong_password() -> None:
    client = _client()
    _register(client)
    fresh = _client()
    ok = fresh.post("/api/v1/auth/login", json={"login": "kostya", "password": "correct-horse"})
    assert ok.status_code == 200
    assert ok.json()["user"]["login"] == "kostya"
    bad = _client().post("/api/v1/auth/login", json={"login": "kostya", "password": "wrong-horse-1"})
    assert bad.status_code == 401


def test_login_failure_does_not_reveal_which_part_is_wrong() -> None:
    client = _client()
    _register(client)
    wrong_password = _client().post("/api/v1/auth/login", json={"login": "kostya", "password": "wrong-horse-1"})
    missing_login = _client().post("/api/v1/auth/login", json={"login": "nobody-here", "password": "wrong-horse-1"})
    assert wrong_password.status_code == missing_login.status_code == 401
    assert wrong_password.json() == missing_login.json()


def test_password_stored_only_as_scrypt_hash() -> None:
    _register(_client(), password="super-secret-pass")
    rows = _db_rows("SELECT password_hash FROM users")
    assert len(rows) == 1
    stored = rows[0][0]
    assert stored.startswith("scrypt$")
    assert "super-secret-pass" not in stored


def test_session_table_stores_hash_not_raw_token() -> None:
    client = _client()
    _register(client)
    raw_token = client.cookies.get("sv_session")
    assert raw_token
    rows = _db_rows("SELECT token_hash FROM sessions")
    assert len(rows) == 1
    assert rows[0][0] != raw_token
    assert raw_token not in rows[0][0]


def test_logout_clears_session() -> None:
    client = _client()
    _register(client)
    out = client.post("/api/v1/auth/logout")
    assert out.status_code == 204
    assert client.get("/api/v1/me").status_code == 401
    assert _db_rows("SELECT token_hash FROM sessions") == []


def test_me_without_session_is_401() -> None:
    assert _client().get("/api/v1/me").status_code == 401


def test_eleven_failed_logins_hit_rate_limit() -> None:
    client = _client()
    statuses = []
    for _ in range(11):
        response = client.post("/api/v1/auth/login", json={"login": "bruteforce", "password": "wrong-horse-1"})
        statuses.append(response.status_code)
    assert statuses[:10] == [401] * 10
    assert statuses[10] == 429
    assert response.headers.get("retry-after") == "60"


def test_register_validates_login_and_password_shape() -> None:
    client = _client()
    assert client.post("/api/v1/auth/register", json={"login": "ab", "password": "long-enough"}).status_code == 422
    assert client.post("/api/v1/auth/register", json={"login": "has space", "password": "long-enough"}).status_code == 422
    assert client.post("/api/v1/auth/register", json={"login": "goodlogin", "password": "short"}).status_code == 422
    assert client.post("/api/v1/auth/register", json={"login": "goodlogin", "password": "x" * 129}).status_code == 422
    assert client.post("/api/v1/auth/register", json={"login": "goodlogin", "password": "long-enough", "extra": 1}).status_code == 422


def test_broken_db_path_returns_503_and_server_survives(monkeypatch) -> None:
    monkeypatch.setenv("DB_PATH", str(main.REPO_ROOT / "backend"))  # a directory is not a database
    client = _client()
    assert _register(client).status_code == 503
    assert client.get("/health").status_code == 200
