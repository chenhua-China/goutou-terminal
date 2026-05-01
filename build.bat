@echo off
echo 正在清理 dist 目录...
taskkill /F /IM electron.exe /T 2>nul
taskkill /F /IM node.exe /T 2>nul
timeout /t 5 /nobreak >nul
rd /s /q dist 2>nul
echo 开始打包...
npm run build:win
echo 打包完成！
pause