"""Svoi Vladik backend skeleton (SV-05).

Serves real data found in the repo: data/geo/leninsky-poi-candidates.geojson.
Walks/quest content is not in the repo yet (U3 delivers it later). Until real
files appear, the /api/v1/walks and /api/v1/quest endpoints fall back to
editorial mock fixtures in data/examples/ so the frontend can integrate
end-to-end.
"""

import json
import logging
import re
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("svoi-vladik")

REPO_ROOT = Path(__file__).resolve().parent.parent
POI_FILE = REPO_ROOT / "data" / "geo" / "leninsky-poi-candidates.geojson"
BOUNDARY_FILE = REPO_ROOT / "data" / "geo" / "leninsky-boundary.geojson"
# New design frontend; the legacy prototypes/leninsky-map/ is kept in the repo
# but no longer mounted at /.
FRONTEND_DIR = REPO_ROOT / "frontend-design" / "dist"
# The frontend fetches its map data via relative paths like
# "data/leninsky-boundary.geojson". The two Leninsky GeoJSON files are served
# from data/geo/ (single source of truth) via explicit routes below; the rest
# of /data (e.g. map-style.json) is served from this frontend data folder.
DATA_DIR = REPO_ROOT / "frontend-design" / "dist" / "data"
GEO_JSON_MEDIA_TYPE = "application/geo+json"

# Stable place_id shape, matches docs/API.md.
PLACE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Real content from U3 (not in repo yet).
ROUTES_FILE = REPO_ROOT / "data" / "routes.json"
QUESTS_FILE = REPO_ROOT / "data" / "quests.json"

# Editorial mock fallbacks for frontend integration.
ROUTES_MOCK_FILE = REPO_ROOT / "data" / "examples" / "route_mock.json"
QUESTS_MOCK_FILE = REPO_ROOT / "data" / "examples" / "quest_mock.json"

