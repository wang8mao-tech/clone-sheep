@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Clone Studio

rem 双击启动 Clone Studio：后端 127.0.0.1:4310 + 界面 127.0.0.1:5173，界面起好后自动打开浏览器。
rem 关掉这个窗口（或按 Ctrl+C）就会停止本窗口起的那部分。

where pnpm >nul 2>nul
if errorlevel 1 (
  echo 找不到 pnpm。先装 Node.js 22.15 或更新版本，再执行：npm install -g pnpm
  pause
  exit /b 1
)

if not exist node_modules (
  echo 第一次启动，先安装依赖……
  call pnpm install
  if errorlevel 1 (
    echo 依赖安装失败，看上面的报错。
    pause
    exit /b 1
  )
)

rem 前后端各自看端口：只看界面的话，界面还在、后端已经退出时会被当成「在运行」，页面只会报「后端未响应」
set "WEB_UP=0"
set "API_UP=0"
netstat -ano | findstr /r /c:":5173 .*LISTENING" >nul && set "WEB_UP=1"
netstat -ano | findstr /r /c:":4310 .*LISTENING" >nul && set "API_UP=1"

if "%WEB_UP%%API_UP%"=="11" (
  echo Clone Studio 已经在运行，直接打开浏览器。
  start "" http://127.0.0.1:5173
  timeout /t 3 >nul
  exit /b 0
)

rem 后台等界面端口起来再开浏览器，最多等 60 秒
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 60; $i++) { if ((Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) -and (Get-NetTCPConnection -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue)) { Start-Process 'http://127.0.0.1:5173'; break }; Start-Sleep -Seconds 1 }"

if "%WEB_UP%"=="1" (
  echo 界面已经在运行，但后端没起来：只启动后端 http://127.0.0.1:4310
  echo 关掉这个窗口（或按 Ctrl+C）就会停止后端。
  echo.
  call pnpm --filter @clone-studio/server dev
  goto :stopped
)

if "%API_UP%"=="1" (
  echo 后端已经在运行，但界面没起来：只启动界面 http://127.0.0.1:5173
  echo 关掉这个窗口（或按 Ctrl+C）就会停止界面。
  echo.
  call pnpm --filter @clone-studio/web dev
  goto :stopped
)

echo 正在启动：界面 http://127.0.0.1:5173 ，后端 http://127.0.0.1:4310
echo 关掉这个窗口（或按 Ctrl+C）就会停止。
echo.
call pnpm dev

:stopped
echo.
echo Clone Studio 已停止。
pause
