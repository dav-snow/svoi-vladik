"""One-origin demo API. Candidate status is preserved; answer keys stay private."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import time
from collections import deque
from contextlib import asynccontextmanager, closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Path as ApiPath, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, computed_field, field_validator, model_validator
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("svoi-vladik")
REPO_ROOT = Path(__file__).resolve().parent.parent
PLACES_FILE = REPO_ROOT / "data/places.json"
POI_FILE = REPO_ROOT / "data/geo/leninsky-poi-candidates.geojson"
BOUNDARY_FILE = REPO_ROOT / "data/geo/leninsky-boundary.geojson"
ROUTES_FILE = REPO_ROOT / "data/routes.json"
QUESTS_FILE = REPO_ROOT / "data/quests.json"
ANSWERS_FILE = REPO_ROOT / "data/private/quest-answers.json"
GUIDES_FILE = REPO_ROOT / "data/guides.json"
FRONTEND_DIR = REPO_ROOT / "frontend-design/dist"
DATA_DIR = FRONTEND_DIR / "data"
# Editorial place photos, referenced in data as /media/...
MEDIA_DIR = REPO_ROOT / "data" / "media"
# Content team's licensed photo pack (manifest + jpgs), served at /assets/places.
PLACE_PHOTOS_DIR = REPO_ROOT / "assets" / "places"
# Kept for callers of the old loader; public endpoints no longer substitute mocks.
ROUTES_MOCK_FILE = REPO_ROOT / "data/examples/route_mock.json"
QUESTS_MOCK_FILE = REPO_ROOT / "data/examples/quest_mock.json"
GEO_JSON_MEDIA_TYPE = "application/geo+json"
DEFAULT_DB_FILE = REPO_ROOT / "data/demo.sqlite3"
SESSION_COOKIE = "sv_session"
SESSION_TTL_SECONDS = 7 * 24 * 3600
SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_DKLEN = 2**14, 8, 1, 32
ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
LOGIN_PATTERN = r"^[A-Za-z0-9_.-]+$"
Id = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=64, pattern=ID_PATTERN)]
Login = Annotated[str, StringConstraints(strict=True, min_length=3, max_length=32, pattern=LOGIN_PATTERN)]
Status = Literal["draft", "verified", "needs_review", "expired", "archived", "demo"]
Category = Literal["culture", "viewpoint", "park", "food", "toilet", "other"]
Need = Literal["eat", "toilet", "fun", "lodging"]
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

# Safe image reference: public HTTPS URL, or a same-origin path under
# /media or /assets. No protocol-relative URLs, no traversal, no encoding tricks.
_IMAGE_PATH_RE = re.compile(r"^/(?:media|assets)/[A-Za-z0-9._/-]+$")

def _valid_image_url(value: str) -> str:
    if value.startswith("https://"):
        return SourceRef.https_url(value)
    if ".." in value or "//" in value or not _IMAGE_PATH_RE.match(value):
        raise ValueError("Expected a public HTTPS URL or /media|/assets path")
    return value

class PlaceImage(BaseModel):
    """One gallery photo for a place (same origin or public HTTPS)."""
    url: str = Field(min_length=1, max_length=500)
    alt: str = Field(default="", max_length=300)
    caption: str = Field(default="", max_length=500)
    source_url: str | None = None
    # Attribution surfaced separately so the gallery can render a licence link.
    credit: str = Field(default="", max_length=300)
    license: str = Field(default="", max_length=120)
    license_url: str | None = None

    @field_validator("url")
    @classmethod
    def valid_url(cls, value):
        return _valid_image_url(value)

    @field_validator("source_url")
    @classmethod
    def https_source(cls, value):
        return SourceRef.https_url(value) if value else value

    @field_validator("license_url")
    @classmethod
    def https_license(cls, value):
        return SourceRef.https_url(value) if value else value

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
    image: str | None = None  # legacy single cover; keep for backward compat
    images: list[PlaceImage] = Field(default_factory=list)
    district_verified: bool = Field(default=False, strict=True)
    active: bool = Field(default=True, strict=True)
    osm_tags: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def active_coordinates(self):
        if self.active and self.coordinates is None:
            raise ValueError("Active place needs coordinates")
        return self

    @computed_field  # type: ignore[prop-decorator]
    @property
    def route_url(self) -> str | None:
        """Ready-to-use 2GIS pedestrian route to this place.

        Official format: https://2gis.ru/directions/tab/pedestrian/points/|<lon>,<lat>
        The pipe is a literal separator (empty start = user's location, end =
        this point). Keep it unencoded: 2GIS reads the raw path, and %7C makes it
        drop the destination. The frontend should use this value as-is.
        """
        if self.coordinates is None:
            return None
        return (
            "https://2gis.ru/directions/tab/pedestrian/points/"
            f"|{self.coordinates.lng},{self.coordinates.lat}"
        )

class Guide(Editorial):
    """Practical city card: address and source only, no coordinates yet."""
    id: Id
    title: str = Field(min_length=1, max_length=300)
    need: Need
    address: str = Field(min_length=1, max_length=300)
    price_note: str = ""
    note: str = ""

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

class Credentials(BaseModel):
    """Demo auth: a password never leaves this model as plain text."""
    model_config = ConfigDict(extra="forbid", strict=True)
    login: Login
    password: str = Field(min_length=8, max_length=128)

    def __repr__(self) -> str:  # keep the password out of logs and traces
        return f"Credentials(login={self.login!r})"

    __str__ = __repr__

# --- Guided onboarding (Влада) progress, per registered user ---
OnboardingStatus = Literal["pending", "in_progress", "completed", "skipped"]
OnboardingInterest = Literal["places", "walks", "quest"]
OnboardingStep = Annotated[
    str, StringConstraints(strict=True, min_length=1, max_length=64, pattern=r"^[a-z0-9_-]+$")
]

class OnboardingUpdate(BaseModel):
    """Partial update: only provided fields change. Status/step/interest are
    validated so the client cannot store arbitrary text."""
    model_config = ConfigDict(extra="forbid", strict=True)
    status: OnboardingStatus | None = None
    step: OnboardingStep | None = None
    interest: OnboardingInterest | None = None

# --- SQLite demo database: users, sessions, visits, likes -------------------
# Stdlib sqlite3 only, one short-lived connection per request, parameterized
# queries. The file path comes from DB_PATH; a broken database must degrade
# (zero counters on GET, 503 on writes), never crash the API.

# Bump when the schema below changes; open_db runs the idempotent DDL for older
# files (FK/indices are only created for new tables, not retrofitted).
_SCHEMA_VERSION = 2

_DB_SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY,
    login TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visits(
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    place_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, place_id)
);
CREATE TABLE IF NOT EXISTS likes(
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    place_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, place_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_visits_place ON visits(place_id);
CREATE INDEX IF NOT EXISTS idx_likes_place ON likes(place_id);
CREATE TABLE IF NOT EXISTS onboarding(
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    step TEXT,
    interest TEXT,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);
"""

