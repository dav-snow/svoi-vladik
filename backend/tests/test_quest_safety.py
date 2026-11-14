"""Contract/security behavior against isolated editorial data; no network needed."""
import json

import pytest
from fastapi.testclient import TestClient
import main


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


@pytest.fixture
def editorial_client(tmp_path, monkeypatch):
    main.POST_LIMITER.events.clear()
    paths = {name: tmp_path / filename for name, filename in {
        "PLACES_FILE": "places.json", "QUESTS_FILE": "quests.json", "ROUTES_FILE": "routes.json",
        "ANSWERS_FILE": "private/quest-answers.json"}.items()}
    for name, path in paths.items():
        monkeypatch.setattr(main, name, path)
    places = [{"id": f"place-{n}", "name": f"Место {n}", "category": "culture", "coordinates": {"lat": 43.12, "lng": 131.9}, "status": "draft", "price_rub": None, "source_url": "https://www.openstreetmap.org/", "district_verified": True, "active": True} for n in range(1, 6)]
    stops = [{"id": f"stop-{n}", "place_id": f"place-{n}", "title": f"Точка {n}", "fact_text": "Материал из источника", "question": "Вопрос?", "options": [{"id": f"a-{n}", "text": "A", "correct": True}, {"id": f"b-{n}", "text": "B"}], "correct_option_id": "SHOULD-NOT-LEAK", "explanation": "PRIVATE-EXPLANATION"} for n in range(1, 6)]
    quest = {"id": "quest-one", "title": "Тестовый квест", "description": "Контрактная фикстура", "related_place_ids": [f"place-{n}" for n in range(1, 6)], "stop_count": 5, "estimated_minutes": None, "status": "draft", "stops": stops}
    keys = {f"stop-{n}": {"correct_option_id": f"a-{n}", "explanation": f"Пояснение {n}"} for n in range(1, 6)}
    write_json(paths["PLACES_FILE"], {"items": places, "total": 999})
    write_json(paths["QUESTS_FILE"], {"items": [quest]})
    write_json(paths["ROUTES_FILE"], {"items": [{"id": "walk-one", "title": "Прогулка", "description": "Черновик", "place_ids": [p["id"] for p in places], "estimated_minutes": None, "status": "draft"}]})
    write_json(paths["ANSWERS_FILE"], {"quests": {"quest-one": keys}})
    with TestClient(main.app) as client:
        yield client, paths, quest, places
    main.POST_LIMITER.events.clear()


def test_public_quest_drops_keys_at_every_model_level(editorial_client):
    client, _, _, _ = editorial_client
    response = client.get("/api/v1/quest")
    assert response.status_code == 200
    assert response.json()["items"][0]["stop_count"] == 5
    assert response.json()["items"][0]["estimated_minutes"] is None
    assert "correct_option_id" not in response.text
    assert "PRIVATE-EXPLANATION" not in response.text
    assert "SHOULD-NOT-LEAK" not in response.text
    assert "correct" not in response.json()["items"][0]["stops"][0]["options"][0]


def test_places_publish_only_active_district_candidates_and_keep_unknown(editorial_client):
    client, paths, _, places = editorial_client
    places.extend([{**places[0], "id": "inactive", "active": False, "coordinates": None},
                   {**places[0], "id": "outside", "district_verified": False},
                   {**places[0], "id": "nan", "coordinates": {"lat": float("nan"), "lng": 131.9}},
                   {**places[0], "id": "infinity", "coordinates": {"lat": 43, "lng": float("inf")}}])
    write_json(paths["PLACES_FILE"], {"items": places})
    body = client.get("/api/v1/places").json()
    assert body["total"] == 5
    assert all(p["status"] == "draft" and p["price_rub"] is None and p["checked_at"] is None for p in body["items"])
    assert client.get("/api/v1/places/inactive").status_code == 404
    assert client.get("/api/v1/places?max_price_rub=0").json()["items"] == []
    assert client.get("/api/v1/walks").json()["items"][0]["estimated_minutes"] is None


@pytest.mark.parametrize("query", ["category=nope", "max_price_rub=-1", "max_price_rub=1.5", "lat=43", "category=culture&category=park"])
def test_invalid_filter_rejected(editorial_client, query):
    assert editorial_client[0].get("/api/v1/places?" + query).status_code == 422


