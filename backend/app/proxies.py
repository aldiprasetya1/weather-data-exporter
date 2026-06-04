"""Authenticated proxies for Open-Meteo and NASA POWER.

These endpoints simply forward an allow-listed set of query parameters to
the upstream API and return its JSON response. They exist so the frontend
can require a valid Bearer token before any data is fetched — the
upstream APIs themselves are public/CORS-friendly but we want the token
gate to apply uniformly across all three sources.
"""

from __future__ import annotations

import os
import re
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse

router = APIRouter(tags=["proxies"])

HTTP_TIMEOUT = 30.0

# Open-Meteo upstream endpoints we proxy (path -> upstream URL).
_OPENMETEO_ROUTES = {
    "geocoding":   "https://geocoding-api.open-meteo.com/v1/search",
    "forecast":    "https://api.open-meteo.com/v1/forecast",
    "archive":     "https://archive-api.open-meteo.com/v1/archive",
}

_POWER_DAILY_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
_NOAA_CDO_BASE = "https://www.ncei.noaa.gov/cdo-web/api/v2"
_NOAA_GHCND_BASE = "https://www.ncei.noaa.gov/pub/data/ghcn/daily"
_NOAA_GHCND_BULK_BASE = f"{_NOAA_GHCND_BASE}/all"
_NOAA_CDO_ROUTES = {
    "datasets",
    "datacategories",
    "datatypes",
    "locationcategories",
    "locations",
    "stations",
    "data",
}
_NOAA_CDO_TOKEN = os.environ.get("NOAA_CDO_TOKEN", "").strip()
_NOAA_GHCND_STATION_RE = re.compile(r"^[A-Z0-9_:-]{3,32}$")


async def _proxy_get(
    url: str,
    params: list[tuple[str, str]],
    headers: dict[str, str] | None = None,
) -> Any:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True) as client:
        try:
            resp = await client.get(url, params=params, headers=headers)
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


async def _proxy_text(url: str, params: list[tuple[str, str]] | None = None) -> str:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True) as client:
        try:
            resp = await client.get(url, params=params or [])
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=502, detail=f"Upstream request failed: {exc}"
            ) from exc
    if resp.status_code != 200:
        raise HTTPException(
            status_code=resp.status_code if 400 <= resp.status_code < 500 else 502,
            detail={"upstream": url, "status": resp.status_code, "body": resp.text[:500]},
        )
    return resp.text


@router.get("/api/openmeteo/{kind}")
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


@router.get("/api/power/daily/point")
async def power_proxy(request: Request) -> Any:
    params = list(request.query_params.multi_items())
    return await _proxy_get(_POWER_DAILY_URL, params)


@router.get("/api/noaa/cdo/{kind}")
async def noaa_cdo_proxy(kind: str, request: Request) -> Any:
    if kind not in _NOAA_CDO_ROUTES:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown NOAA CDO endpoint '{kind}'. "
            f"Allowed: {sorted(_NOAA_CDO_ROUTES)}",
        )
    if not _NOAA_CDO_TOKEN:
        raise HTTPException(
            status_code=500,
            detail=(
                "NOAA_CDO_TOKEN belum dikonfigurasi di environment backend. "
                "Tambahkan token NOAA CDO di Vercel Environment Variables."
            ),
        )
    params = list(request.query_params.multi_items())
    return await _proxy_get(
        f"{_NOAA_CDO_BASE}/{kind}",
        params,
        headers={"token": _NOAA_CDO_TOKEN},
    )


@router.get("/api/noaa/ghcnd/{station_id}.dly", response_class=PlainTextResponse)
async def noaa_ghcnd_daily_file(station_id: str) -> str:
    station = station_id.replace("GHCND:", "").upper()
    if not _NOAA_GHCND_STATION_RE.match(station):
        raise HTTPException(status_code=400, detail="Invalid NOAA station id")
    return await _proxy_text(f"{_NOAA_GHCND_BULK_BASE}/{station}.dly")


@router.get("/api/noaa/ghcnd-stations")
async def noaa_ghcnd_stations(request: Request) -> dict[str, Any]:
    try:
        lat = float(request.query_params.get("latitude", ""))
        lon = float(request.query_params.get("longitude", ""))
        radius = float(request.query_params.get("radius", "5"))
        limit = int(request.query_params.get("limit", "50"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid latitude/longitude/radius") from exc

    radius = max(0.1, min(radius, 15.0))
    limit = max(1, min(limit, 200))
    text = await _proxy_text(f"{_NOAA_GHCND_BASE}/ghcnd-stations.txt")
    stations: list[dict[str, Any]] = []
    min_lat = lat - radius
    max_lat = lat + radius
    min_lon = lon - radius
    max_lon = lon + radius
    for line in text.splitlines():
        if len(line) < 42:
            continue
        station_id = line[0:11].strip()
        try:
            s_lat = float(line[12:20].strip())
            s_lon = float(line[21:30].strip())
        except ValueError:
            continue
        if not (min_lat <= s_lat <= max_lat and min_lon <= s_lon <= max_lon):
            continue
        try:
            elev: float | str = float(line[31:37].strip())
        except ValueError:
            elev = ""
        stations.append(
            {
                "id": f"GHCND:{station_id}",
                "name": line[41:71].strip() or station_id,
                "latitude": s_lat,
                "longitude": s_lon,
                "elevation": elev,
                "mindate": "",
                "maxdate": "",
                "datacoverage": None,
            }
        )
    stations.sort(key=lambda s: (s["latitude"] - lat) ** 2 + (s["longitude"] - lon) ** 2)
    return {"count": len(stations), "results": stations[:limit], "source": "ghcnd-stations.txt"}
