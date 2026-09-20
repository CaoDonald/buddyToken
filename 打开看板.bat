@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 积分消耗看板 - 本地服务

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

echo ============================================
echo   启动本地服务
echo   看板将以 file:// 打开（与双击 HTML 是同一个地址）
echo   这样「本地快照」只存一份，换入口也不会看不到
echo ============================================
echo.

rem ---------- 探测 node（必须 v18+，脚本用到 util.parseArgs）----------
set "NODE="
set "NODE_OLD="

rem 1) PATH 里的 node：逐个验版本，只接受主版本号 >= 18 的
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE (
    set "VER="
    for /f "tokens=1 delims=." %%v in ('"%%i" --version 2^>nul') do set "VER=%%v"
    set "VER=!VER:v=!"
    if defined VER (
      if !VER! GEQ 18 (
        set "NODE=%%i"
      ) else (
        set "NODE_OLD=%%i"
      )
    )
  )
)

rem 2) 回退到 WorkBuddy 托管的版本（实测 v22，肯定够新）
if not defined NODE (
  if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" (
    set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
  )
)

rem 3) 再回退：遍历托管目录，取任意一个可用版本
if not defined NODE (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if not defined NODE if exist "%%~fD\node.exe" set "NODE=%%~fD\node.exe"
  )
)

if not defined NODE (
  echo [错误] 未找到可用的 node.exe（需要 Node 18 或更高）
  if defined NODE_OLD echo        检测到但版本过低：!NODE_OLD!
  echo        脚本用到 util.parseArgs，Node 18.3 才有。
  echo.
  echo        解决办法（任选其一）：
  echo          1. 用 nvm 切到新版：nvm use 22
  echo          2. 确认 WorkBuddy 托管版本存在于：
  echo             %%USERPROFILE%%\.workbuddy\binaries\node\versions\
  echo.
  pause
  exit /b 1
)

echo [OK] Node: !NODE!
"!NODE!" --version
echo.

echo 正在启动服务，数秒后会自动打开看板 ...
echo 关闭本窗口即停止服务。
echo.

rem 前台运行服务；它启动后会自己判断端口并用默认浏览器打开看板
"!NODE!" "%HERE%\server.js"

echo.
echo 服务已停止。看板仍可双击 workbuddy-token.html 打开（只是同步按钮会提示服务未启动）。
echo 提示：请始终用 file:// 打开看板（双击 HTML 或本 bat 都行），
echo       不要用 http://127.0.0.1 地址，否则「本地快照」会存成两份、互相看不见。
echo.
pause
exit /b 0
