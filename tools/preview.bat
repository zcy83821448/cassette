@echo off
chcp 65001 >nul
rem 把 A / B 两张标签面放大画出来，不看整个三维场景。改完 textures.js 的贴纸
rem 想快速看效果时用；tools\_label.png 就是截图，虚线框内是窗口镂空、实际看不到。
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0.."
where node >nul 2>nul || (echo 未找到 Node.js & pause & exit /b 1)
call node node_modules/esbuild/bin/esbuild tools/label-preview.js --bundle --format=iife --outfile=dist/label-preview.js --log-level=warning || (pause & exit /b 1)
start "" tools\label-preview.html
echo 已重新打包 dist/label-preview.js，浏览器里刷新即可。
pause
