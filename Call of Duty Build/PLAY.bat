@echo off
title NUKETOWN
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0game\server.ps1"
