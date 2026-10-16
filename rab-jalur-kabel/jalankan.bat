@echo off
rem Jalankan aplikasi RAB Jalur Kabel di http://localhost:8765 (tutup jendela ini untuk berhenti).
cd /d "%~dp0"
start "" http://localhost:8765
python server.py 8765
