"""Probe entrypoint — debug Vercel bundle layout."""
from __future__ import annotations
import os, sys
from pathlib import Path
import json

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
_BACKEND = _ROOT / "backend"

# Try import
import_err = None
try:
    sys.path.insert(0, str(_BACKEND))
    from app.main import app as fastapi_app  # type: ignore
except Exception as exc:  # noqa: BLE001
    import_err = repr(exc)

# Build a probe response (any URL hits this)
from fastapi import FastAPI

probe = FastAPI()

@probe.get("/{path:path}")
def any_get(path: str):
    return {
        "ok": True,
        "url_path": path,
        "here": str(_HERE),
        "root": str(_ROOT),
        "backend_exists": _BACKEND.exists(),
        "backend_listing": sorted([p.name for p in _BACKEND.glob("**/*") if p.is_file()]) if _BACKEND.exists() else None,
        "import_err": import_err,
        "imported_app": import_err is None,
        "env_TURSO_URL_present": bool(os.environ.get("TURSO_DATABASE_URL")),
        "env_TURSO_AUTH_present": bool(os.environ.get("TURSO_AUTH_TOKEN")),
        "env_ADMIN_SECRET_present": bool(os.environ.get("ADMIN_SECRET")),
    }

# Try to use the real app if import succeeded; else use probe
app = fastapi_app if import_err is None else probe
