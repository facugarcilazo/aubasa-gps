@echo off
cd /d "%~dp0"
echo ===================================================
echo   Subiendo AUBASA GPS a GitHub (facugarcilazo/aubasa-gps)
echo ===================================================
copy /Y "templates\index.html" "index.html" >nul
git add .
git commit -m "Actualizacion AUBASA GPS + Firebase"
git push -u origin main
echo.
echo Proceso finalizado.
pause
