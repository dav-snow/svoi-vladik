"""Photos wired from the licensed content manifest into place data and the API."""
from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi.testclient import TestClient

import main

ROOT = Path(__file__).resolve().parents[2]
PLACES_FILE = ROOT / "data" / "places.json"
MANIFEST_FILE = ROOT / "assets" / "places" / "manifest.json"


def _load() -> tuple[list[dict], dict[str, dict]]:
    places = json.loads(PLACES_FILE.read_text(encoding="utf-8"))["items"]
    manifest = {
        item["id"]: item
        for item in json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))["items"]
    }
    return places, manifest


def _served(place: dict) -> bool:
    return bool(place.get("active")) and bool(place.get("district_verified")) and place.get("status") in {"draft", "verified"}


def _declared_files(item: dict) -> list[dict]:
    return [photo for photo in item.get("photos") or [] if (ROOT / photo["path"]).is_file()]


def test_every_served_place_has_photos_with_alt_text() -> None:
    places, manifest = _load()
    served = [place for place in places if _served(place)]
    assert served
    for place in served:
        images = place.get("images") or []
        assert images, f"{place['id']}: нет подключённых фото"
        assert len(images) == len(_declared_files(manifest[place["id"]]))
        for image in images:
            assert image["alt"].strip(), place["id"]
            # The UI is Russian; Commons descriptions can be English.
            assert re.search(r"[А-Яа-яЁё]", image["alt"]), place["id"]
            assert image["caption"].startswith("Фото:"), place["id"]
            assert image["source_url"].startswith("https://"), place["id"]


def test_images_point_to_existing_licensed_files() -> None:
    places, _ = _load()
    for place in places:
        for image in place.get("images") or []:
            url = image["url"]
            assert url.startswith("/assets/places/"), url
            assert (ROOT / url.lstrip("/")).is_file(), url


def test_images_keep_manifest_order_and_attribution() -> None:
    places, manifest = _load()
    linked = [place for place in places if place.get("images")]
    assert linked
    for place in linked:
        photos = _declared_files(manifest[place["id"]])
        assert [image["url"] for image in place["images"]] == ["/" + photo["path"] for photo in photos]
        for image, photo in zip(place["images"], photos):
            assert " ".join(photo["author"].split()) in image["caption"]
            assert photo["license"] in image["caption"]
            if photo.get("license_url"):
                assert photo["license_url"] in image["caption"]


def test_api_returns_wired_images_with_sources() -> None:
    items = TestClient(main.app).get("/api/v1/places").json()["items"]
    with_images = [item for item in items if item.get("images")]
    assert with_images
    image = with_images[0]["images"][0]
    assert set(image) >= {"url", "alt", "caption", "source_url"}
    assert image["url"].startswith("/assets/places/")
