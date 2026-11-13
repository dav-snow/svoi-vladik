"""One-origin demo API. Candidate status is preserved; answer keys stay private."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
import time
from collections import deque
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Path as ApiPath, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, field_validator, model_validator
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("svoi-vladik")
REPO_ROOT = Path(__file__).resolve().parent.parent
PLACES_FILE = REPO_ROOT / "data/places.json"
POI_FILE = REPO_ROOT / "data/geo/leninsky-poi-candidates.geojson"
BOUNDARY_FILE = REPO_ROOT / "data/geo/leninsky-boundary.geojson"
ROUTES_FILE = REPO_ROOT / "data/routes.json"
QUESTS_FILE = REPO_ROOT / "data/quests.json"
ANSWERS_FILE = REPO_ROOT / "data/private/quest-answers.json"
FRONTEND_DIR = REPO_ROOT / "frontend-design/dist"
DATA_DIR = FRONTEND_DIR / "data"
# Kept for callers of the old loader; public endpoints no longer substitute mocks.
ROUTES_MOCK_FILE = REPO_ROOT / "data/examples/route_mock.json"
QUESTS_MOCK_FILE = REPO_ROOT / "data/examples/quest_mock.json"
GEO_JSON_MEDIA_TYPE = "application/geo+json"
ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
Id = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=64, pattern=ID_PATTERN)]
Status = Literal["draft", "verified", "needs_review", "expired", "archived", "demo"]
Category = Literal["culture", "viewpoint", "park", "food", "toilet", "other"]
SECURITY_HEADERS = {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "Permissions-Policy": "geolocation=(self)"}

class Coordinates(BaseModel):
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False, strict=True)
    lng: float = Field(ge=-180, le=180, allow_inf_nan=False, strict=True)

class SourceRef(BaseModel):
    title: str
    url: str

    @field_validator("url")
    @classmethod
    def https_url(cls, value):
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Expected a public HTTPS source")
        return value

class Editorial(BaseModel):
    # An explicit response model drops unrecognised editorial/private fields.
    model_config = ConfigDict(extra="ignore")
    source_url: str | None = None
    sources: list[SourceRef] = Field(default_factory=list)
    checked_at: str | None = None
    verification_note: str | None = None
    status: Status = "draft"

    @field_validator("source_url")
    @classmethod
    def https_source(cls, value):
        return SourceRef.https_url(value) if value else value

class Place(Editorial):
    id: Id
    name: str = Field(min_length=1, max_length=300)
    category: Category
    coordinates: Coordinates | None = None
    price_rub: int | None = Field(default=None, ge=0, strict=True)
    description: str = ""
    address: str | None = None
    image: str | None = None
    district_verified: bool = Field(default=False, strict=True)
    active: bool = Field(default=True, strict=True)
    osm_tags: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def active_coordinates(self):
        if self.active and self.coordinates is None:
            raise ValueError("Active place needs coordinates")
        return self

class Route(Editorial):
    id: Id
    title: str
    description: str
    place_ids: list[Id] = Field(min_length=3, max_length=5)
    estimated_minutes: int | None = Field(default=None, ge=1)
    route_note: str | None = None
    route_checked_at: str | None = None
    quest_id: Id | None = None

    @field_validator("place_ids")
    @classmethod
    def unique_places(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("Duplicate route place")
        return value

class QuestOption(BaseModel):
    id: Id
    text: str

class QuestStop(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: Id
    place_id: Id
    title: str
    fact_text: str
    fiction_text: str = ""
    question: str
    options: list[QuestOption] = Field(min_length=2, max_length=6)
    sources: list[SourceRef] = Field(default_factory=list)
    checked_at: str | None = None

    @model_validator(mode="after")
    def unique_options(self):
        if len({o.id for o in self.options}) != len(self.options):
            raise ValueError("Duplicate option")
        return self

class Quest(Editorial):
    id: Id
    title: str
    description: str
    estimated_minutes: int | None = Field(default=None, ge=1)
    related_place_ids: list[Id]
    stop_count: int = Field(ge=3, le=5)
    stops: list[QuestStop] = Field(min_length=3, max_length=5)

    @model_validator(mode="after")
    def consistent_stops(self):
        if self.stop_count != len(self.stops) or len({s.id for s in self.stops}) != len(self.stops):
            raise ValueError("Invalid stop count or duplicate stop")
        if set(s.place_id for s in self.stops) != set(self.related_place_ids):
            raise ValueError("Quest places do not match stops")
        return self

class AnswerInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    stop_id: Id
    option_id: Id

class CompleteInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    answers: list[AnswerInput] = Field(max_length=5)

    @field_validator("answers")
    @classmethod
    def unique_answers(cls, value):
        if len({a.stop_id for a in value}) != len(value):
            raise ValueError("One answer per stop")
        return value

class PrivateAnswer(BaseModel):
    correct_option_id: Id
    explanation: str = Field(min_length=1)


def _read_json_safely(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def load_collection(real_path: Path, mock_path: Path | None, model: type[BaseModel]) -> dict[str, Any]:
    """Fail closed on bad data. A missing real dataset is not a mock catalogue."""
    data = _read_json_safely(real_path)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return {"items": [], "total": 0}
    items, seen = [], set()
    for raw in data["items"]:
        try:
            item = model.model_validate(raw)
            if item.id in seen:
                continue
            seen.add(item.id)
            items.append(item.model_dump())
        except (TypeError, ValueError, ValidationError):
            logger.warning("Skipped invalid %s record", model.__name__)
    return {"items": items, "total": len(items)}


def load_places() -> list[Place]:
    if PLACES_FILE.exists():
        records = load_collection(PLACES_FILE, None, Place)["items"]
    else:
        # Compatibility with the three original OSM candidates until import.
        raw = _read_json_safely(POI_FILE) or {}
        records = []
        for feature in raw.get("features", []):
            try:
                p = feature["properties"]
                if feature["geometry"]["type"] != "Point":
                    continue
                lng, lat = feature["geometry"]["coordinates"]
                records.append({"id": feature["id"], "name": p["name"], "category": p.get("category", "other"), "coordinates": {"lat": lat, "lng": lng}, "status": p.get("status", "draft"), "price_rub": p.get("price_rub"), "checked_at": p.get("checked_at"), "source_url": p.get("osm_url"), "verification_note": p.get("verification_note"), "osm_tags": p.get("osm_tags", {}), "district_verified": p.get("district_membership") == "representative_point_inside_osm_boundary", "active": True})
            except (KeyError, TypeError, ValueError):
                continue
    result = []
    for raw in records:
        try:
            place = Place.model_validate(raw)
            if place.active and place.district_verified and place.status in {"draft", "verified"}:
                result.append(place)
        except ValidationError:
            continue
    return result

# Retained as an import-compatible snapshot; requests read current files.
PLACES = load_places()

_DEFAULT_ERRORS = {
    400: ("BAD_REQUEST", "Неверный запрос"), 404: ("NOT_FOUND", "Ресурс не найден"),
    405: ("METHOD_NOT_ALLOWED", "Метод не поддерживается"), 413: ("PAYLOAD_TOO_LARGE", "Запрос слишком большой"),
    414: ("URI_TOO_LONG", "Строка запроса слишком длинная"), 415: ("UNSUPPORTED_MEDIA_TYPE", "Ожидается JSON"),
    422: ("VALIDATION_ERROR", "Неверные параметры запроса"), 429: ("RATE_LIMITED", "Слишком много запросов; попробуйте позже"),
    500: ("INTERNAL_ERROR", "Внутренняя ошибка сервера"), 503: ("UNAVAILABLE", "Данные временно недоступны"),
}

def _error_response(status_code, code=None, message=None):
    default_code, default_message = _DEFAULT_ERRORS.get(status_code, ("ERROR", "Ошибка"))
    return JSONResponse(status_code=status_code, content={"error": {"code": code or default_code, "message": message or default_message}}, headers=SECURITY_HEADERS)

def _raise_api_error(status_code, code=None, message=None):
    default_code, default_message = _DEFAULT_ERRORS[status_code]
    raise HTTPException(status_code, detail={"code": code or default_code, "message": message or default_message})

class PostLimiter:
    """Single-process demo limit. Salted opaque keys, no persistent IP log."""
    def __init__(self):
        self.salt = secrets.token_bytes(32)
        self.events: dict[str, deque] = {}
        self.limit = 30

    def allow(self, host):
        now = time.monotonic()
        key = hmac.new(self.salt, host.encode(), hashlib.sha256).hexdigest()
        for old_key, hits in list(self.events.items()):
            while hits and hits[0] <= now - 60:
                hits.popleft()
            if not hits:
                del self.events[old_key]
        if key not in self.events:
            if len(self.events) >= 2048:
                return False
            self.events[key] = deque()
        if len(self.events[key]) >= self.limit:
            return False
        self.events[key].append(now)
        return True

POST_LIMITER = PostLimiter()

class DemoSafetyMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        async def send_safe(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                existing = {k.lower() for k, _ in headers}
                headers.extend((k.lower().encode(), v.encode()) for k, v in SECURITY_HEADERS.items() if k.lower().encode() not in existing)
                message["headers"] = headers
            await send(message)
        # Block even if a private file is accidentally copied into the web root.
        normal = path.replace("\\", "/").casefold()
        if normal == "/data/private" or normal.startswith("/data/private/"):
            return await _error_response(404)(scope, receive, send_safe)
        if path.startswith("/api/") and len(scope.get("query_string", b"")) > 1024:
            return await _error_response(414)(scope, receive, send_safe)
        is_answer = scope["method"] == "POST" and path.startswith("/api/v1/quest/") and path.rsplit("/", 1)[-1] in {"answer", "complete"}
        if is_answer:
            host = (scope.get("client") or ("unknown", 0))[0]
            if not POST_LIMITER.allow(host):
                response = _error_response(429)
                response.headers["Retry-After"] = "60"
                return await response(scope, receive, send_safe)
            headers = {k.lower(): v for k, v in scope.get("headers", [])}
            if headers.get(b"content-type", b"").split(b";", 1)[0].strip().lower() != b"application/json" or headers.get(b"content-encoding", b"identity") != b"identity":
                return await _error_response(415)(scope, receive, send_safe)
            body = bytearray()
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                body.extend(message.get("body", b""))
                if len(body) > 16 * 1024:
                    return await _error_response(413)(scope, receive, send_safe)
                if not message.get("more_body", False):
                    break
            delivered = False
            async def replay():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}
                return await receive()
            return await self.app(scope, replay, send_safe)
        await self.app(scope, receive, send_safe)

app = FastAPI(title="Svoi Vladik API", version="0.2.0")
app.add_middleware(DemoSafetyMiddleware)
# Same-origin UI: no permissive CORS middleware is necessary.

@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request, exc):
    detail = exc.detail
    if isinstance(detail, dict):
        return _error_response(exc.status_code, detail.get("code"), detail.get("message"))
    return _error_response(exc.status_code)

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request, exc):
    return _error_response(422)

@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc):
    logger.error("Unhandled API error")
    return _error_response(500)

@app.get("/health")
@app.get("/api/v1/health", include_in_schema=False)
async def health():
    return {"status": "ok"}

@app.get("/api/v1/places")
async def get_places(request: Request, category: Category | None = None, max_price_rub: Annotated[int | None, Query(ge=0, le=100000)] = None):
    params = list(request.query_params.multi_items())
    if any(k not in {"category", "max_price_rub"} for k, _ in params) or len({k for k, _ in params}) != len(params):
        _raise_api_error(422)
    places = [p.model_dump() for p in load_places() if (category is None or p.category == category) and (max_price_rub is None or p.price_rub is not None and p.price_rub <= max_price_rub)]
    return {"items": places, "total": len(places)}

@app.get("/api/v1/places/{place_id}")
async def get_place(place_id: Annotated[str, ApiPath(pattern=ID_PATTERN, min_length=1, max_length=64)]):
    for p in load_places():
        if p.id == place_id:
            return p.model_dump()
    _raise_api_error(404, message="Место не найдено")

def public_collection(path, model):
    data = load_collection(path, None, model)
    active_ids = {p.id for p in load_places()}
    data["items"] = [item for item in data["items"] if item["status"] in {"draft", "verified"} and set(item.get("place_ids", item.get("related_place_ids", []))) <= active_ids]
    data["total"] = len(data["items"])
    return data

@app.get("/api/v1/walks")
async def get_walks():
    return public_collection(ROUTES_FILE, Route)

@app.get("/api/v1/quest")
async def get_quest():
    return public_collection(QUESTS_FILE, Quest)

def find_quest(quest_id):
    for item in public_collection(QUESTS_FILE, Quest)["items"]:
        if item["id"] == quest_id:
            return Quest.model_validate(item)
    _raise_api_error(404, message="Квест не найден")

def find_stop_option(quest, answer):
    stop = next((s for s in quest.stops if s.id == answer.stop_id), None)
    if stop is None or answer.option_id not in {o.id for o in stop.options}:
        _raise_api_error(404, message="Точка или вариант не найдены")
    return stop

def private_answers(quest):
    raw = _read_json_safely(ANSWERS_FILE)
    try:
        keys = raw["quests"][quest.id]
        result = {s.id: PrivateAnswer.model_validate(keys[s.id]) for s in quest.stops}
        if any(result[s.id].correct_option_id not in {o.id for o in s.options} for s in quest.stops):
            raise ValueError("Answer key mismatch")
        return result
    except (KeyError, TypeError, ValueError, ValidationError):
        _raise_api_error(503, message="Проверка ответов временно недоступна")

@app.post("/api/v1/quest/{quest_id}/answer")
async def answer_quest(quest_id: Annotated[str, ApiPath(pattern=ID_PATTERN, max_length=64)], answer: AnswerInput):
    quest = find_quest(quest_id)
    stop = find_stop_option(quest, answer)
    key = private_answers(quest)[stop.id]
    return {"correct": answer.option_id == key.correct_option_id, "explanation": key.explanation}

@app.post("/api/v1/quest/{quest_id}/complete")
async def complete_quest(quest_id: Annotated[str, ApiPath(pattern=ID_PATTERN, max_length=64)], submission: CompleteInput):
    quest = find_quest(quest_id)
    for answer in submission.answers:
        find_stop_option(quest, answer)
    keys = private_answers(quest)
    completed = {a.stop_id for a in submission.answers} == {s.id for s in quest.stops} and all(a.option_id == keys[a.stop_id].correct_option_id for a in submission.answers)
    if not completed:
        return {"completed": False, "reward": None}
    return {"completed": True, "reward": {"id": "explorer-hat", "name": "Шапка исследователя"}}

@app.get("/api/v1/test-empty")
async def test_empty():
    return []

@app.get("/api/v1/test-error")
async def test_error():
    _raise_api_error(404, message="Место не найдено")

# Explicit allowlist, never turn the repository data directory into a mount.
@app.get("/api/v1/map-data/{filename}")
async def map_data(filename: str):
    allowed = {"leninsky-boundary.geojson": BOUNDARY_FILE, "leninsky-poi-candidates.geojson": POI_FILE}
    file = allowed.get(filename)
    if file is None or not file.is_file():
        _raise_api_error(404)
    return FileResponse(file, media_type=GEO_JSON_MEDIA_TYPE)

@app.get("/data/leninsky-boundary.geojson")
async def data_boundary():
    return await map_data("leninsky-boundary.geojson")

@app.get("/data/leninsky-poi-candidates.geojson")
async def data_pois():
    return await map_data("leninsky-poi-candidates.geojson")

if DATA_DIR.is_dir():
    app.mount("/data", StaticFiles(directory=DATA_DIR), name="data")
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
