"""Keep docs/API.md in sync with the implemented OpenAPI paths.

The contract doc is what the frontend reads. If a route is added, renamed or
removed without updating docs/API.md, this test fails instead of letting the
documentation drift.
"""
from __future__ import annotations

import re

from fastapi.testclient import TestClient

import main

ANY_PATH_RE = re.compile(r"/(?:api/v1|data|health)[A-Za-z0-9_{}./-]*")
GEOJSON_RE = re.compile(r"/data/leninsky-[a-z-]+\.geojson")


def _is_api_path(token: str) -> bool:
    """Only real API routes count; prose mentions like /data/private do not."""
    return (
        token == "/health"
        or token.startswith("/api/v1/")
        or bool(GEOJSON_RE.fullmatch(token))
    )


def _documented_paths() -> set[str]:
    text = (main.REPO_ROOT / "docs" / "API.md").read_text(encoding="utf-8")
    found: set[str] = set()
    for raw in ANY_PATH_RE.findall(text):
        token = raw.rstrip(".,;:")
        if "..." in token or not _is_api_path(token):
            continue
        found.add(token)
    return found


def _openapi_paths() -> set[str]:
    client = TestClient(main.app)
    return set(client.get("/openapi.json").json()["paths"])


def test_every_openapi_path_is_documented() -> None:
    missing = _openapi_paths() - _documented_paths()
    assert not missing, f"Не описаны в docs/API.md: {sorted(missing)}"


def test_documented_paths_exist_in_api() -> None:
    stale = _documented_paths() - _openapi_paths()
    assert not stale, f"Описаны, но отсутствуют в API: {sorted(stale)}"
