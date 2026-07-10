# Menjalankan Angin Berhembus Offline

Folder ini adalah salinan project Angin Berhembus untuk diedit dan dites lokal
sebelum deploy ke website.

## Cara paling mudah

1. Buka folder ini di Windows Explorer.
2. Double-click `run_offline.bat`.
3. Tunggu sampai terminal menampilkan URL.
4. Buka:
   - Aplikasi: `http://localhost:8001`
   - Admin: `http://localhost:8001/admin`

Default admin secret lokal:

```text
admin-offline-2026
```

Token pelanggan yang dibuat offline tersimpan di:

```text
offline-data/tokens.sqlite
```

Database lokal ini hanya untuk testing offline dan tidak otomatis sama dengan
database production.

## Catatan NOAA

Jika environment variable `NOAA_CDO_TOKEN` tidak diset, endpoint NOAA CDO tidak
dipakai penuh. Aplikasi tetap mencoba fallback resmi NOAA GHCN Daily:

- `ghcnd-stations.txt`
- file `.dly` per stasiun

Untuk mengetes NOAA CDO penuh secara lokal, jalankan Command Prompt lalu:

```bat
set NOAA_CDO_TOKEN=token_noaa_anda
run_offline.bat
```

## File yang umum diedit

- `index.html` untuk struktur halaman user.
- `admin.html` untuk halaman admin.
- `styles.css` untuk tampilan.
- `app.js` untuk logika frontend, grafik, export, token download.
- `backend/app/main.py` untuk endpoint backend utama.
- `backend/app/proxies.py` untuk proxy Open-Meteo, NASA POWER, dan NOAA.
- `backend/app/auth.py` untuk token dan kuota download.

## Setelah selesai edit

Tes offline dulu di `http://localhost:8001`. Jika sudah sesuai, baru publish
ke GitHub dan deploy ke Vercel seperti alur production biasa.
