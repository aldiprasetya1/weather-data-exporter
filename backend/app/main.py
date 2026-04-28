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

app = FastAPI(
    title="Weather Data Exporter — Meteostat proxy",
    description=(
        "Read-only proxy for Meteostat bulk hourly data, scoped to "
        "Indonesian weather stations."
    ),
    version="0.1.0",
)

# Permissive CORS: this is a public read-only proxy so the frontend can be
# hosted on any origin (devinapps.com, github.io, localhost, etc.).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
    max_age=86400,
)

STATIONS_FILE = Path(__file__).parent / "stations_id.json"
with STATIONS_FILE.open(encoding="utf-8") as fh:
    STATIONS: list[dict] = json.load(fh)
STATIONS_BY_ID = {s["id"]: s for s in STATIONS}

METEOSTAT_BULK_BASE = "https://bulk.meteostat.net/v2/hourly"
HTTP_TIMEOUT = 30.0
MAX_RANGE_DAYS = 366  # one year max per request

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


@app.get("/stations")
def list_stations() -> JSONResponse:
    """Return all Indonesian Meteostat stations with hourly data."""
    return JSONResponse({"count": len(STATIONS), "stations": STATIONS})


@app.get("/hourly/{station_id}")
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

    rows.sort(key=lambda r: (r["date"], r["hour"]))

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
