@echo off
chcp 936 >nul
cd /d "%~dp0..\.."
if not exist node_modules (
  echo [dafeiyu] 首次启动，安装依赖...
  call npm ci --no-audit --no-fund || goto :err
)
echo [dafeiyu] 启动 bridge（房间：http://127.0.0.1:3100/room/）
node src\bridge.js
goto :eof
:err
echo [dafeiyu] 依赖安装失败
pause
