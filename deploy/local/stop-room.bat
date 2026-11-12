@echo off
chcp 936 >nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3100" ^| findstr "LISTENING"') do (
  echo [dafeiyu] 停止 pid=%%a
  taskkill /PID %%a /F >nul 2>&1
)
echo [dafeiyu] 已停止（若还有窗口，关闭对应 cmd 即可）
timeout /t 2 >nul
