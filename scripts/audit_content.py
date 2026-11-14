#!/usr/bin/env python3
"""Structural audit of the city content before a demo.

Checks what can be checked without going outside: boundary containment, links,
photo files and licences, route/quest references and stop counts. It does not
replace field verification of entrances, opening hours, prices or accessibility.

Usage:
    python scripts/audit_content.py
    python scripts/audit_content.py --json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLACES = ROOT / "data/places.json"
ROUTES = ROOT / "data/routes.json"
QUESTS = ROOT / "data/quests.json"
BOUNDARY = ROOT / "data/geo/leninsky-boundary.geojson"


def load(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8-sig")).get("items", [])


def ring_contains(x: float, y: float, ring: list[list[float]]) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def polygon_contains(x: float, y: float, polygon: list[list[list[float]]]) -> bool:
    if not polygon or not ring_contains(x, y, polygon[0]):
        return False
    return not any(ring_contains(x, y, hole) for hole in polygon[1:])


def district_polygons() -> list[list[list[float]]]:
    data = json.loads(BOUNDARY.read_text(encoding="utf-8-sig"))
    polygons: list[list[list[float]]] = []
    features = data.get("features") or [data]
    for feature in features:
        geometry = feature.get("geometry") or feature
        if geometry.get("type") == "Polygon":
            polygons.append(geometry["coordinates"])
        elif geometry.get("type") == "MultiPolygon":
            polygons.extend(geometry["coordinates"])
    if not polygons:
        raise SystemExit("В границе района нет полигонов")
    return polygons


def https(value: object) -> bool:
    return isinstance(value, str) and value.startswith("https://")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="вывести отчёт JSON")
    options = parser.parse_args()

    places = load(PLACES)
    routes = load(ROUTES)
    quests = load(QUESTS)
    polygons = district_polygons()
    served = [
        place for place in places
        if place.get("active") and place.get("district_verified")
        and place.get("status") in {"draft", "verified"}
        and isinstance(place.get("coordinates"), dict)
    ]
    served_ids = {place["id"] for place in served}
    known_ids = {place["id"] for place in places}
    issues: list[str] = []
    warnings: list[str] = []

    for place in served:
        coords = place["coordinates"]
        lat, lng = coords.get("lat"), coords.get("lng")
        if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
            issues.append(f"{place['id']}: нет числовых координат")
        elif not any(polygon_contains(lng, lat, polygon) for polygon in polygons):
            issues.append(f"{place['id']}: координаты вне полигона района")
        if not https(place.get("source_url")):
            issues.append(f"{place['id']}: source_url не HTTPS")
        images = place.get("images") or []
        if not images:
            warnings.append(f"{place['id']}: нет фотографий")
        for index, image in enumerate(images, start=1):
            label = f"{place['id']} фото {index}"
            if not https(image.get("source_url")):
                issues.append(f"{label}: source_url не HTTPS")
            if image.get("license_url") and not https(image["license_url"]):
                issues.append(f"{label}: license_url не HTTPS")
            if not image.get("credit") or not image.get("license"):
                issues.append(f"{label}: нет credit/license")
            if not image.get("alt"):
                issues.append(f"{label}: нет alt")
            url = str(image.get("url") or "")
            if url.startswith("/"):
                if not (ROOT / url.lstrip("/")).is_file():
                    issues.append(f"{label}: файла {url} нет")

    for route in routes:
        ids = route.get("place_ids") or []
        if not ids:
            issues.append(f"{route['id']}: пустой маршрут")
        for place_id in ids:
            if place_id not in known_ids:
                issues.append(f"{route['id']}: неизвестное место {place_id}")
            elif place_id not in served_ids:
                issues.append(f"{route['id']}: место {place_id} не отдаётся API")

    for quest in quests:
        stops = quest.get("stops") or []
        if len(stops) != quest.get("stop_count"):
            issues.append(f"{quest['id']}: stop_count={quest.get('stop_count')}, точек {len(stops)}")
        stop_ids = [stop.get("id") for stop in stops]
        if len(stop_ids) != len(set(stop_ids)):
            issues.append(f"{quest['id']}: повторяются stop_id")
        for stop in stops:
            if stop.get("place_id") not in served_ids:
                issues.append(f"{quest['id']}/{stop.get('id')}: место {stop.get('place_id')} не отдаётся API")
            option_ids = [option.get("id") for option in stop.get("options") or []]
            if len(option_ids) != len(set(option_ids)):
                issues.append(f"{quest['id']}/{stop.get('id')}: повторяются option_id")

    statuses = {status: sum(1 for place in served if place.get("status") == status) for status in ("draft", "verified")}
    checked = sum(1 for place in served if place.get("checked_at"))
    report = {
        "places_total": len(places),
        "places_served": len(served),
        "routes": len(routes),
        "quests": len(quests),
        "photos": sum(len(place.get("images") or []) for place in served),
        "statuses": statuses,
        "field_checked_places": checked,
        "issues": issues,
        "warnings": warnings,
        "field_verification": "не выполнена: входы, часы, цены и доступность требуют человека на месте",
    }
    if options.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"Мест в каталоге: {len(places)}, отдаётся API: {len(served)}")
        print(f"Маршрутов: {len(routes)}, квестов: {len(quests)}, фото: {report['photos']}")
        print(f"Статусы: {statuses}; полевая проверка: {checked}/{len(served)}")
        if warnings:
            print("\nПредупреждения:")
            for warning in warnings:
                print("  -", warning)
        if issues:
            print("\nОшибки:")
            for issue in issues:
                print("  -", issue)
        else:
            print("\nСтруктурных ошибок нет.")
        print("\nПолевая проверка не выполнялась и этим скриптом не заменяется.")
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
