@echo off
title AUBASA GPS - Servidor Local
cd /d "%~dp0"
echo ===================================================
echo   Iniciando AUBASA - Localizador de Progresivas GPS
echo   Abriendo http://127.0.0.1:5000 en tu navegador...
echo ===================================================
start "" "http://127.0.0.1:5000"
python app.py
pause
