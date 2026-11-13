"""Svoi Vladik backend skeleton (SV-05).

Serves real data found in the repo: data/geo/leninsky-poi-candidates.geojson.
Walks/quest content is not in the repo yet (U3 delivers it later). Until real
files appear, the /api/routes and /api/quest endpoints fall back to editorial
mock fixtures in data/examples/ so the frontend can integrate end-to-end.
"""

import json
import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError

logger = logging.getLogger("svoi-vladik")

REPO_ROOT = Path(__file__).resolve().parent.parent
POI_FILE = REPO_ROOT / "data" / "geo" / "leninsky-poi-candidates.geojson"
FRONTEND_DIR = REPO_ROOT / "prototypes" / "leninsky-map"
DATA_DIR = REPO_ROOT / "data"

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


# --- Unified error format: {"error": {"code": ..., "message": ...}} ---

@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": str(exc.status_code), "message": exc.detail}},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"error": {"code": "422", "message": "Неверные параметры запроса"}},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc: Exception):
    logger.exception("Unhandled error on %s: %s", request.url.path, exc)
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "500", "message": "Внутренняя ошибка сервера"}},
    )


# --- Endpoints ---

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/api/places")
async def get_places():
    return {"items": [p.model_dump() for p in PLACES], "total": len(PLACES)}


@app.get("/api/places/{place_id}")
async def get_place(place_id: str):
    for p in PLACES:
        if p.id == place_id:
            return p.model_dump()
    raise HTTPException(status_code=404, detail="Место не найдено")


@app.get("/api/routes", response_model=dict[str, Any])
async def get_routes():
    """Return U3 routes if available, otherwise the editorial mock fixture."""
    return load_collection(ROUTES_FILE, ROUTES_MOCK_FILE, Route)


@app.get("/api/quest", response_model=dict[str, Any])
async def get_quest():
    """Return U3 quest if available, otherwise the editorial mock fixture."""
    return load_collection(QUESTS_FILE, QUESTS_MOCK_FILE, Quest)


# --- Test endpoints for U1 (frontend edge cases) ---

@app.get("/api/test-empty")
async def test_empty():
    return []


@app.get("/api/test-error")
async def test_error():
    raise HTTPException(status_code=404, detail="Место не найдено")


# --- Static files ---
# Frontend (prototypes/leninsky-map) reads GeoJSON via relative paths like
# "../../data/geo/*.geojson". Mount /data so those requests resolve, and mount
# the prototype itself at root so the whole app is served from one origin.
# Declared last so /api/* and /health are matched first.

if DATA_DIR.is_dir():
    app.mount("/data", StaticFiles(directory=DATA_DIR), name="data")

if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
