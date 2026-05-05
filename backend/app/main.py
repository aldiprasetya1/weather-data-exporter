"""Backend proxy for Meteostat bulk endpoints.

Meteostat publishes free, no-auth, gzipped CSV files for hourly station
observations at https://bulk.meteostat.net/v2/hourly/{year}/{station}.csv.gz
but does not enable CORS, so a static browser app cannot read them
directly. This service:

1. Serves the curated list of Indonesian stations as JSON.
2. Proxies hourly observation requests, decompresses the gzipped CSV,
   filters by date range, and returns a JSON payload friendly to the
   frontend (parallel arrays per variable).
"""

from __future__ import annotations

import csv
import gzip
import io
import json
from datetime import date, datetime, timedelta
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import auth
from .admin import router as admin_router
from .proxies import router as proxies_router

app = FastAPI(
    title="Weather Data Exporter — authenticated proxy",
    description=(
        "Authenticated proxy for Meteostat / Open-Meteo / NASA POWER. "
        "All data endpoints require a Bearer token issued by the admin."
    ),
    version="0.2.0",
)

# Permissive CORS so the frontend (devinapps.com, github.io, localhost,
# ...) can authenticate via the Authorization header. Credentials are
# not used; auth is sent explicitly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    max_age=86400,
)


@app.on_event("startup")
def _on_startup() -> None:
    auth.init_db()
    # Ensure an admin secret exists on first boot so `fly logs` can show it.
    auth._read_admin_secret()


app.include_router(admin_router)
app.include_router(proxies_router)

STATIONS_FILE = Path(__file__).parent / "stations_id.json"
with STATIONS_FILE.open(encoding="utf-8") as fh:
    STATIONS: list[dict] = json.load(fh)
STATIONS_BY_ID = {s["id"]: s for s in STATIONS}

METEOSTAT_BULK_BASE = "https://bulk.meteostat.net/v2/hourly"
METEOSTAT_DAILY_BASE = "https://bulk.meteostat.net/v2/daily"
OPENMETEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
OPENMETEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
HTTP_TIMEOUT = 30.0
MAX_RANGE_DAYS = 366  # one year max per request

# Meteostat daily CSV columns. See https://dev.meteostat.net/bulk/daily.html
METEOSTAT_DAILY_COLS = [
    "date",   # YYYY-MM-DD (UTC)
    "tavg",   # daily mean temperature, °C
    "tmin",   # daily minimum, °C
    "tmax",   # daily maximum, °C
    "prcp",   # daily precipitation, mm
    "snow",   # snow depth, mm
    "wdir",   # daily mean wind direction, °
    "wspd",   # daily mean wind speed, km/h
    "wpgt",   # peak wind gust, km/h
    "pres",   # mean sea-level pressure, hPa
    "tsun",   # daily sunshine total, minutes
]
DAILY_NUMERIC_COLS = {
    "tavg", "tmin", "tmax", "prcp", "snow",
    "wdir", "wspd", "wpgt", "pres", "tsun",
}
# Bulk daily wind speeds are in km/h. We expose them as m/s for consistency
# across the three data sources used by the frontend.
DAILY_WIND_KMH_TO_MS_COLS = {"wspd", "wpgt"}

# Meteostat hourly CSV columns, in order (no header in the file).
# See https://dev.meteostat.net/bulk/hourly.html#endpoints
METEOSTAT_HOURLY_COLS = [
    "date",   # YYYY-MM-DD (UTC)
    "hour",   # 0..23 (UTC)
    "temp",   # air temperature, °C
    "dwpt",   # dew point, °C
    "rhum",   # relative humidity, %
    "prcp",   # one-hour precipitation, mm
    "snow",   # snow depth, mm
    "wdir",   # wind direction, ° (from)
    "wspd",   # wind speed, km/h
    "wpgt",   # peak wind gust, km/h
    "pres",   # sea-level air pressure, hPa
    "tsun",   # one-hour sunshine total, minutes
    "coco",   # weather condition code, 1..27
]
NUMERIC_COLS = {
    "temp", "dwpt", "rhum", "prcp", "snow", "wdir",
    "wspd", "wpgt", "pres", "tsun", "coco",
}


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/login")
def login(payload: dict) -> dict:
    """Verify a Bearer token and return its public profile.

    Body: ``{"token": "wde_..."}``
    """
    token = (payload.get("token") or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="`token` is required")
    rec = auth.get_token(token)
    if rec is None or rec.revoked or rec.is_expired():
        raise HTTPException(
            status_code=401, detail="Invalid or expired token"
        )
    return rec.to_public()


@app.get("/stations", dependencies=[auth.RequireToken])
def list_stations() -> JSONResponse:
    """Return all Indonesian Meteostat stations with hourly data."""
    return JSONResponse({"count": len(STATIONS), "stations": STATIONS})


