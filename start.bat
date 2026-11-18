@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PORT=8765"
set "URL=http://127.0.0.1:%PORT%/"

echo.
echo   ==========================================
echo     交我录 - 本地工作台
echo   ==========================================
echo.

rem ---- 0. 端口上已经有服务了就直接开页面 ----
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 (
  echo   检测到服务已经在运行，直接打开页面。
  start "" "%URL%"
  exit /b 0
)

rem ---- 1. 找一个能用的 Python ----
set "PY="
python --version >nul 2>&1
if not errorlevel 1 set "PY=python"

if not defined PY (
  py -3 --version >nul 2>&1
  if not errorlevel 1 set "PY=py -3"
)

if not defined PY (
  if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
)

if not defined PY (
  echo   [x] 没找到 Python。
  echo.
  echo       装一个就行：https://www.python.org/downloads/
  echo       安装时记得勾选 "Add python.exe to PATH"。
  echo.
  echo       不想装也可以：双击 app\index.html 能看到界面，
  echo       但识别和 PDF 拆页要上面的服务才能真正跑。
  echo.
  pause
  exit /b 1
)

rem ---- 2. 等端口真的通了再开浏览器，免得打开是"无法访问" ----
if /i not "%JW_NOBROWSER%"=="1" (
  start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 100;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Close();Start-Process '%URL%';break}catch{Start-Sleep -Milliseconds 150}}"
)

echo   服务启动中，浏览器会自动打开...
echo   地址：%URL%
echo   用完直接关掉这个黑窗口即可停止。
echo.
echo   ------------------------------------------

rem ---- 3. 起服务。万一意外退出（被杀、端口抖动）就自动重启，不用重新双击 ----
:serve
if exist "%~dp0server.py" (
  %PY% "%~dp0server.py" --port %PORT% --dir "%~dp0app"
) else (
  %PY% -m http.server %PORT% --bind 127.0.0.1 --directory "%~dp0app"
)
set "CODE=%ERRORLEVEL%"

rem 用户按 Ctrl+C 关窗口时也会走到这里，用 0 或 130 都不重启
if "%CODE%"=="0" goto stopped
if "%CODE%"=="130" goto stopped

echo.
echo   服务意外退出（代码 %CODE%），3 秒后自动重启...
echo   不想重启就按 Ctrl+C 或者直接关掉这个窗口。
timeout /t 3 /nobreak >nul
goto serve

:stopped
echo.
echo   服务已停止。
pause
