# Weather Data Exporter

Aplikasi web sederhana (static site, no backend) untuk mengambil data cuaca per kota dari [Open-Meteo](https://open-meteo.com/) dan mengekspornya ke Excel (`.xlsx`).

## Fitur

- **Dua sumber data:**
  - **Open-Meteo (model global)** — kota mana saja di dunia, historis 1940 → sekarang + forecast 16 hari ke depan, granularitas hourly/daily.
  - **Meteostat (stasiun observasi Indonesia)** — observasi historis hourly dari ~129 stasiun ASOS/SYNOP di Indonesia (BMKG bandara: WIII Soekarno-Hatta, WARR Juanda, WADD Ngurah Rai, dll.).
- Pencarian kota dengan autocomplete (Open-Meteo Geocoding) atau pencarian stasiun (Meteostat).
- Pratinjau 50 baris pertama sebelum unduh.
- Output Excel `.xlsx` berisi 2 sheet: **Data** + **Info** (metadata: kota/stasiun, koordinat, periode, sumber, dll.).
- **Windrose** — diagram polar frekuensi arah & kecepatan angin (16 sektor × 7 bin kecepatan), dengan tombol unduh PNG (resolusi 900×800).
- Variabel cuaca:
  - Open-Meteo: suhu, kelembaban, presipitasi, tutupan awan total/rendah/menengah/tinggi, kecepatan/arah/hembusan angin 10m, tekanan, kode cuaca WMO
  - Meteostat: suhu, dew point, kelembaban, presipitasi, salju, arah/kecepatan/hembusan angin, tekanan, sunshine, kode cuaca

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
- `GET /hourly/{station_id}?start=YYYY-MM-DD&end=YYYY-MM-DD` — proxy + decompress + filter rentang tanggal (max 366 hari per request).

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