def test_answer_checks_pair_without_publishing_key(editorial_client):
    client = editorial_client[0]
    url = "/api/v1/quest/quest-one/answer"
    correct = client.post(url, json={"stop_id": "stop-1", "option_id": "a-1"})
    assert correct.json() == {"correct": True, "explanation": "Пояснение 1"}
    assert client.post(url, json={"stop_id": "stop-1", "option_id": "b-1"}).json()["correct"] is False
    assert client.post(url, json={"stop_id": "stop-1", "option_id": "a-2"}).status_code == 404
    assert client.post(url, json={"stop_id": "missing", "option_id": "a-1"}).status_code == 404
    assert client.post("/api/v1/quest/missing/answer", json={"stop_id": "stop-1", "option_id": "a-1"}).status_code == 404


def test_completion_requires_every_distinct_correct_answer(editorial_client):
    client = editorial_client[0]
    url = "/api/v1/quest/quest-one/complete"
    answers = [{"stop_id": f"stop-{n}", "option_id": f"a-{n}"} for n in range(1, 6)]
    assert client.post(url, json={"answers": answers[:-1]}).json() == {"completed": False}
    wrong = [*answers[:-1], {"stop_id": "stop-5", "option_id": "b-5"}]
    assert client.post(url, json={"answers": wrong}).json()["completed"] is False
    result = client.post(url, json={"answers": answers})
    assert result.json() == {"completed": True}
    assert client.post(url, json={"answers": [answers[0], answers[0]]}).status_code == 422
    assert client.post(url, json={"answers": [{"stop_id": "missing", "option_id": "a-1"}]}).status_code == 404


def test_three_stop_quest_is_supported(editorial_client):
    client, paths, quest, _ = editorial_client
    quest["stops"] = quest["stops"][:3]
    quest["related_place_ids"] = quest["related_place_ids"][:3]
    quest["stop_count"] = 3
    write_json(paths["QUESTS_FILE"], {"items": [quest]})
    assert client.get("/api/v1/quest").json()["items"][0]["stop_count"] == 3
    answer = [{"stop_id": f"stop-{n}", "option_id": f"a-{n}"} for n in range(1, 4)]
    assert client.post("/api/v1/quest/quest-one/complete", json={"answers": answer}).json()["completed"] is True


@pytest.mark.parametrize("payload", [{"stop_id": "x" * 65, "option_id": "a-1"}, {"stop_id": "stop-1", "option_id": "a-1", "lat": 43}, {"stop_id": 1, "option_id": "a-1"}])
def test_request_schema_is_strict(editorial_client, payload):
    assert editorial_client[0].post("/api/v1/quest/quest-one/answer", json=payload).status_code == 422


def test_invalid_json_body_limit_content_type_and_private_paths(editorial_client):
    client = editorial_client[0]
    url = "/api/v1/quest/quest-one/answer"
    assert client.post(url, content="{", headers={"Content-Type": "application/json"}).status_code == 422
    assert client.post(url, content="{}", headers={"Content-Type": "text/plain"}).status_code == 415
    assert client.post(url, content=b"x" * 17000, headers={"Content-Type": "application/json"}).status_code == 413
    # Generator transport sends an unknown-length stream (no Content-Length).
    assert client.post(url, content=iter([b"x" * 9000, b"x" * 9000]), headers={"Content-Type": "application/json"}).status_code == 413
    for path in ["/data/private/quest-answers.json", "/data/PRIVATE/quest-answers.json", "/api/v1/map-data/quest-answers.json"]:
        response = client.get(path)
        assert response.status_code == 404
        assert "correct_option_id" not in response.text


def test_missing_private_keys_fail_closed(editorial_client):
    client, paths, _, _ = editorial_client
    paths["ANSWERS_FILE"].unlink()
    response = client.post("/api/v1/quest/quest-one/answer", json={"stop_id": "stop-1", "option_id": "a-1"})
    assert response.status_code == 503
    assert "Traceback" not in response.text


def test_same_origin_headers_and_rate_limit(editorial_client):
    client = editorial_client[0]
    response = client.get("/api/v1/places", headers={"Origin": "https://unrelated.example"})
    assert "access-control-allow-origin" not in response.headers
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["permissions-policy"] == "geolocation=(self)"
    main.POST_LIMITER.limit = 2
    try:
        for _ in range(2):
            assert client.post("/api/v1/quest/quest-one/answer", json={"stop_id": "stop-1", "option_id": "a-1"}).status_code == 200
        assert client.post("/api/v1/quest/quest-one/answer", json={"stop_id": "stop-1", "option_id": "a-1"}).status_code == 429
    finally:
        main.POST_LIMITER.limit = 30
    assert all("testclient" not in key for key in main.POST_LIMITER.events)
