@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   把「交我录」推到 GitHub
echo   ----------------------------------------
echo   前提：你已经在这个网址建好一个空仓库（不要勾选 README）
echo         https://github.com/new
echo.

set "GHUSER="
set /p GHUSER=GitHub 用户名（英文，例如 lijiatong）:
if "%GHUSER%"=="" goto :nouser

set "REPO=jiaowolu"
set "REPO_IN="
set /p REPO_IN=仓库名（直接回车就用 jiaowolu）:
if not "%REPO_IN%"=="" set "REPO=%REPO_IN%"

echo.
echo   将推送到 https://github.com/%GHUSER%/%REPO%
echo   第一次会弹出浏览器让你登录 GitHub，登录完等它自己跑完。
echo.
pause

git remote remove origin >nul 2>nul
git remote add origin "https://github.com/%GHUSER%/%REPO%.git"
git push -u origin main
if errorlevel 1 goto :failed

echo.
echo   ========================================
echo   推上去了。最后一步（只需做一次）：
echo.
echo   打开 https://github.com/%GHUSER%/%REPO%/settings/pages
echo   Source 选「Deploy from a branch」
echo   分支选「main」，目录选「/ (root)」，点 Save
echo.
echo   等一两分钟，网址就是：
echo   https://%GHUSER%.github.io/%REPO%/
echo   ========================================
echo.
pause
exit /b 0

:nouser
echo.
echo   没有填用户名，什么都没做。
pause
exit /b 1

:failed
echo.
echo   推送失败了。常见原因：
echo   1. GitHub 上还没有这个仓库（先去 https://github.com/new 建一个空的）
echo   2. 用户名或仓库名打错
echo   3. 登录窗口被关掉了——再跑一次这个文件，按提示登录
echo.
pause
exit /b 1
