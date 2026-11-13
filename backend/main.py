"""Svoi Vladik backend skeleton (SV-05).

Serves real data found in the repo: data/geo/leninsky-poi-candidates.geojson.
Walks/quest content is not in the repo yet (U3 delivers it later), so those
endpoints honestly return empty collections instead of invented data.
"""

import json
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

REPO_ROOT = Path(__file__).resolve().parent.parent
POI_FILE = REPO_ROOT / "data" / "geo" / "leninsky-poi-candidates.geojson"

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


def load_places() -> list[Place]:
    """Convert GeoJSON features to flat Place records (lng/lat -> lat/lng)."""
    raw = json.loads(POI_FILE.read_text(encoding="utf-8"))
    places = []
    for f in raw.get("features", []):
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
    return places


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


@app.get("/api/routes")
async def get_routes():
    # Walk content is not in the repo yet; honest empty list, no invented data.
    return {"items": [], "total": 0}


@app.get("/api/quest")
async def get_quest():
    # Quest content is not in the repo yet; honest empty list, no invented data.
    return {"items": [], "total": 0}


# --- Test endpoints for U1 (frontend edge cases) ---

@app.get("/api/test-empty")
async def test_empty():
    return []


@app.get("/api/test-error")
async def test_error():
    raise HTTPException(status_code=404, detail="Место не найдено")
