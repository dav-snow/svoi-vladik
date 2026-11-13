"""Make `backend/` importable so tests can `from main import app`.

Needed because the suite is normally invoked from the repository root with
`pytest backend/tests`, but `main` lives in `backend/`, not on sys.path.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture(autouse=True)
def _isolated_social_state(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Every test gets a throwaway SQLite file and clean rate limiters.

    The real data/demo.sqlite3 must never be touched by the suite, and limiter
    state must not leak 429s between unrelated tests.
    """
    import main

    monkeypatch.setenv("DB_PATH", str(tmp_path / "demo-test.sqlite3"))
    main.POST_LIMITER.events.clear()
    main.AUTH_IP_LIMITER.events.clear()
    main.AUTH_LOGIN_LIMITER.events.clear()
    yield
