# Testing Weather Data Exporter

Static site (HTML + CSS + Vanilla JS) that fetches weather data from Open-Meteo API and exports to Excel. No backend, no API key required.

## Local Setup

```bash
cd /home/ubuntu/repos/weather-data-exporter
python3 -m http.server 8000
```

Then open `http://localhost:8000` in Chrome.

## Deployments

- **DevinApps**: Deploy using the `deploy` tool with `command="frontend"` and `dir` pointing to the repo root
- **Vercel**: Auto-deploys on push to any branch. Vercel preview URLs may return 401 if Vercel Authentication is enabled — use DevinApps URL for testing instead
- Vercel config: `vercel.json` with `buildCommand: null`, `outputDirectory: "."`, `framework: null`

## Key Testing Flows

### 1. City Search & Selection
- Type a city name (e.g., "Jakarta") in the search input
- Wait for autocomplete dropdown (debounced, needs 2+ characters)
- Click a suggestion to select it
- Confirmation text should show city name, coordinates, and timezone

### 2. Windrose Visualization
- Select a city first (required — otherwise shows validation error)
- Set date range (default is last 7 days)
- Click "Tampilkan Windrose" button
- Two canvas charts should render: "Blowing From" and "Blowing To"
- "Blowing To" should be 180° rotation of "Blowing From"
- Legend shows 5 speed bins: 0–5, 5–10, 10–15, 15–20, 20+ km/h
- Info text shows city, period, and observation count
- For 7 days of hourly data, expect ~168 observations (may vary slightly due to archive/forecast boundary)

### 3. Data Preview
- Click "Pratinjau Data" button
- Table appears with up to 50 rows
- Columns match selected weather variable checkboxes
- Info text shows total row count, granularity, and data source

### 4. Excel Download
- Click "Unduh Excel (.xlsx)" button
- Browser triggers .xlsx file download
- File contains 2 sheets: Data + Info (metadata)
- File naming: `weather_{city}_{start}_to_{end}_{granularity}.xlsx`

### 5. Validation Errors
- No city selected → "Pilih kota dulu dari saran pencarian."
- No dates → "Isi tanggal mulai dan akhir."
- Start > End → "Tanggal mulai harus lebih awal dari tanggal akhir."

## API Details

- Geocoding: `https://geocoding-api.open-meteo.com/v1/search`
- Forecast: `https://api.open-meteo.com/v1/forecast`
- Archive (ERA5): `https://archive-api.open-meteo.com/v1/archive`
- Archive covers 1940 to ~5 days ago, forecast covers up to 16 days ahead
- App automatically splits date ranges spanning both archive and forecast
- Windrose always uses hourly data regardless of granularity setting

## Devin Secrets Needed

None — Open-Meteo API is free and requires no API key.