@app.get("/hourly/{station_id}", dependencies=[auth.RequireToken])
async def hourly(
    station_id: str,
    start: str = Query(..., description="ISO date YYYY-MM-DD (UTC)"),
    end: str = Query(..., description="ISO date YYYY-MM-DD (UTC)"),
) -> dict:
    """Return hourly observations for `station_id` between `start` and `end`.

    Response shape:
    {
        "station": {...metadata...},
        "columns": ["time", "temp", "rhum", ...],
        "rows": [[...], [...], ...],   # one row per hour, time as ISO 'YYYY-MM-DDTHH:00'
        "count": <int>,
    }
    """
    if station_id not in STATIONS_BY_ID:
        raise HTTPException(status_code=404, detail=f"Unknown station '{station_id}'")
    station = STATIONS_BY_ID[station_id]

    try:
        start_d = date.fromisoformat(start)
        end_d = date.fromisoformat(end)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid date: {exc}") from exc
    if start_d > end_d:
        raise HTTPException(status_code=400, detail="`start` must be on or before `end`")
    if (end_d - start_d).days > MAX_RANGE_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"Range too large; max {MAX_RANGE_DAYS} days per request",
        )

    years = list(range(start_d.year, end_d.year + 1))
    rows: list[list] = []

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        for year in years:
            year_rows = await _fetch_year(client, station_id, year)
            for r in year_rows:
                # r["date"] is "YYYY-MM-DD" string
                if start <= r["date"] <= end:
                    rows.append(r)

    rows.sort(key=lambda r: (r["date"], int(r["hour"]) if r["hour"] is not None else -1))

    out_cols = ["time"] + [c for c in METEOSTAT_HOURLY_COLS if c not in {"date", "hour"}]
    out_rows = []
    for r in rows:
        time_str = f"{r['date']}T{int(r['hour']):02d}:00"
        out_rows.append(
            [time_str] + [r.get(c) for c in METEOSTAT_HOURLY_COLS if c not in {"date", "hour"}]
        )

    return {
        "station": station,
        "columns": out_cols,
        "rows": out_rows,
        "count": len(out_rows),
        "range": {"start": start, "end": end},
    }


@app.get("/daily/{station_id}", dependencies=[auth.RequireToken])
async def daily(
    station_id: str,
    start: str = Query(..., description="ISO date YYYY-MM-DD (UTC)"),
    end: str = Query(..., description="ISO date YYYY-MM-DD (UTC)"),
) -> dict:
    """Return daily observations for `station_id` between `start` and `end`.

    Wind speeds (`wspd`, `wpgt`) are converted from km/h to m/s before being
    returned, so the response uses m/s for consistency with the other data
    sources used by the frontend.
    """
    if station_id not in STATIONS_BY_ID:
        raise HTTPException(status_code=404, detail=f"Unknown station '{station_id}'")
    station = STATIONS_BY_ID[station_id]

    try:
        start_d = date.fromisoformat(start)
        end_d = date.fromisoformat(end)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid date: {exc}") from exc
    if start_d > end_d:
        raise HTTPException(status_code=400, detail="`start` must be on or before `end`")
    if (end_d - start_d).days > MAX_RANGE_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"Range too large; max {MAX_RANGE_DAYS} days per request",
        )

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        rows = await _fetch_daily(client, station_id)

        rows = [r for r in rows if start <= r["date"] <= end]
        rows.sort(key=lambda r: r["date"])

        # Meteostat's `tsun` field is frequently null for Indonesian stations
        # because most BMKG stations don't report calibrated sunshine duration
        # via SYNOP. Backfill those gaps from Open-Meteo's ERA5-based
        # `sunshine_duration` for the station's coordinate, so users get the
        # same column populated regardless of source. The Info sheet exposes
        # which dates were backfilled so the substitution is transparent.
        missing_dates = sorted(
            r["date"] for r in rows if r.get("tsun") is None
        )
        backfill_dates: list[str] = []
        backfill_error: str | None = None
        if missing_dates:
            try:
                filled = await _fetch_sunshine_backfill(
                    client,
                    lat=station["latitude"],
                    lon=station["longitude"],
                    start=start_d,
                    end=end_d,
                )
            except Exception as exc:  # pragma: no cover - network is flaky
                filled = {}
                backfill_error = str(exc)
            for r in rows:
                if r.get("tsun") is None and r["date"] in filled:
                    seconds = filled[r["date"]]
                    if seconds is not None:
                        # Meteostat tsun is in minutes; convert seconds -> min.
                        r["tsun"] = round(seconds / 60.0, 2)
                        backfill_dates.append(r["date"])

    out_cols = ["time"] + [c for c in METEOSTAT_DAILY_COLS if c != "date"]
    out_rows = []
    for r in rows:
        row = [r["date"]]
        for c in METEOSTAT_DAILY_COLS:
            if c == "date":
                continue
            v = r.get(c)
            if v is not None and c in DAILY_WIND_KMH_TO_MS_COLS:
                v = round(v / 3.6, 2)
            row.append(v)
        out_rows.append(row)

    return {
        "station": station,
        "columns": out_cols,
        "rows": out_rows,
        "count": len(out_rows),
        "range": {"start": start, "end": end},
        "tsun_backfill": {
            "source": "open-meteo-era5",
            "dates": backfill_dates,
            "error": backfill_error,
        },
    }