def db_path() -> Path:
    return Path(os.environ.get("DB_PATH") or DEFAULT_DB_FILE)

def open_db() -> sqlite3.Connection:
    path = db_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise sqlite3.OperationalError(str(exc)) from exc
    conn = sqlite3.connect(path, timeout=5)
    try:
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA journal_mode = WAL")
        # Per-connection: enables ON DELETE CASCADE enforcement for this handle.
        conn.execute("PRAGMA foreign_keys = ON")
        if conn.execute("PRAGMA user_version").fetchone()[0] < _SCHEMA_VERSION:
            conn.executescript(_DB_SCHEMA)
            conn.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
            conn.commit()
    except sqlite3.Error:
        conn.close()
        raise
    return conn

def _db_or_503() -> sqlite3.Connection:
    try:
        return open_db()
    except sqlite3.Error:
        _raise_api_error(503, message="База данных временно недоступна")

def _utc_now() -> datetime:
    return datetime.now(timezone.utc)

def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_DKLEN, maxmem=64 * 1024 * 1024)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"

def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n_raw, r_raw, p_raw, salt_hex, hash_hex = stored.split("$")
        n, r, p = int(n_raw), int(r_raw), int(p_raw)
        salt, expected = bytes.fromhex(salt_hex), bytes.fromhex(hash_hex)
        # Sanity bounds so a tampered row cannot demand unbounded memory.
        if scheme != "scrypt" or not (2 <= n <= 2**20) or not (1 <= r <= 32) or not (1 <= p <= 16) or not (16 <= len(expected) <= 64) or len(salt) < 8:
            return False
        digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=len(expected), maxmem=256 * 1024 * 1024)
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(digest, expected)

