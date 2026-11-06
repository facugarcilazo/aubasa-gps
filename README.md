# AUBASA · Localizador de Progresivas GPS (SVIA - CAE Dolores)

Aplicación web para georreferenciación y cálculo de **Ruta, Kilómetro (Progresiva), Sentido y Referencias Viales** a partir de enlaces de Google Maps o coordenadas GPS en el Corredor del Atlántico (**Autovía 2, RP 11, RP 56, RP 63 y RP 74**).

## Características
- **Cálculo de Progresivas Calibrado**: Interpolación sobre la geometría vial real combinada con puntos de control GPS verificados.
- **Planilla Oficial de Referencias**: Incluye peajes, puentes, rotondas, destacamentos viales y accesos.
- **Sincronización en la Nube con Firebase**: Conectado a **Firebase Realtime Database** (`/aubasa_gps`) para compartir calibraciones e historial de asistencias en tiempo real.
- **Modo Dual**: Funciona tanto con backend Python/Flask (`python app.py`) como en modo estático en **GitHub Pages**.
