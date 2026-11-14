#!/usr/bin/env python3
"""Link licensed place photos from the content manifest into data/places.json.

`assets/places/manifest.json` is the source of truth for files, authors, licences
and source pages. For every place that has photos there we build the `images`
array (cover first) so the API returns real photos and the frontend gallery can
show them. Only photos whose file actually exists are linked.

Usage:
    python scripts/link_place_photos.py            # rewrite data/places.json
    python scripts/link_place_photos.py --check    # verify, do not write

Exit codes:
    0 — data is up to date (or was rewritten successfully)
    1 — invalid manifest / photo file missing / data drifted in --check mode
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
PLACES_FILE = ROOT / "data" / "places.json"
MANIFEST_FILE = ROOT / "assets" / "places" / "manifest.json"

MAX_ALT = 300
MAX_CAPTION = 500
_SPACES = re.compile(r"\s+")
_CYRILLIC = re.compile(r"[А-Яа-яЁё]")


def _read(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        sys.exit(f"Не найден файл: {path.relative_to(ROOT)}")
    except json.JSONDecodeError as error:
        sys.exit(f"Некорректный JSON в {path.relative_to(ROOT)}: {error}")


def _one_line(value: Any) -> str:
    return _SPACES.sub(" ", str(value or "")).strip()


def _caption(photo: dict[str, Any]) -> str:
    """Author, licence and (when available) the licence terms link."""
    author = _one_line(photo.get("author"))
    licence = _one_line(photo.get("license"))
    licence_url = _one_line(photo.get("license_url"))
    if not author or not licence:
        raise SystemExit(f"У фото нет автора или лицензии: {photo.get('path')}")
    caption = f"Фото: {author} · {licence}"
    # Public-domain files have no licence page; CC files must keep a link.
    if licence_url:
        caption += f" · {licence_url}"
    return caption[:MAX_CAPTION]


def _alt(photo: dict[str, Any], place_name: str, index: int) -> str:
    """Russian description when the manifest has one; otherwise a named fallback.

    Commons descriptions are often English. The UI language is Russian, so an
    English alt would be read aloud as-is; the place name plus photo number is
    honest and understandable.
    """
    description = _one_line(photo.get("description"))
    if description and _CYRILLIC.search(description):
        return description[:MAX_ALT]
    return f"{place_name} — фотография {index}"


def _image(photo: dict[str, Any], place_name: str, index: int) -> dict[str, str]:
    path = str(photo.get("path") or "").replace("\\", "/")
    if not path.startswith("assets/places/"):
        raise SystemExit(f"Неожиданный путь фото: {path}")
    if not (ROOT / path).is_file():
        raise SystemExit(f"Нет файла фото: {path}")

    source_url = str(photo.get("source_page") or "")
    if not source_url.startswith("https://"):
        raise SystemExit(f"Нет HTTPS-страницы источника для {path}")

    return {
        "url": "/" + path,
        "alt": _alt(photo, place_name, index),
        "caption": _caption(photo),
        "source_url": source_url,
    }


def expected_images(place: dict[str, Any], item: dict[str, Any]) -> list[dict[str, str]]:
    name = _one_line(place.get("name")) or place.get("id", "место")
    return [_image(photo, name, index) for index, photo in enumerate(item.get("photos") or [], start=1)]


def build(places: list[dict[str, Any]], manifest: list[dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
    known = {place["id"] for place in places}
    by_id = {item["id"]: item for item in manifest if item.get("id") in known}
    result: dict[str, list[dict[str, str]]] = {}
    for place in places:
        item = by_id.get(place["id"])
        if not item:
            continue
        images = expected_images(place, item)
        if images:
            result[place["id"]] = images
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="проверить, не записывая файл")
    args = parser.parse_args()

    places_doc = _read(PLACES_FILE)
    manifest_doc = _read(MANIFEST_FILE)
    places = places_doc.get("items") or []
    manifest = manifest_doc.get("items") or []
    if not places or not manifest:
        print("Пустые данные: мест или записей манифеста нет", file=sys.stderr)
        return 1

    expected = build(places, manifest)
    problems = [place["id"] for place in places if place.get("images") and place["id"] not in expected]
    changed = [place["id"] for place in places if place.get("images") != expected.get(place["id"])]
    missing_files = [
        photo["path"]
        for item in manifest
        for photo in item.get("photos") or []
        if not (ROOT / str(photo.get("path") or "")).is_file()
    ]

    if missing_files:
        print("Файлы из манифеста отсутствуют:", ", ".join(sorted(set(missing_files))), file=sys.stderr)
        return 1

    if args.check:
        if changed or problems:
            print("Данные фото расходятся с манифестом:", file=sys.stderr)
            for place_id in changed:
                print(f"  - {place_id}", file=sys.stderr)
            for place_id in problems:
                print(f"  - {place_id}: images есть, но в манифесте фото нет", file=sys.stderr)
            return 1
        print(f"Фото мест: {len(expected)} мест, {sum(len(v) for v in expected.values())} изображений. Данные совпадают с манифестом.")
        return 0

    for place in places:
        images = expected.get(place["id"])
        if images:
            place["images"] = images
        else:
            place.pop("images", None)

    # newline="\n": .gitattributes pins LF for JSON; Windows must not add CRLF.
    PLACES_FILE.write_text(json.dumps(places_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    total = sum(len(value) for value in expected.values())
    print(f"Записано: {len(expected)} мест, {total} изображений в data/places.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
