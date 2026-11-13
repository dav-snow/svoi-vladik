"""Place photo gallery: model validation, API field and /media static mount."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import main


def _client() -> TestClient:
    return TestClient(main.app)


def _place(**overrides):
    base = dict(
        id="p1",
        name="Тестовое место",
        category="culture",
        coordinates={"lat": 43.1, "lng": 131.9},
    )
    base.update(overrides)
    return main.Place(**base)


def test_place_accepts_relative_and_https_images() -> None:
    place = _place(images=[
        {"url": "/media/places/p1/1.jpg", "alt": "Фасад"},
        {"url": "/assets/mascot/talking.webp"},
        {"url": "https://example.com/a.jpg", "source_url": "https://example.com/src"},
    ])
    dumped = place.model_dump()
    assert [i["url"] for i in dumped["images"]] == [
        "/media/places/p1/1.jpg",
        "/assets/mascot/talking.webp",
        "https://example.com/a.jpg",
    ]
    assert dumped["images"][0]["alt"] == "Фасад"


def test_place_images_default_to_empty_list() -> None:
    assert _place().model_dump()["images"] == []


@pytest.mark.parametrize("bad_url", [
    "javascript:alert(1)",
    "//evil.example/a.jpg",
    "/media/../etc/passwd",
    "/media/%2e%2e/x.jpg",
    "ftp://example.com/a.jpg",
    "http://example.com/a.jpg",
    "/other/a.jpg",
    "media/places/p1/1.jpg",
])
def test_place_rejects_unsafe_image_urls(bad_url: str) -> None:
    with pytest.raises(ValidationError):
        _place(images=[{"url": bad_url}])


def test_place_rejects_non_https_image_source() -> None:
    with pytest.raises(ValidationError):
        _place(images=[{"url": "/media/places/p1/1.jpg", "source_url": "http://example.com"}])


def test_places_endpoint_includes_images_list() -> None:
    items = _client().get("/api/v1/places").json()["items"]
    assert items
    for place in items:
        assert "images" in place
        assert isinstance(place["images"], list)


def test_media_mount_serves_files() -> None:
    response = _client().get("/media/README.md")
    assert response.status_code == 200


def test_place_photo_pack_is_served() -> None:
    # The content team's licensed pack lives at repo-root assets/places and is
    # mounted at /assets/places, ahead of the frontend root mount.
    response = _client().get("/assets/places/manifest.json")
    assert response.status_code == 200
    body = response.json()
    assert body.get("items")
