@echo off
setlocal
cd /d "%~dp0"

rem --- Fix 1: keep Electron from falling back to plain Node mode ---
rem If ELECTRON_RUN_AS_NODE is inherited (even set-but-empty), `app` is undefined
rem and the app dies instantly with "Cannot read properties of undefined
rem (reading 'isPackaged')". `set "VAR="` removes it from the environment.
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="

if not exist "node_modules\electron\dist\electron.exe" (
  echo [Veyra-omini] dependencies missing. Run: npm install
  pause
  exit /b 1
)

rem --- Fix 2: never reuse a stale Vite dev server. ---
rem A server left over from an earlier session can keep a poisoned
rem dep-optimization / transform cache (real case: SettingsPanel.tsx served as
rem an empty module -> renderer "does not provide an export named 'default'"
rem -> blank window). Always start a FRESH one instead of reusing the listener.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:"127.0.0.1:5173" ^| findstr /i LISTENING 2^>nul') do (
  echo [Veyra-omini] closing stale Vite server ^(PID %%p^) ...
  taskkill /f /pid %%p >nul 2>&1
)
if exist "node_modules\.vite\deps.stale-*" (
  echo [Veyra-omini] found stale dep cache, Vite will rebuild it automatically.
)

echo [Veyra-omini] starting Vite dev server ...
start "veyra-omini-vite" /min cmd /c "npx vite"

rem --- Fix 3: wait for Vite to actually answer, not a blind 4s sleep ---
set /a _tries=0
:waitvite
curl -s -o nul http://127.0.0.1:5173/ >nul 2>&1
if not errorlevel 1 goto viteok
set /a _tries+=1
if %_tries% geq 20 goto vitetimeout
timeout /t 1 /nobreak >nul
goto waitvite
:vitetimeout
echo [Veyra-omini] warning: Vite did not answer on 127.0.0.1:5173, launching anyway ...
:viteok

rem --- Fix 4: the GPU process crashes here (0xC0000005), force software rendering ---
echo [Veyra-omini] launching desktop window ...
start "" "node_modules\electron\dist\electron.exe" . --disable-gpu --disable-gpu-compositing --no-sandbox

exit /b 0
