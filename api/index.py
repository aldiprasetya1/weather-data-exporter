"""Vercel serverless entrypoint for the FastAPI backend.

The actual application code lives under ``backend/app``. This file just
adjusts ``sys.path`` so the package can be imported, then re-exports
``app`` so Vercel's Python runtime auto-detects it as an ASGI app.

We rely on a ``vercel.json`` rewrite block that funnels every backend
URL (e.g. ``/api/auth/login``, ``/healthz``, ``/stations``) to this
function while preserving the original request path, so FastAPI's
router matches without any prefix translation.
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from app.main import app  # noqa: E402,F401  (re-export for Vercel)
