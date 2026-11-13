"""Validate and import editorial data from U3 into data/.

Usage:
    python scripts/import_data.py routes path/to/routes.json
    python scripts/import_data.py quests path/to/quests.json

The script:
  1. Reads the given JSON file.
  2. Validates each item against the Pydantic models defined in backend/main.py
     (Route, Quest). Invalid items are reported; the whole file is rejected if
     any item fails.
  3. On success, writes the normalised payload to data/routes.json or
     data/quests.json. The API picks those files up automatically and stops
     serving the mocks from data/examples/.

Exit codes:
  0 — imported successfully.
  1 — file missing / unreadable.
  2 — file is not valid JSON or has wrong top-level shape.
  3 — one or more items failed Pydantic validation.
  4 — unknown kind argument.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))

from pydantic import BaseModel, ValidationError  # noqa: E402

from main import Route, Quest  # noqa: E402

TARGETS: dict[str, tuple[type[BaseModel], Path]] = {
    "routes": (Route, REPO_ROOT / "data" / "routes.json"),
    "quests": (Quest, REPO_ROOT / "data" / "quests.json"),
}


def die(code: int, message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(code)


def main(argv: list[str]) -> None:
    if len(argv) != 3:
        die(4, "Usage: python scripts/import_data.py <routes|quests> <path/to/file.json>")

    kind, raw_path = argv[1], argv[2]
    if kind not in TARGETS:
        die(4, f"Unknown kind {kind!r}. Expected one of: {', '.join(TARGETS)}.")

    model, target = TARGETS[kind]
    src = Path(raw_path)
    if not src.is_file():
        die(1, f"Source file not found: {src}")

    try:
        text = src.read_text(encoding="utf-8")
    except OSError as exc:
        die(1, f"Cannot read {src}: {exc}")

    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        die(2, f"Invalid JSON in {src}: {exc}")

    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        die(2, "Top-level shape must be {\"items\": [...], \"total\": N}.")

    validated: list[dict] = []
    errors: list[str] = []
    for index, raw in enumerate(payload["items"]):
        try:
            validated.append(model(**raw).model_dump())
        except (TypeError, ValidationError) as exc:
            errors.append(f"  item[{index}]: {exc}")

    if errors:
        die(3, f"Validation failed for {len(errors)} item(s):\n" + "\n".join(errors))

    target.parent.mkdir(parents=True, exist_ok=True)
    normalised = {"items": validated, "total": len(validated)}
    target.write_text(
        json.dumps(normalised, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Imported {len(validated)} {kind} item(s) into {target.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main(sys.argv)
