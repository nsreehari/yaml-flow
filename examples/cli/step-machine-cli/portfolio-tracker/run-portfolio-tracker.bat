@echo off
setlocal
cd /d "%~dp0"

set "EXAMPLE_TEMP_ROOT=%TEMP%\yaml-flow-step-machine-portfolio-tracker"
set "STORE_DIR=%EXAMPLE_TEMP_ROOT%\store"
set "RUNTIME_ROOT=%EXAMPLE_TEMP_ROOT%\runtime"

if /I "%~1"=="pause" goto :pause
if /I "%~1"=="resume" goto :resume
if /I "%~1"=="status" goto :status
goto :run

:pause
node ..\..\..\..\step-machine-cli.js --store file --store-dir "%STORE_DIR%" --pause
exit /b %ERRORLEVEL%

:resume
node ..\..\..\..\step-machine-cli.js portfolio-tracker.flow.yaml --store file --store-dir "%STORE_DIR%" --resume
exit /b %ERRORLEVEL%

:status
node ..\..\..\..\step-machine-cli.js --store file --store-dir "%STORE_DIR%" --status
exit /b %ERRORLEVEL%

:run
node -e "const fs=require('fs');const cp=require('child_process');const raw=JSON.parse(fs.readFileSync('portfolio-tracker.input.json','utf8'));raw.runtime_root=(process.env.RUNTIME_ROOT||'').replace(/\\/g,'/');const r=cp.spawnSync(process.execPath,['..\\..\\..\\..\\step-machine-cli.js','portfolio-tracker.flow.yaml','--initial-data',JSON.stringify(raw)],{stdio:'inherit',windowsHide:true,cwd:__dirname});process.exit(r.status??1);"
exit /b %ERRORLEVEL%
