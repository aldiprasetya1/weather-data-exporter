@echo off
setlocal

cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Membuat virtual environment lokal...
    python -m venv .venv
)

call ".venv\Scripts\activate.bat"

echo Menginstall dependency...
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

if not exist "offline-data" mkdir "offline-data"

set "WDE_DB_PATH=%CD%\offline-data\tokens.sqlite"
if "%ADMIN_SECRET%"=="" set "ADMIN_SECRET=admin-offline-2026"

echo.
echo Angin Berhembus offline siap.
echo URL aplikasi : http://localhost:8001
echo URL admin    : http://localhost:8001/admin
echo Admin secret : %ADMIN_SECRET%
echo.
echo Catatan: jika ingin NOAA CDO penuh, set NOAA_CDO_TOKEN sebelum menjalankan file ini.
echo Jika NOAA CDO kosong, aplikasi tetap mencoba fallback GHCN Daily resmi.
echo.

cd backend
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8001

endlocal
