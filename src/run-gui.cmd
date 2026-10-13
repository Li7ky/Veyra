@echo off
setlocal
cd /d "%~dp0"

rem --- Fix 1: keep Electron from falling back to plain Node mode ---
rem If ELECTRON_RUN_AS_NODE=1 is inherited, `app` is undefined and the app
rem dies instantly with "Cannot read properties of undefined (reading 'isPackaged')".
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="

if not exist "node_modules\electron\dist\electron.exe" (
  echo [Veyra] dependencies missing. Run: npm install
  pause
  exit /b 1
)

rem --- Start the Vite dev server only if 5173 is not already listening ---
netstat -ano | findstr /c:"127.0.0.1:5173" | findstr /i LISTENING >nul 2>&1
if errorlevel 1 (
  echo [Veyra] starting Vite dev server ...
  start "veyra-vite" /min cmd /c "npx vite"
  timeout /t 4 /nobreak >nul
)

rem --- Fix 2: the GPU process crashes here (0xC0000005), force software rendering ---
echo [Veyra] launching desktop window ...
start "" "node_modules\electron\dist\electron.exe" . --disable-gpu --disable-gpu-compositing --no-sandbox

exit /b 0
