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

rem 检查 Vite 开发服务器
netstat -ano | findstr /c:"127.0.0.1:5173" | findstr /i LISTENING >nul 2>&1
if errorlevel 1 (
  echo [Veyra] 5173 未监听，正在启动 Vite 开发服务器 ...
  start "veyra-vite" /min cmd /c "npx vite"
  echo [Veyra] 等待 Vite 就绪 ...
  timeout /t 5 /nobreak >nul
) else (
  echo [Veyra] Vite 已在 5173 运行，跳过启动。
)

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
