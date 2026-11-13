"""Make `backend/` importable so tests can `from main import app`.

Needed because the suite is normally invoked from the repository root with
`pytest backend/tests`, but `main` lives in `backend/`, not on sys.path.
"""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
