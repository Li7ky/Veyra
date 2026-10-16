@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="

if not exist "node_modules\electron\dist\electron.exe" (
  echo [Veyra-omini] electron not found. Run: npm install
  pause
  exit /b 1
)

if not exist "node_modules\.bin\vite.cmd" (
  echo [Veyra-omini] vite not found. Run: npm install
  pause
  exit /b 1
)

rem 不复用 5173 上的旧服务器：残留服务器的依赖优化缓存可能是脏的，
rem 会导致渲染层模块被服务为空、界面空白。每次启动一个干净的 Vite。
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:"127.0.0.1:5173" ^| findstr /i LISTENING 2^>nul') do (
  echo [Veyra-omini] closing stale Vite server ^(PID %%p^) ...
  taskkill /f /pid %%p >nul 2>&1
)

echo [Veyra-omini] starting Vite dev server ...
start "veyra-omini-vite" /min cmd /c "npx vite"

rem 等待 Vite 真正可访问
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

echo [Veyra-omini] launching Electron ...
node_modules\electron\dist\electron.exe . --disable-gpu --no-sandbox
