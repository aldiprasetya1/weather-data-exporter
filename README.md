# Weather Data Exporter

Aplikasi web untuk mengambil data cuaca per kota / stasiun dari tiga sumber publik gratis ([Open-Meteo](https://open-meteo.com/), [Meteostat](https://meteostat.net/), [NASA POWER](https://power.larc.nasa.gov/)) dan mengekspornya ke Excel (`.xlsx`), termasuk diagram windrose.

## Fitur

- **Tiga sumber data (granularitas harian):**
  - **Open-Meteo (model global)** — kota mana saja di dunia, historis 1940 → sekarang + forecast 16 hari ke depan.
  - **Meteostat (stasiun observasi Indonesia)** — observasi harian dari ~129 stasiun ASOS/SYNOP di Indonesia (BMKG bandara: WIII Soekarno-Hatta, WARR Juanda, WADD Ngurah Rai, dll.).
  - **NASA POWER (model + radiasi surya)** — MERRA-2 reanalysis + CERES SYN1deg harian, lengkap dengan variabel radiasi: GHI / DNI / DHI / clearsky GHI / PAR (cocok untuk PV / pertanian).
- **Satuan kecepatan angin: m/s** di seluruh data (Excel + pratinjau) maupun windrose.
- Pencarian kota dengan autocomplete (Open-Meteo Geocoding, dipakai untuk Open-Meteo & POWER) atau pencarian stasiun (Meteostat).
- Pratinjau 50 baris pertama sebelum unduh.
- Output Excel `.xlsx` berisi 2 sheet: **Data** + **Info** (metadata: kota/stasiun, koordinat, periode, sumber, dll.).
- **Windrose** — diagram polar frekuensi arah & kecepatan angin (16 sektor × 7 bin kecepatan dalam m/s: 0–1, 1–3, 3–5, 5–7, 7–9, 9–11, 11+), dengan toggle **Blowing FROM** (asal angin, konvensi meteorologi) / **Blowing TO** (arah hembusan), dan tombol unduh PNG (resolusi 900×800).
- Variabel cuaca (set tetap, harian):
  - Open-Meteo: suhu maks/min, presipitasi total, kecepatan angin 10 m maks (m/s), arah angin dominan, hembusan angin maks (m/s), kode cuaca WMO.
  - Meteostat: suhu rata-rata/min/maks, presipitasi total, salju, arah/kecepatan angin (m/s), hembusan angin peak (m/s), tekanan, sunshine.
  - NASA POWER: T2M, RH2M, PRECTOTCORR, PS, CLOUD_AMT, WS10M / WD10M (m/s), WS50M / WD50M (m/s), ALLSKY_SFC_SW_DWN (GHI), ALLSKY_SFC_SW_DNI (DNI), ALLSKY_SFC_SW_DIFF (DHI), CLRSKY_SFC_SW_DWN (clearsky GHI), ALLSKY_SFC_PAR_TOT (PAR).

## Cara pakai (lokal)

```bash
# clone
git clone https://github.com/aldiprasetya1/weather-data-exporter.git
cd weather-data-exporter

# cara 1: buka langsung di browser
xdg-open index.html   # atau double-click index.html

# cara 2: jalankan dengan static server (rekomendasi)
python3 -m http.server 8000
# lalu buka http://localhost:8000
```

## Tech stack

- HTML + CSS + Vanilla JavaScript (tanpa framework) — frontend
- [Open-Meteo API](https://open-meteo.com/) — gratis, tanpa API key (model global)
- [Meteostat](https://meteostat.net/) bulk endpoint — observasi stasiun, gratis, tanpa API key (di-proxy oleh backend karena CORS)
- [NASA POWER API](https://power.larc.nasa.gov/) — gratis, tanpa API key, CORS-friendly (dipanggil langsung dari browser)
- [SheetJS (xlsx)](https://sheetjs.com/) — export Excel
- [Plotly.js](https://plotly.com/javascript/) — windrose chart + PNG download
- FastAPI (Python) — backend proxy untuk Meteostat, deploy ke Fly.io

## Struktur

```
weather-data-exporter/
├── index.html       # markup utama
├── styles.css       # styling
├── app.js           # logika fetch data + windrose + export Excel
├── config.js        # runtime config (BACKEND_URL)
├── backend/         # FastAPI proxy untuk Meteostat
│   ├── pyproject.toml
│   └── app/
│       ├── main.py
│       └── stations_id.json   # daftar 129 stasiun Indonesia (Meteostat)
└── README.md
```

## Backend (Meteostat proxy)

Bulk endpoint Meteostat (`bulk.meteostat.net`) tidak mengizinkan CORS, jadi browser tidak bisa fetch langsung. Backend FastAPI di `backend/` menyediakan dua endpoint:

- `GET /stations` — daftar 129 stasiun Indonesia (Meteostat) dengan WMO/ICAO ID, lokasi, dan rentang inventory.
- `GET /daily/{station_id}?start=YYYY-MM-DD&end=YYYY-MM-DD` — proxy + decompress + filter rentang tanggal (max 366 hari per request). Wind speeds (`wspd`, `wpgt`) dikonversi dari km/h → m/s.
- `GET /hourly/{station_id}?start=YYYY-MM-DD&end=YYYY-MM-DD` — endpoint hourly (legacy, tidak dipakai oleh frontend versi harian).

Jalankan lokal:
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e .
uvicorn app.main:app --reload --port 8001
```

## Catatan tentang sumber data

- Untuk tanggal **lebih dari ~5 hari yang lalu**, app menggunakan endpoint `archive-api.open-meteo.com` (ERA5 reanalysis).
- Untuk tanggal **dalam ~5 hari terakhir hingga 16 hari ke depan**, app menggunakan `api.open-meteo.com/v1/forecast`.
- Jika rentang tanggal melintasi keduanya, app otomatis melakukan dua panggilan dan menggabungkan hasilnya.

Sheet **Info** di file Excel mencatat sumber yang dipakai (archive / forecast / keduanya) supaya jelas.

## Lisensi

MIT.
