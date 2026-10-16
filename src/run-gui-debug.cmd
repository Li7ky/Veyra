@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  Veyra 调试启动器 —— 前台运行，控制台不关闭，能直接看到报错
rem  双击本文件即可。窗口起不来时会在这里打印原因，不会一闪而过。
rem ============================================================

set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="
set "ELECTRON_ENABLE_LOGGING=1"
set "ELECTRON_ENABLE_STACK_DUMPING=1"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [Veyra] 缺少依赖，请先执行: npm install
  pause
  exit /b 1
)

rem 始终启动全新 Vite：复用旧服务器会带着被污染的依赖优化/转换缓存，
rem 表现为「窗口能开但界面空白」（模块服务为空，默认导出丢失）。
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:"127.0.0.1:5173" ^| findstr /i LISTENING 2^>nul') do (
  echo [Veyra] 关闭残留的 Vite 服务器 ^(PID %%p^) ...
  taskkill /f /pid %%p >nul 2>&1
)

echo [Veyra] 正在启动 Vite 开发服务器 ...
start "veyra-vite" /min cmd /c "npx vite"

rem 等待 Vite 真正响应，而不是盲等固定秒数
set /a _tries=0
:waitvite
curl -s -o nul http://127.0.0.1:5173/ >nul 2>&1
if not errorlevel 1 goto viteok
set /a _tries+=1
if %_tries% geq 20 goto vitetimeout
timeout /t 1 /nobreak >nul
goto waitvite
:vitetimeout
echo [Veyra] 警告: Vite 未在 127.0.0.1:5173 响应，仍然尝试启动 ...
:viteok

echo.
echo [Veyra] 前台启动 Electron，请留意下方输出 ...
echo ------------------------------------------------------------
"node_modules\electron\dist\electron.exe" . --disable-gpu --disable-gpu-compositing --no-sandbox --enable-logging
echo ------------------------------------------------------------
echo.
echo [Veyra] Electron 已退出，退出码 = %ERRORLEVEL%
echo   若上方出现 "reg.exe" 被拦截 / EPERM / Cannot read properties 等字样，
echo   把这段输出发给助手即可定位。
pause