# Verified against unknown logins too, so both failures cost the same time.
_DUMMY_HASH = hash_password(secrets.token_hex(16))

def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

def create_session(conn: sqlite3.Connection, user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    now = _utc_now()
    # Opportunistically drop expired sessions so they do not accumulate; this
    # runs on login only, not on every request.
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (_iso(now),))
    conn.execute(
        "INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (_token_hash(token), user_id, _iso(now), _iso(now + timedelta(seconds=SESSION_TTL_SECONDS))),
    )
    conn.commit()
    return token

def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_TTL_SECONDS, path="/", httponly=True, samesite="lax", secure=os.environ.get("COOKIE_SECURE") == "1")

def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax", secure=os.environ.get("COOKIE_SECURE") == "1")

def session_user(conn: sqlite3.Connection, request: Request) -> dict[str, str] | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token or len(token) > 256:
        return None
    row = conn.execute(
        "SELECT s.token_hash, s.expires_at, u.id, u.login FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
        (_token_hash(token),),
    ).fetchone()
    if row is None:
        return None
    token_hash, expires_at, user_id, login = row
    try:
        expired = datetime.fromisoformat(expires_at) <= _utc_now()
    except ValueError:
        expired = True
    if expired:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
        conn.commit()
        return None
    return {"id": user_id, "login": login}

def require_user(conn: sqlite3.Connection, request: Request) -> dict[str, str]:
    user = session_user(conn, request)
    if user is None:
        _raise_api_error(401)
    return user

