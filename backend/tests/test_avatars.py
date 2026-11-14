"""Server-side avatar unlocks and quest-completion sync for signed-in visitors."""
from __future__ import annotations

from fastapi.testclient import TestClient

import main


def _client() -> TestClient:
    return TestClient(main.app)


def _register(client: TestClient, login: str = "avatar-user") -> None:
    response = client.post("/api/v1/auth/register", json={"login": login, "password": "password123"})
    assert response.status_code == 201


def test_avatars_require_a_session() -> None:
    client = _client()
    assert client.get("/api/v1/me/avatars").status_code == 401
    assert client.put("/api/v1/me/avatars", json={"selected": "lighthouse"}).status_code == 401
    assert client.post("/api/v1/me/quests/import", json={"quest_ids": ["quest-three-keys"]}).status_code == 401


def test_new_user_has_no_avatar_and_no_unlocks() -> None:
    client = _client()
    _register(client)
    assert client.get("/api/v1/me/avatars").json() == {
        "selected": None,
        "unlocked": 0,
        "completed_quest_ids": [],
    }


def test_free_avatar_can_be_selected_but_locked_one_cannot() -> None:
    client = _client()
    _register(client)
    free = client.put("/api/v1/me/avatars", json={"selected": "lighthouse"})
    assert free.status_code == 200
    assert free.json()["selected"] == "lighthouse"
    locked = client.put("/api/v1/me/avatars", json={"selected": "compass"})
    assert locked.status_code == 409
    assert locked.json()["error"]["code"] == "AVATAR_LOCKED"
    unknown = client.put("/api/v1/me/avatars", json={"selected": "dragon"})
    assert unknown.status_code == 422


def test_imported_quests_unlock_avatars_once_and_stay_unique() -> None:
    client = _client()
    _register(client)
    first = client.post("/api/v1/me/quests/import", json={"quest_ids": ["quest-three-keys"]})
    assert first.status_code == 200
    assert first.json()["unlocked"] == 1
    assert first.json()["completed_quest_ids"] == ["quest-three-keys"]
    assert client.put("/api/v1/me/avatars", json={"selected": "compass"}).status_code == 200
    again = client.post("/api/v1/me/quests/import", json={"quest_ids": ["quest-three-keys"]})
    assert again.json()["unlocked"] == 1
    assert again.json()["completed_quest_ids"] == ["quest-three-keys"]
    unknown = client.post("/api/v1/me/quests/import", json={"quest_ids": ["no-such-quest"]})
    assert unknown.status_code == 422


def test_three_unique_quests_unlock_the_bridge_and_selection_can_be_cleared() -> None:
    client = _client()
    _register(client)
    quests = ["quest-three-keys", "quest-leninsky-culture-001", "quest-letter-vladostok"]
    known = {item["id"] for item in main.public_collection(main.QUESTS_FILE, main.Quest)["items"]}
    quests = [quest_id for quest_id in [*quests, "quest-letter-vladivostok", "quest-city-code"] if quest_id in known][:3]
    result = client.post("/api/v1/me/quests/import", json={"quest_ids": quests})
    assert result.status_code == 200
    assert result.json()["unlocked"] == 3
    assert client.put("/api/v1/me/avatars", json={"selected": "bridge"}).status_code == 200
    cleared = client.put("/api/v1/me/avatars", json={"selected": None})
    assert cleared.status_code == 200
    assert cleared.json()["selected"] is None
    assert cleared.json()["unlocked"] == 3
