@echo off
chcp 65001 >nul
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"
where node >nul 2>nul || (echo 未找到 Node.js，请先安装：https://nodejs.org & pause & exit /b 1)
call node build.mjs %*
echo.
pause