def onboarding_state(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    """Current onboarding progress; a user with no row is 'pending'."""
    row = conn.execute(
        "SELECT status, step, interest, started_at, updated_at, completed_at "
        "FROM onboarding WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    if row is None:
        return {
            "status": "pending", "step": None, "interest": None,
            "started_at": None, "updated_at": None, "completed_at": None,
        }
    return dict(zip(
        ("status", "step", "interest", "started_at", "updated_at", "completed_at"), row
    ))


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

def load_guides() -> list[Guide]:
    """Fail closed: only draft/verified cards from data/guides.json."""
    result = []
    for raw in load_collection(GUIDES_FILE, None, Guide)["items"]:
        try:
            guide = Guide.model_validate(raw)
        except ValidationError:
            continue
        if guide.status in {"draft", "verified"}:
            result.append(guide)
    return result

# Retained as an import-compatible snapshot; requests read current files.
PLACES = load_places()

_DEFAULT_ERRORS = {
    400: ("BAD_REQUEST", "Неверный запрос"), 401: ("UNAUTHORIZED", "Требуется вход"),
    404: ("NOT_FOUND", "Ресурс не найден"), 405: ("METHOD_NOT_ALLOWED", "Метод не поддерживается"),
    409: ("CONFLICT", "Логин уже занят"), 413: ("PAYLOAD_TOO_LARGE", "Запрос слишком большой"),
    414: ("URI_TOO_LONG", "Строка запроса слишком длинная"), 415: ("UNSUPPORTED_MEDIA_TYPE", "Ожидается JSON"),
    422: ("VALIDATION_ERROR", "Неверные параметры запроса"), 429: ("RATE_LIMITED", "Слишком много запросов; попробуйте позже"),
    500: ("INTERNAL_ERROR", "Внутренняя ошибка сервера"), 503: ("UNAVAILABLE", "Данные временно недоступны"),
}

def _error_response(status_code, code=None, message=None):
    default_code, default_message = _DEFAULT_ERRORS.get(status_code, ("ERROR", "Ошибка"))
    headers = dict(SECURITY_HEADERS)
    if status_code == 429:
        headers["Retry-After"] = "60"
    return JSONResponse(status_code=status_code, content={"error": {"code": code or default_code, "message": message or default_message}}, headers=headers)

def _raise_api_error(status_code, code=None, message=None):
    default_code, default_message = _DEFAULT_ERRORS[status_code]
    raise HTTPException(status_code, detail={"code": code or default_code, "message": message or default_message})

class PostLimiter:
    """Single-process demo limit. Salted opaque keys, no persistent IP log."""
    def __init__(self, limit: int = 30):
        self.salt = secrets.token_bytes(32)
        self.events: dict[str, deque] = {}
        self.limit = limit

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
# Register/login: 10 attempts per minute per IP and, separately, per login.
AUTH_IP_LIMITER = PostLimiter(limit=10)
AUTH_LOGIN_LIMITER = PostLimiter(limit=10)
AUTH_BODY_PATHS = {"/api/v1/auth/register", "/api/v1/auth/login"}

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
        method = scope["method"]
        last_segment = path.rsplit("/", 1)[-1]
        is_answer = method == "POST" and path.startswith("/api/v1/quest/") and last_segment in {"answer", "complete"}
        is_auth = method == "POST" and path in AUTH_BODY_PATHS
        # DELETE is limited together with POST so flipping a mark on and off
        # does not become a free write loop.
        is_social = method in {"POST", "DELETE"} and path.startswith("/api/v1/places/") and last_segment in {"visit", "like"}
        if is_answer or is_auth or is_social:
            host = (scope.get("client") or ("unknown", 0))[0]
            limiter = AUTH_IP_LIMITER if is_auth else POST_LIMITER
            if not limiter.allow(host):
                return await _error_response(429)(scope, receive, send_safe)
        if is_answer or is_auth:
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

@asynccontextmanager
async def _lifespan(app: FastAPI):
    # Idempotent schema creation at startup; connections re-ensure it anyway,
    # so a database that appears later still works without a restart.
    try:
        open_db().close()
    except sqlite3.Error:
        logger.warning("Demo database unavailable at startup; social endpoints degrade")
    yield

app = FastAPI(title="Svoi Vladik API", version="0.3.0", lifespan=_lifespan)
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

def _social_snapshot(request: Request) -> tuple[dict[str, int], dict[str, int], set[str], set[str]]:
    """Visit/like counters plus the current user's marks; zeros when the DB is down."""
    try:
        with closing(open_db()) as conn:
            user = session_user(conn, request)
            visit_counts = dict(conn.execute("SELECT place_id, COUNT(*) FROM visits GROUP BY place_id").fetchall())
            like_counts = dict(conn.execute("SELECT place_id, COUNT(*) FROM likes GROUP BY place_id").fetchall())
            my_visits = {r[0] for r in conn.execute("SELECT place_id FROM visits WHERE user_id = ?", (user["id"],))} if user else set()
            my_likes = {r[0] for r in conn.execute("SELECT place_id FROM likes WHERE user_id = ?", (user["id"],))} if user else set()
    except sqlite3.Error:
        return {}, {}, set(), set()
    return visit_counts, like_counts, my_visits, my_likes

def _with_social(place: dict, snapshot) -> dict:
    visit_counts, like_counts, my_visits, my_likes = snapshot
    place["visits"] = visit_counts.get(place["id"], 0)
    place["likes"] = like_counts.get(place["id"], 0)
    place["visited_by_me"] = place["id"] in my_visits
    place["liked_by_me"] = place["id"] in my_likes
    return place

@app.get("/api/v1/places")
async def get_places(request: Request, category: Category | None = None, max_price_rub: Annotated[int | None, Query(ge=0, le=100000)] = None):
    params = list(request.query_params.multi_items())
    if any(k not in {"category", "max_price_rub"} for k, _ in params) or len({k for k, _ in params}) != len(params):
        _raise_api_error(422)
    snapshot = _social_snapshot(request)
    places = [_with_social(p.model_dump(), snapshot) for p in load_places() if (category is None or p.category == category) and (max_price_rub is None or p.price_rub is not None and p.price_rub <= max_price_rub)]
    return {"items": places, "total": len(places)}

@app.get("/api/v1/places/{place_id}")
async def get_place(request: Request, place_id: Annotated[str, ApiPath(pattern=ID_PATTERN, min_length=1, max_length=64)]):
    for p in load_places():
        if p.id == place_id:
            return _with_social(p.model_dump(), _social_snapshot(request))
    _raise_api_error(404, message="Место не найдено")

@app.get("/api/v1/guides")
async def get_guides(request: Request, need: Need | None = None):
    """Practical cards by need; no map coordinates, no booking."""
    params = list(request.query_params.multi_items())
    if any(k != "need" for k, _ in params) or len({k for k, _ in params}) != len(params):
        _raise_api_error(422)
    guides = [
        guide.model_dump()
        for guide in load_guides()
        if need is None or guide.need == need
    ]
    return {"items": guides, "total": len(guides)}

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
        return {"completed": False}
    return {"completed": True}

# --- Demo auth, visits, likes, profile and leaderboard ----------------------

PlaceIdPath = Annotated[str, ApiPath(pattern=ID_PATTERN, min_length=1, max_length=64)]

def _place_or_404(place_id: str) -> None:
    if all(p.id != place_id for p in load_places()):
        _raise_api_error(404, message="Место не найдено")

@app.post("/api/v1/auth/register", status_code=201)
async def register(credentials: Credentials, response: Response):
    if not AUTH_LOGIN_LIMITER.allow(credentials.login):
        _raise_api_error(429)
    user_id = secrets.token_hex(16)
    password_hash = hash_password(credentials.password)
    conn = _db_or_503()
    try:
        try:
            conn.execute(
                "INSERT INTO users(id, login, password_hash, created_at) VALUES (?, ?, ?, ?)",
                (user_id, credentials.login, password_hash, _iso(_utc_now())),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            _raise_api_error(409)
        token = create_session(conn, user_id)
    except sqlite3.Error:
        _raise_api_error(503, message="База данных временно недоступна")
    finally:
        conn.close()
    set_session_cookie(response, token)
    return {"user": {"id": user_id, "login": credentials.login}}

@app.post("/api/v1/auth/login")
async def login(credentials: Credentials, response: Response):
    if not AUTH_LOGIN_LIMITER.allow(credentials.login):
        _raise_api_error(429)
    conn = _db_or_503()
    try:
        try:
            row = conn.execute("SELECT id, login, password_hash FROM users WHERE login = ?", (credentials.login,)).fetchone()
            # Same scrypt cost for unknown logins: the reply does not say which part failed.
            valid = verify_password(credentials.password, row[2] if row else _DUMMY_HASH)
            if row is None or not valid:
                _raise_api_error(401, message="Неверный логин или пароль")
            token = create_session(conn, row[0])
        except sqlite3.Error:
            _raise_api_error(503, message="База данных временно недоступна")
    finally:
        conn.close()
    set_session_cookie(response, token)
    return {"user": {"id": row[0], "login": row[1]}}

@app.post("/api/v1/auth/logout", status_code=204)
async def logout(request: Request):
    response = Response(status_code=204)
    token = request.cookies.get(SESSION_COOKIE)
    if token and len(token) <= 256:
        try:
            with closing(open_db()) as conn:
                conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))
                conn.commit()
        except sqlite3.Error:
            logger.warning("Logout could not reach the database; cookie is cleared anyway")
    clear_session_cookie(response)
    return response

@app.get("/api/v1/me")
async def me(request: Request):
    conn = _db_or_503()
    try:
        try:
            user = require_user(conn, request)
            onboarding = onboarding_state(conn, user["id"])
        except sqlite3.Error:
            _raise_api_error(503, message="База данных временно недоступна")
    finally:
        conn.close()
    return {"user": user, "onboarding": onboarding}

@app.get("/api/v1/me/profile")
async def my_profile(request: Request):
    conn = _db_or_503()
    try:
        try:
            user = require_user(conn, request)
            visited = [r[0] for r in conn.execute("SELECT place_id FROM visits WHERE user_id = ? ORDER BY created_at, place_id", (user["id"],))]
            liked = [r[0] for r in conn.execute("SELECT place_id FROM likes WHERE user_id = ? ORDER BY created_at, place_id", (user["id"],))]
        except sqlite3.Error:
            _raise_api_error(503, message="База данных временно недоступна")
    finally:
        conn.close()
    return {"user": user, "stats": {"visits": len(visited), "likes": len(liked)}, "visited_place_ids": visited, "liked_place_ids": liked}

@app.get("/api/v1/me/onboarding")
async def get_onboarding(request: Request):
    conn = _db_or_503()
    try:
        try:
            user = require_user(conn, request)
            return onboarding_state(conn, user["id"])
        except sqlite3.Error:
            _raise_api_error(503, message="База данных временно недоступна")
    finally:
        conn.close()

@app.put("/api/v1/me/onboarding")
async def update_onboarding(body: OnboardingUpdate, request: Request):
    """Partial update of guided-onboarding progress for the current user."""
    conn = _db_or_503()
    try:
        try:
            user = require_user(conn, request)
            state = onboarding_state(conn, user["id"])
            now = _iso(_utc_now())
            status = body.status or state["status"]
            step = body.step if body.step is not None else state["step"]
            interest = body.interest if body.interest is not None else state["interest"]
            started_at = state["started_at"] or (now if status != "pending" else None)
            completed_at = state["completed_at"]
            if status == "completed":
                completed_at = completed_at or now
            elif status in {"pending", "in_progress"}:
                completed_at = None
            conn.execute(
                "INSERT INTO onboarding(user_id, status, step, interest, started_at, updated_at, completed_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, step=excluded.step, "
                "interest=excluded.interest, started_at=excluded.started_at, "
                "updated_at=excluded.updated_at, completed_at=excluded.completed_at",
                (user["id"], status, step, interest, started_at, now, completed_at),
            )
            conn.commit()
            return onboarding_state(conn, user["id"])
        except sqlite3.Error:
            _raise_api_error(503, message="База данных временно недоступна")
    finally:
        conn.close()

def _toggle_mark(request: Request, place_id: str, table: str, add: bool) -> int:
    """Idempotent set/unset of a (user, place) mark; returns the place counter."""
    if table not in {"visits", "likes"}:  # internal names only, never user input
        raise ValueError(table)
    conn = _db_or_503()
    try:
        try:
            user = require_user(conn, request)
            _place_or_404(place_id)
            if add:
                conn.execute(f"INSERT OR IGNORE INTO {table}(user_id, place_id, created_at) VALUES (?, ?, ?)", (user["id"], place_id, _iso(_utc_now())))
            else:
                conn.execute(f"DELETE FROM {table} WHERE user_id = ? AND place_id = ?", (user["id"], place_id))
            conn.commit()
            return conn.execute(f"SELECT COUNT(*) FROM {table} WHERE place_id = ?", (place_id,)).fetchone()[0]
        except sqlite3.Error:
            _raise_api_error(503, message="База данных временно недоступна")
    finally:
        conn.close()

@app.post("/api/v1/places/{place_id}/visit")
async def add_visit(request: Request, place_id: PlaceIdPath):
    return {"visited": True, "visits": _toggle_mark(request, place_id, "visits", True)}

@app.delete("/api/v1/places/{place_id}/visit")
async def remove_visit(request: Request, place_id: PlaceIdPath):
    return {"visited": False, "visits": _toggle_mark(request, place_id, "visits", False)}

@app.post("/api/v1/places/{place_id}/like")
async def add_like(request: Request, place_id: PlaceIdPath):
    return {"liked": True, "likes": _toggle_mark(request, place_id, "likes", True)}

@app.delete("/api/v1/places/{place_id}/like")
async def remove_like(request: Request, place_id: PlaceIdPath):
    return {"liked": False, "likes": _toggle_mark(request, place_id, "likes", False)}

@app.get("/api/v1/leaderboard")
async def leaderboard(request: Request, limit: Annotated[int | None, Query(ge=1, le=20)] = None):
    params = list(request.query_params.multi_items())
    if any(k != "limit" for k, _ in params) or len({k for k, _ in params}) != len(params):
        _raise_api_error(422)
    size = 10 if limit is None else limit
    try:
        with closing(open_db()) as conn:
            rows = conn.execute(
                """
                SELECT u.login,
                       COUNT(v.place_id) AS visit_count,
                       (SELECT COUNT(*) FROM likes l WHERE l.user_id = u.id) AS like_count
                FROM users u
                JOIN visits v ON v.user_id = u.id
                GROUP BY u.id, u.login
                ORDER BY visit_count DESC, u.login ASC
                """
            ).fetchall()
    except sqlite3.Error:
        return {"items": [], "total": 0}
    # Likes are displayed but never affect ranking; only login/visits/likes leave the server.
    items = [{"login": login, "visits": visit_count, "likes": like_count} for login, visit_count, like_count in rows[:size]]
    return {"items": items, "total": len(rows)}

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
# Place photos live in the repo (not gitignored); served read-only at /media.
if MEDIA_DIR.is_dir():
    app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")
# Licensed place photo pack lives at repo-root assets/places (manifest + jpgs);
# mount it explicitly so it is served alongside the frontend's own /assets.
if PLACE_PHOTOS_DIR.is_dir():
    app.mount("/assets/places", StaticFiles(directory=PLACE_PHOTOS_DIR), name="place-photos")
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