async def _fetch_sunshine_backfill(
    client: httpx.AsyncClient,
    *,
    lat: float,
    lon: float,
    start: date,
    end: date,
) -> dict[str, float | None]:
    """Fetch daily Open-Meteo sunshine duration (seconds) for `lat`/`lon`.

    Splits the requested range into archive (past) and forecast segments
    based on ``today - 5 days`` to stay within the typical coverage of
    each Open-Meteo endpoint. Returns a mapping of ``YYYY-MM-DD`` to
    sunshine seconds (may be ``None`` for dates the upstream has no data
    for).
    """
    cutoff = date.today() - timedelta(days=5)
    segments: list[tuple[str, date, date]] = []
    if start <= cutoff:
        segments.append(
            (OPENMETEO_ARCHIVE_URL, start, min(end, cutoff))
        )
    if end > cutoff:
        segments.append(
            (OPENMETEO_FORECAST_URL, max(start, cutoff + timedelta(days=1)), end)
        )

    merged: dict[str, float | None] = {}
    for url, seg_start, seg_end in segments:
        if seg_start > seg_end:
            continue
        params = {
            "latitude": f"{lat}",
            "longitude": f"{lon}",
            "start_date": seg_start.isoformat(),
            "end_date": seg_end.isoformat(),
            "daily": "sunshine_duration",
            "timezone": "UTC",
        }
        resp = await client.get(url, params=params, follow_redirects=True)
        if resp.status_code != 200:
            raise RuntimeError(
                f"Open-Meteo upstream {resp.status_code} for {url}: "
                f"{resp.text[:200]}"
            )
        data = resp.json()
        daily = (data or {}).get("daily") or {}
        times = daily.get("time") or []
        values = daily.get("sunshine_duration") or []
        for d, v in zip(times, values):
            merged[d] = v
    return merged


async def _fetch_daily(client: httpx.AsyncClient, station_id: str) -> list[dict]:
    """Download and parse the per-station Meteostat daily CSV (all years)."""
    url = f"{METEOSTAT_DAILY_BASE}/{station_id}.csv.gz"
    resp = await client.get(url, follow_redirects=True)
    if resp.status_code == 404:
        return []
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Meteostat upstream error {resp.status_code} for {url}",
        )
    try:
        decompressed = gzip.decompress(resp.content)
    except OSError as exc:
        raise HTTPException(
            status_code=502, detail=f"Failed to decompress {url}: {exc}"
        ) from exc

    rows: list[dict] = []
    reader = csv.reader(io.StringIO(decompressed.decode("utf-8")))
    for raw in reader:
        if len(raw) < len(METEOSTAT_DAILY_COLS):
            continue
        item: dict = {}
        for i, col in enumerate(METEOSTAT_DAILY_COLS):
            v = raw[i]
            if v == "" or v is None:
                item[col] = None
            elif col in DAILY_NUMERIC_COLS:
                try:
                    item[col] = float(v)
                except ValueError:
                    item[col] = None
            else:
                item[col] = v
        rows.append(item)
    return rows


async def _fetch_year(client: httpx.AsyncClient, station_id: str, year: int) -> list[dict]:
    """Download and parse one Meteostat per-year CSV.gz file."""
    url = f"{METEOSTAT_BULK_BASE}/{year}/{station_id}.csv.gz"
    resp = await client.get(url, follow_redirects=True)
    if resp.status_code == 404:
        # Some stations have no data for some years; treat as empty.
        return []
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Meteostat upstream error {resp.status_code} for {url}",
        )

    try:
        decompressed = gzip.decompress(resp.content)
    except OSError as exc:
        raise HTTPException(
            status_code=502, detail=f"Failed to decompress {url}: {exc}"
        ) from exc

    rows: list[dict] = []
    reader = csv.reader(io.StringIO(decompressed.decode("utf-8")))
    for raw in reader:
        if len(raw) < len(METEOSTAT_HOURLY_COLS):
            continue
        item: dict = {}
        for i, col in enumerate(METEOSTAT_HOURLY_COLS):
            v = raw[i]
            if v == "" or v is None:
                item[col] = None
            elif col in NUMERIC_COLS:
                try:
                    item[col] = float(v)
                except ValueError:
                    item[col] = None
            else:
                item[col] = v
        rows.append(item)
    return rows
