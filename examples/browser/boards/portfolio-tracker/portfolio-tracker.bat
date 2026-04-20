@echo off
setlocal

set "BOARD_LIVE_CARDS_NO_SPAWN=1"
node "%~dp0portfolio-tracker.js"

endlocal
