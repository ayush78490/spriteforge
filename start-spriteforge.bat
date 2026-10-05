@echo off
rem Starts ComfyUI (D:\ComfyUI_windows_portable) in its own window, waits for it, then starts SpriteForge.
set COMFY_DIR=D:\ComfyUI_windows_portable
rem Whole-PC RAM limit, enforced by custom_nodes\spriteforge_ram_guard: ComfyUI's physical RAM is capped to
rem whatever is left under this after your other apps, so the PC never goes over it (the AI slows down instead).
set SPRITEFORGE_SYSTEM_RAM_GB=22
cd /d "%~dp0"

curl -s http://127.0.0.1:8188/system_stats >nul 2>&1
if %errorlevel%==0 goto comfy_ready

echo Starting ComfyUI (PC RAM limit %SPRITEFORGE_SYSTEM_RAM_GB% GB)...
rem --disable-pinned-memory: pinned RAM can't be paged out, so it would break the limit
start "ComfyUI" /d "%COMFY_DIR%" "%COMFY_DIR%\python_embeded\python.exe" -s ComfyUI\main.py --windows-standalone-build --listen 127.0.0.1 --port 8188 --disable-pinned-memory

echo Waiting for ComfyUI on http://127.0.0.1:8188 ...
:wait_comfy
timeout /t 3 /nobreak >nul
curl -s http://127.0.0.1:8188/system_stats >nul 2>&1
if not %errorlevel%==0 goto wait_comfy

:comfy_ready
echo ComfyUI is ready.
if not exist node_modules call npm install
start "" http://localhost:8000
npm start
