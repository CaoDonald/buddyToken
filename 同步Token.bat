@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 积分消耗看板 - 同步本地记录与官方账单

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

echo ============================================
echo   扫描本地会话记录 + 同步官方账单/账号积分
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

echo 正在生成 token-usage-data.js（含官方账单与账号积分）...
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
echo 完成。若看板已经打开，按 F5 刷新即可看到最新数据（本地会话与官方账单都已更新）。
rem 显式调用系统目录下的 timeout，避免 PATH 中同名程序（如 Git 自带的）抢到
"%SystemRoot%\System32\timeout.exe" /t 5 /nobreak >nul 2>nul
exit /b 0
