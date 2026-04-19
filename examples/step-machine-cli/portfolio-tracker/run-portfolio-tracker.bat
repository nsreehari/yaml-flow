@echo off
setlocal
cd /d "%~dp0"

set "BOARD_LIVE_CARDS_NO_SPAWN=1"

node -e "const fs=require('fs');const cp=require('child_process');const input=JSON.stringify(JSON.parse(fs.readFileSync('portfolio-tracker.input.json','utf8')));const r=cp.spawnSync(process.execPath,['..\\..\\..\\step-machine-cli.js','portfolio-tracker.flow.yaml','--data',input],{stdio:'inherit',env:{...process.env,BOARD_LIVE_CARDS_NO_SPAWN:'1'}});process.exit(r.status??1);"
exit /b %ERRORLEVEL%
