"""Authenticated proxies for Open-Meteo and NASA POWER.

These endpoints simply forward an allow-listed set of query parameters to
the upstream API and return its JSON response. They exist so the frontend
can require a valid Bearer token before any data is fetched — the
upstream APIs themselves are public/CORS-friendly but we want the token
gate to apply uniformly across all three sources.
"""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request

from . import auth

router = APIRouter(tags=["proxies"])

HTTP_TIMEOUT = 30.0

# Open-Meteo upstream endpoints we proxy (path -> upstream URL).
_OPENMETEO_ROUTES = {
    "geocoding":   "https://geocoding-api.open-meteo.com/v1/search",
    "forecast":    "https://api.open-meteo.com/v1/forecast",
    "archive":     "https://archive-api.open-meteo.com/v1/archive",
}

_POWER_DAILY_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"


async def _proxy_get(url: str, params: list[tuple[str, str]]) -> Any:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True) as client:
        try:
            resp = await client.get(url, params=params)
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=502, detail=f"Upstream request failed: {exc}"
            ) from exc
    if resp.status_code != 200:
        # Surface upstream payload to help debugging.
        try:
            body = resp.json()
        except ValueError:
            body = resp.text
        raise HTTPException(
            status_code=resp.status_code if 400 <= resp.status_code < 500 else 502,
            detail={"upstream": url, "status": resp.status_code, "body": body},
        )
    try:
        return resp.json()
    except ValueError:
        return resp.text


@router.get("/api/openmeteo/{kind}", dependencies=[auth.RequireToken])
async def openmeteo_proxy(kind: str, request: Request) -> Any:
    if kind not in _OPENMETEO_ROUTES:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown Open-Meteo endpoint '{kind}'. "
            f"Allowed: {sorted(_OPENMETEO_ROUTES)}",
        )
    # Forward all query params verbatim. Open-Meteo accepts comma-joined
    # lists in `daily` / `hourly`, which `request.query_params` preserves.
    params = list(request.query_params.multi_items())
    return await _proxy_get(_OPENMETEO_ROUTES[kind], params)


@router.get("/api/power/daily/point", dependencies=[auth.RequireToken])
async def power_proxy(request: Request) -> Any:
    params = list(request.query_params.multi_items())
    return await _proxy_get(_POWER_DAILY_URL, params)
