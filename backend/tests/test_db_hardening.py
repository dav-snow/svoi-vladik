"""Schema-hardening checks: version, indices, FKs (cascade) and session GC."""
from __future__ import annotations

import main


def test_schema_version_indices_and_foreign_keys() -> None:
    conn = main.open_db()
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == main._SCHEMA_VERSION
        indices = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")
        }
        for name in (
            "idx_sessions_user",
            "idx_sessions_expires",
            "idx_visits_place",
            "idx_likes_place",
        ):
            assert name in indices, name
        sessions_sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'"
        ).fetchone()[0]
        assert "REFERENCES users(id) ON DELETE CASCADE" in sessions_sql
    finally:
        conn.close()


def test_expired_sessions_are_cleaned_on_login() -> None:
    conn = main.open_db()
    try:
        conn.execute(
            "INSERT INTO users(id, login, password_hash, created_at) VALUES (?, ?, ?, ?)",
            ("u1", "login1", "scrypt$dummy", "2020-01-01T00:00:00+00:00"),
        )
        conn.execute(
            "INSERT INTO sessions(token_hash, user_id, created_at, expires_at) "
            "VALUES (?, ?, ?, ?)",
            ("oldhash", "u1", "2020-01-01T00:00:00+00:00", "2020-01-02T00:00:00+00:00"),
        )
        conn.commit()
        main.create_session(conn, "u1")
        remaining = conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE expires_at < ?",
            (main._iso(main._utc_now()),),
        ).fetchone()[0]
        assert remaining == 0
    finally:
        conn.close()


def test_deleting_user_cascades_related_rows() -> None:
    conn = main.open_db()
    try:
        conn.execute(
            "INSERT INTO users(id, login, password_hash, created_at) VALUES (?, ?, ?, ?)",
            ("u2", "login2", "scrypt$dummy", "2020-01-01T00:00:00+00:00"),
        )
        conn.execute(
            "INSERT INTO visits(user_id, place_id, created_at) VALUES (?, ?, ?)",
            ("u2", "place", "2020-01-01T00:00:00+00:00"),
        )
        conn.execute(
            "INSERT INTO likes(user_id, place_id, created_at) VALUES (?, ?, ?)",
            ("u2", "place", "2020-01-01T00:00:00+00:00"),
        )
        conn.execute(
            "INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            ("th", "u2", "2020-01-01T00:00:00+00:00", "2099-01-01T00:00:00+00:00"),
        )
        conn.commit()
        conn.execute("DELETE FROM users WHERE id = 'u2'")
        conn.commit()
        for table in ("visits", "likes", "sessions"):
            assert (
                conn.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE user_id = 'u2'"
                ).fetchone()[0]
                == 0
            ), table
    finally:
        conn.close()
