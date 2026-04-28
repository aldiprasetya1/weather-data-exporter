# Weather Data Exporter

Aplikasi web sederhana (static site, no backend) untuk mengambil data cuaca per kota dari [Open-Meteo](https://open-meteo.com/) dan mengekspornya ke Excel (`.xlsx`).

## Fitur

- Pencarian kota dengan autocomplete (Open-Meteo Geocoding API)
- Pilih rentang tanggal bebas (historis 1940 – sekarang, atau forecast hingga 16 hari ke depan — sistem otomatis menggabungkan archive + forecast jika rentang melintasi keduanya)
- Pilih granularitas: **per jam (hourly)** atau **per hari (daily)**
- Variabel cuaca yang tersedia:
  - Suhu (°C)
  - Kelembaban relatif (%)
  - Presipitasi (mm)
  - Tutupan awan total / rendah / menengah / tinggi (%)
  - Kecepatan angin 10m (km/jam)
  - Arah angin 10m (°)
  - Hembusan angin 10m (km/jam)
  - Tekanan permukaan (hPa)
  - Kode cuaca WMO
- Pratinjau 50 baris pertama sebelum unduh
- Output Excel berisi 2 sheet: **Data** + **Info** (metadata: kota, koordinat, periode, sumber, dll.)
- Tidak butuh API key, tidak butuh backend — bisa dibuka langsung di browser atau di-host sebagai static site (GitHub Pages, Netlify, Vercel, devinapps.com, dll.)

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

- HTML + CSS + Vanilla JavaScript (tanpa framework)
- [Open-Meteo API](https://open-meteo.com/) — gratis, tanpa API key
- [SheetJS (xlsx)](https://sheetjs.com/) via CDN — untuk export Excel

## Struktur

```
weather-data-exporter/
├── index.html      # markup utama
├── styles.css      # styling
├── app.js          # logika fetch data + export Excel
└── README.md
```

## Catatan tentang sumber data

- Untuk tanggal **lebih dari ~5 hari yang lalu**, app menggunakan endpoint `archive-api.open-meteo.com` (ERA5 reanalysis).
- Untuk tanggal **dalam ~5 hari terakhir hingga 16 hari ke depan**, app menggunakan `api.open-meteo.com/v1/forecast`.
- Jika rentang tanggal melintasi keduanya, app otomatis melakukan dua panggilan dan menggabungkan hasilnya.

Sheet **Info** di file Excel mencatat sumber yang dipakai (archive / forecast / keduanya) supaya jelas.

## Lisensi

MIT.
