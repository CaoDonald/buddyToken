@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 积分消耗看板 - Token 同步

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

echo ============================================
echo   正在扫描本地会话记录并生成 Token 数据
echo ============================================
echo.

rem ---------- 探测 node ----------
set "NODE="

rem 1) 优先使用 PATH 里的 node
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE set "NODE=%%i"
)

rem 2) 回退到 WorkBuddy 托管的固定版本
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
  echo [错误] 未找到可用的 node.exe
  echo        请安装 Node.js，或确认 WorkBuddy 托管版本存在于：
  echo        %%USERPROFILE%%\.workbuddy\binaries\node\versions\
  echo.
  pause
  exit /b 1
)

echo [OK] Node: !NODE!
"!NODE!" --version
echo.

echo 正在生成 token-usage-data.js ...
"!NODE!" "%HERE%\token-usage-report.js" --emit-js
if errorlevel 1 (
  echo.
  echo [错误] 脚本执行失败，请查看上方输出。
  echo.
  pause
  exit /b 1
)

if not exist "%HERE%\token-usage-data.js" (
  echo.
  echo [错误] 未生成 token-usage-data.js，请检查脚本输出目录。
  echo.
  pause
  exit /b 1
)

echo.
echo 正在打开看板 ...
start "" "%HERE%\workbuddy-token.html"

echo.
echo 完成。若看板已经打开，请按 F5 刷新，或点击顶栏「同步 Token」。
rem 显式调用系统目录下的 timeout，避免 PATH 中同名程序（如 Git 自带的）抢到
"%SystemRoot%\System32\timeout.exe" /t 5 /nobreak >nul 2>nul
exit /b 0
