@echo off
rem Guarded launcher for DeepSeek Harness.
rem
rem An official update replaces resources\app.asar wholesale, so the restart-menu
rem patch disappears every time the app updates. That archive has no supported
rem extension point to hook, so the patch cannot survive an update. What it can do
rem is come back on its own: point the desktop shortcut at this script and every
rem launch first checks whether the installed build still carries the patch,
rem reinstalls it when it does not, then starts the app.
rem
rem This must never start a second instance while one is running, and must never
rem block a launch because the patch failed: the app matters more than the menu.
setlocal

set "ELECTRON_RUN_AS_NODE="
set "TOOL=%~dp0"
set "DSH_EXE=D:\Dev Tools\DeepSeek Harness\DeepSeek Harness.exe"
set "LOG=%TEMP%\dsh-restart-guard.log"

if not exist "%DSH_EXE%" goto missing

rem Absolute paths: a shell that puts its own find first on PATH would answer
rem instead of the Windows one, and then this would never detect the running app.
"%SystemRoot%\System32\tasklist.exe" /FI "IMAGENAME eq DeepSeek Harness.exe" /NH 2>nul | "%SystemRoot%\System32\find.exe" /I "DeepSeek Harness.exe" >nul
if not errorlevel 1 goto launch

rem `node` is not on PATH for a shortcut launched from Explorer, so prefer the
rem copy bundled with the application itself.
set "NODE=D:\Dev Tools\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"

rem `verify` is read-only and passes only when both entries are the payload.
"%NODE%" "%TOOL%lib\apply.cjs" verify >"%LOG%" 2>&1
if not errorlevel 1 goto launch

echo [DSH] 重启按钮补丁不在当前版本里，正在重新安装...
"%NODE%" "%TOOL%lib\apply.cjs" apply >>"%LOG%" 2>&1
if errorlevel 1 echo [DSH] 补丁安装失败，应用仍会启动。日志：%LOG%

:launch
start "" "%DSH_EXE%" %*
endlocal
exit /b 0

:missing
echo [DSH] 找不到 "%DSH_EXE%"
endlocal
exit /b 1
