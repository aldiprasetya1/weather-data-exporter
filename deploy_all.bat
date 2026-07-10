@echo off
setlocal

echo ===================================================
echo     Skrip Deploy ^& Publish Angin Berhembus
echo ===================================================
echo.

set /p VERCEL_TOKEN="Masukkan Vercel Token Anda: "
set /p GITHUB_TOKEN="Masukkan GitHub Token Anda: "

echo.
echo [1/2] Melakukan deployment ke Vercel...
node deploy_vercel.mjs %VERCEL_TOKEN% .

echo.
echo [2/2] Mempublikasikan kode ke GitHub...
node publish_github_contents.mjs %GITHUB_TOKEN% .

echo.
echo Proses selesai!
pause
