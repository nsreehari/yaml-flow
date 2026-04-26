@echo off
setlocal enabledelayedexpansion

REM Copilot Wrapper - Manages session isolation for GitHub Copilot CLI
REM Usage: copilot_wrapper.bat <output_file> <session_dir> <working_dir> <request_or_file> <result_type> [agent_name] [model] [result_shape_file]
REM
REM If request_or_file starts with @, it's treated as a file path containing the prompt.
REM Otherwise, it's treated as the prompt string directly.
REM result_type: "raw" to return plain text, "json" to extract JSON (passed to clean_copilot_output.ps1)
REM agent_name: name of the agent for log files (optional)
REM model: passed to copilot with --model flag (optional)

SET "OUTPUT_FILE=%~1"
SET "SESSION_DIR=%~2"
SET "WORKING_DIR=%~3"
SET "REQUEST_OR_FILE=%~4"
SET "RESULT_TYPE=%~5"
SET "AGENT_NAME=%~6"
SET "MODEL=%~7"
SET "RESULT_SHAPE_FILE=%~8"

if not defined RESULT_TYPE SET "RESULT_TYPE=raw"

SET "PROMPT_FILE="
SET "REQUEST="
echo !REQUEST_OR_FILE! | findstr /b "@" >nul
if !errorlevel! equ 0 (
    SET "PROMPT_FILE=!REQUEST_OR_FILE:~1!"
) else (
    SET "REQUEST=!REQUEST_OR_FILE!"
)

SET "_WD_HASH=!WORKING_DIR:\=!"
SET "_WD_HASH=!_WD_HASH:/=!"
SET "_WD_HASH=!_WD_HASH::=!"
SET "_WD_HASH=!_WD_HASH:.=!"
SET "_WD_HASH=!_WD_HASH: =!"
SET "COPILOT_BASE=%TEMP%\copilot-sessions\!_WD_HASH!"
SET "COPILOT_CACHE=%COPILOT_BASE%\session-state"
SET "LOCK_FILE=%COPILOT_BASE%\copilot.lock"
SET "UUID_FILE=%SESSION_DIR%\session.uuid"

if not exist "%COPILOT_BASE%" mkdir "%COPILOT_BASE%"
if not exist "%COPILOT_CACHE%" mkdir "%COPILOT_CACHE%"
if not exist "%SESSION_DIR%" mkdir "%SESSION_DIR%"

if exist "%LOCK_FILE%" (
    for /f "tokens=*" %%a in ('powershell -NoProfile -Command "if ((Get-Item '%LOCK_FILE%').LastWriteTime -lt (Get-Date).AddMinutes(-20)) { Write-Output 'STALE' }"') do (
        if "%%a"=="STALE" (
            del "%LOCK_FILE%" 2>nul
        )
    )
)
:acquire_lock
2>nul (
    >"%LOCK_FILE%" (
        echo %DATE% %TIME%
    )
) || (
    timeout /t 1 /nobreak >nul
    goto acquire_lock
)

SET "SESSION_UUID="
if exist "%UUID_FILE%" (
    set /p SESSION_UUID=<"%UUID_FILE%"
) else (
    for /f "tokens=*" %%a in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString()"') do (
        SET "SESSION_UUID=%%a"
    )
    echo !SESSION_UUID!>"%UUID_FILE%"
)

SET "CACHE_SESSION_PATH=%COPILOT_CACHE%\!SESSION_UUID!"

if exist "%SESSION_DIR%\workspace.yaml" (
    if exist "!CACHE_SESSION_PATH!" rmdir /s /q "!CACHE_SESSION_PATH!" 2>nul
    mkdir "!CACHE_SESSION_PATH!" 2>nul
    for %%f in ("%SESSION_DIR%\*") do (
        if /i not "%%~nxf"=="session.uuid" (
            move /y "%%f" "!CACHE_SESSION_PATH!\" >nul 2>&1
        )
    )
    for /d %%d in ("%SESSION_DIR%\*") do (
        robocopy "%%d" "!CACHE_SESSION_PATH!\%%~nxd" /E /MOVE /NFL /NDL /NJH /NJS >nul 2>&1
    )
)

cd /d "%WORKING_DIR%"

SET "MODEL_FLAG="
if defined MODEL (
    SET "MODEL_FLAG=--model !MODEL!"
)

if defined PROMPT_FILE (
    type "!PROMPT_FILE!" | call copilot --allow-all --resume !SESSION_UUID! !MODEL_FLAG! > "%OUTPUT_FILE%" 2>&1
) else (
    call copilot -p "%REQUEST%" --allow-all --resume !SESSION_UUID! !MODEL_FLAG! > "%OUTPUT_FILE%" 2>&1
)

SET "LOG_DIR=%COPILOT_BASE%\copilot-logs"
if not exist "!LOG_DIR!" mkdir "!LOG_DIR!"
SET "LOG_AGENT=unknown"
if defined AGENT_NAME SET "LOG_AGENT=!AGENT_NAME!"
for /f "tokens=*" %%t in ('powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd-HHmmss'"') do SET "LOG_TS=%%t"
SET "LOG_FILE=!LOG_DIR!\!LOG_AGENT!_!LOG_TS!.log"
echo === PROMPT (!LOG_TS!) === > "!LOG_FILE!"
echo Agent: !LOG_AGENT! >> "!LOG_FILE!"
echo ResultType: !RESULT_TYPE! >> "!LOG_FILE!"
echo Working Dir: %WORKING_DIR% >> "!LOG_FILE!"
echo --- >> "!LOG_FILE!"
if defined PROMPT_FILE (
    type "!PROMPT_FILE!" >> "!LOG_FILE!" 2>nul
) else (
    echo %REQUEST% >> "!LOG_FILE!"
)
echo. >> "!LOG_FILE!"
echo === RESPONSE === >> "!LOG_FILE!"
type "%OUTPUT_FILE%" >> "!LOG_FILE!" 2>nul
echo. >> "!LOG_FILE!"
echo === END === >> "!LOG_FILE!"
for /f "skip=50 tokens=*" %%f in ('dir /b /o-d "!LOG_DIR!\!LOG_AGENT!_*.log" 2^>nul') do (
    del "!LOG_DIR!\%%f" 2>nul
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0copilot_wrapper_helper.ps1" "%OUTPUT_FILE%" "!RESULT_TYPE!" "!RESULT_SHAPE_FILE!"

if exist "!CACHE_SESSION_PATH!" (
    for %%f in ("!CACHE_SESSION_PATH!\*") do (
        move /y "%%f" "%SESSION_DIR%\" >nul 2>&1
    )
    for /d %%d in ("!CACHE_SESSION_PATH!\*") do (
        robocopy "%%d" "%SESSION_DIR%\%%~nxd" /E /MOVE /NFL /NDL /NJH /NJS >nul 2>&1
    )
    rmdir "!CACHE_SESSION_PATH!" 2>nul
)

del "%LOCK_FILE%" 2>nul

endlocal