app = FastAPI(title="Svoi Vladik API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # dev only; restrict before public stand (SECURITY.md)
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# --- Models matched to the real GeoJSON structure ---

class Coordinates(BaseModel):
    lat: float
    lng: float


class Place(BaseModel):
    id: str
    name: str
    category: str
    coordinates: Coordinates
    status: str
    price_rub: Optional[int] = None
    checked_at: Optional[str] = None
    source_url: Optional[str] = None
    verification_note: Optional[str] = None
    osm_tags: dict[str, Any] = {}


# --- Models for walks (routes) and quests, aligned with docs/API.md ---

class SourceRef(BaseModel):
    title: str
    url: str


class Route(BaseModel):
    id: str
    title: str
    description: str
    place_ids: list[str]
    estimated_minutes: int
    route_note: Optional[str] = None
    route_checked_at: Optional[str] = None
    quest_id: Optional[str] = None
    source_url: Optional[str] = None
    sources: list[SourceRef] = []
    checked_at: Optional[str] = None
    status: str


class QuestOption(BaseModel):
    id: str
    text: str


class QuestStop(BaseModel):
    id: str
    place_id: str
    title: str
    fact_text: str
    fiction_text: str
    question: str
    options: list[QuestOption]
    sources: list[SourceRef] = []
    checked_at: Optional[str] = None


class Quest(BaseModel):
    id: str
    title: str
    description: str
    estimated_minutes: int
    related_place_ids: list[str]
    stop_count: int
    source_url: Optional[str] = None
    sources: list[SourceRef] = []
    checked_at: Optional[str] = None
    status: str
    stops: list[QuestStop]


# --- Loaders ---

def _read_json_safely(path: Path) -> Optional[Any]:
    """Return parsed JSON or None if file is missing, empty or malformed."""
    try:
        text = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    except OSError as exc:
        logger.warning("Cannot read %s: %s", path, exc)
        return None
    if not text:
        logger.info("%s is empty; treating as no data", path)
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        logger.warning("Malformed JSON in %s: %s", path, exc)
        return None


def load_places() -> list[Place]:
    """Convert GeoJSON features to flat Place records (lng/lat -> lat/lng).

    Never raises: on missing/empty/invalid source returns an empty list.
    """
    raw = _read_json_safely(POI_FILE)
    if not isinstance(raw, dict):
        return []
    places: list[Place] = []
    for f in raw.get("features", []) or []:
        try:
            p = f["properties"]
            lng, lat = f["geometry"]["coordinates"]
            places.append(Place(
                id=f["id"],
                name=p["name"],
                category=p.get("category", "other"),
                coordinates=Coordinates(lat=lat, lng=lng),
                status=p.get("status", "draft"),
                price_rub=p.get("price_rub"),
                checked_at=p.get("checked_at"),
                source_url=p.get("osm_url"),
                verification_note=p.get("verification_note"),
                osm_tags=p.get("osm_tags", {}),
            ))
        except (KeyError, TypeError, ValueError, ValidationError) as exc:
            logger.warning("Skipping invalid POI feature: %s", exc)
    return places


def load_collection(real_path: Path, mock_path: Path, model: type[BaseModel]) -> dict[str, Any]:
    """Load items from the real file if present, otherwise from the mock fixture.

    Safe against missing, empty, malformed and schema-invalid files: on any
    problem returns {"items": [], "total": 0} rather than raising. Individual
    bad items are skipped; valid items still render.
    """
    data = _read_json_safely(real_path)
    if data is None:
        data = _read_json_safely(mock_path)
    if not isinstance(data, dict):
        return {"items": [], "total": 0}
    raw_items = data.get("items") or []
    if not isinstance(raw_items, list):
        return {"items": [], "total": 0}
    items: list[dict[str, Any]] = []
    for raw in raw_items:
        try:
            items.append(model(**raw).model_dump())
        except (TypeError, ValidationError) as exc:
            logger.warning("Dropping invalid %s item: %s", model.__name__, exc)
    return {"items": items, "total": len(items)}


PLACES = load_places()


# --- Unified error format: {"error": {"code": "<SYMBOLIC>", "message": "..."}} ---

# Default symbolic codes and messages per HTTP status; used when a handler does
# not provide its own.
_DEFAULT_ERRORS: dict[int, tuple[str, str]] = {
    400: ("BAD_REQUEST", "Неверный запрос"),
    404: ("NOT_FOUND", "Ресурс не найден"),
    405: ("METHOD_NOT_ALLOWED", "Метод не поддерживается"),
    415: ("UNSUPPORTED_MEDIA_TYPE", "Неподдерживаемый тип содержимого"),
    422: ("VALIDATION_ERROR", "Неверные параметры запроса"),
    500: ("INTERNAL_ERROR", "Внутренняя ошибка сервера"),
}


def _error_response(status_code: int, code: Optional[str] = None,
                    message: Optional[str] = None) -> JSONResponse:
    default_code, default_message = _DEFAULT_ERRORS.get(
        status_code, ("ERROR", "Ошибка")
    )
    return JSONResponse(
        status_code=status_code,
        content={"error": {
            "code": code or default_code,
            "message": message or default_message,
        }},
    )


def _raise_api_error(status_code: int, code: str, message: str) -> None:
    """Raise HTTPException carrying our symbolic code via `detail`."""
    raise HTTPException(status_code=status_code, detail={"code": code, "message": message})


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    # If a route raised HTTPException(detail={"code":..., "message":...}),
    # honour those symbolic values. Otherwise (e.g. Starlette's plain-string
    # "Not Found" / "Method Not Allowed") fall back to the localized default
    # from _DEFAULT_ERRORS by status, instead of leaking the English string.
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail and "message" in detail:
        return _error_response(exc.status_code, detail["code"], detail["message"])
    return _error_response(exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return _error_response(422)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s: %s", request.url.path, exc)
    # Do not leak exception text or traceback into the response.
    return _error_response(500)


# --- Endpoints ---

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/api/v1/places")
async def get_places():
    return {"items": [p.model_dump() for p in PLACES], "total": len(PLACES)}


@app.get("/api/v1/places/{place_id}")
async def get_place(place_id: str):
    # Validate shape first: malformed id -> 422 VALIDATION_ERROR.
    if not PLACE_ID_RE.match(place_id):
        _raise_api_error(422, "VALIDATION_ERROR", "Неверный формат place_id")
    for p in PLACES:
        if p.id == place_id:
            return p.model_dump()
    _raise_api_error(404, "NOT_FOUND", "Место не найдено")


@app.get("/api/v1/walks", response_model=dict[str, Any])
async def get_walks():
    """Return U3 walks if available, otherwise the editorial mock fixture."""
    return load_collection(ROUTES_FILE, ROUTES_MOCK_FILE, Route)


@app.get("/api/v1/quest", response_model=dict[str, Any])
async def get_quest():
    """Return U3 quest if available, otherwise the editorial mock fixture."""
    return load_collection(QUESTS_FILE, QUESTS_MOCK_FILE, Quest)


# --- Test endpoints for U1 (frontend edge cases) ---

@app.get("/api/v1/test-empty")
async def test_empty():
    return []


@app.get("/api/v1/test-error")
async def test_error():
    _raise_api_error(404, "NOT_FOUND", "Место не найдено")


# --- Map data: single source of truth in data/geo/ ---
# These explicit routes must precede the /data mount so the StaticFiles mount
# does not intercept them. Serving from data/geo/ keeps one source of truth:
# new places are added only to data/geo/leninsky-poi-candidates.geojson.

@app.get("/data/leninsky-boundary.geojson")
async def data_boundary():
    return FileResponse(BOUNDARY_FILE, media_type=GEO_JSON_MEDIA_TYPE)


@app.get("/data/leninsky-poi-candidates.geojson")
async def data_pois():
    return FileResponse(POI_FILE, media_type=GEO_JSON_MEDIA_TYPE)


# --- Static files ---
# Serve the new design frontend (frontend-design/dist) at "/" with html=True.
# The legacy prototype under prototypes/leninsky-map/ is kept in the repo but
# no longer mounted. Mount /data for the remaining frontend data files (e.g.
# map-style.json); the two Leninsky GeoJSON files above come from data/geo/.
# Mounts are declared last so /api/v1/*, /health, /docs, /openapi.json match
# first.

if DATA_DIR.is_dir():
    app.mount("/data", StaticFiles(directory=DATA_DIR), name="data")

if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
