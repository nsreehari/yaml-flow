@echo off
setlocal

:: Paths
set SCRIPT_DIR=%~dp0
set CLI=npx tsx %SCRIPT_DIR%..\..\src\cli\board-live-cards.ts
set BOARD=%SCRIPT_DIR%board-runtime
set CARDS=%SCRIPT_DIR%cards
set TMP_FILE=%BOARD%\tmp_file1

:: ============================================================
:: T0: Init board + add all 4 cards
:: ============================================================
echo === T0: Init board ===
if exist "%BOARD%" rmdir /s /q "%BOARD%"
%CLI% init "%BOARD%"

:: portfolio-form auto-completes (no sources, state has holdings)
%CLI% add-card --rg "%BOARD%" --card "%CARDS%\portfolio-form.json"

:: price-fetch fires immediately (portfolio-form provides 'holdings')
:: its source script (scripts/fetch-prices.js) polls tmp_file1 and writes to stdout
:: run-sources captures stdout and calls source-data-fetched to deliver prices.json
%CLI% add-card --rg "%BOARD%" --card "%CARDS%\price-fetch.json"

:: holdings-table waits for price-fetch to deliver prices.json
%CLI% add-card --rg "%BOARD%" --card "%CARDS%\holdings-table.json"

:: portfolio-value waits for holdings-table to provide 'table'
%CLI% add-card --rg "%BOARD%" --card "%CARDS%\portfolio-value.json"

:: ============================================================
:: T1: Write prices — simulates external market feed
::     fetch-prices.js is polling tmp_file1; writing here unblocks it
:: ============================================================
echo.
echo === T1: Writing T1 prices to tmp_file1 ===
echo {"AAPL":198.50,"MSFT":425.30,"GOOG":178.90,"AMZN":192.40,"TSLA":168.75} > "%TMP_FILE%"

:: Wait for cascade: price-fetch -> holdings-table -> portfolio-value
echo Waiting for T1 cascade to quiesce...
:wait_t1
timeout /t 2 /nobreak >nul
if exist "%TMP_FILE%" (
  for %%F in ("%TMP_FILE%") do if %%~zF GTR 0 goto wait_t1
)
timeout /t 3 /nobreak >nul
echo.
echo --- T1 Status ---
%CLI% status --rg "%BOARD%"

:: ============================================================
:: T2: Add GOOG (3rd holding) — update portfolio-form.json + restart
::     Use PowerShell to write well-formed JSON (avoids Windows echo quoting issues)
:: ============================================================
echo.
echo === T2: Adding GOOG (100 shares) ===
powershell -NoProfile -Command "$j = '{\"id\":\"portfolio-form\",\"meta\":{\"title\":\"Portfolio Holdings Form\"},\"provides\":[{\"bindTo\":\"holdings\",\"src\":\"state.holdings\"}],\"state\":{\"holdings\":[{\"symbol\":\"AAPL\",\"qty\":50},{\"symbol\":\"MSFT\",\"qty\":30},{\"symbol\":\"GOOG\",\"qty\":100}]},\"view\":{\"elements\":[{\"kind\":\"table\",\"label\":\"Holdings\",\"data\":{\"bind\":\"state.holdings\",\"columns\":[\"symbol\",\"qty\"]}}]}}'; [System.IO.File]::WriteAllText('%CARDS%\portfolio-form.json', $j)"

%CLI% update-card --rg "%BOARD%" --card-id portfolio-form --restart

:: price-fetch fires again — write fresh prices
timeout /t 1 /nobreak >nul
echo {"AAPL":198.50,"MSFT":425.30,"GOOG":178.90,"AMZN":192.40,"TSLA":168.75} > "%TMP_FILE%"

echo Waiting for T2 cascade to quiesce...
:wait_t2
timeout /t 2 /nobreak >nul
if exist "%TMP_FILE%" (
  for %%F in ("%TMP_FILE%") do if %%~zF GTR 0 goto wait_t2
)
timeout /t 3 /nobreak >nul
echo.
echo --- T2 Status ---
%CLI% status --rg "%BOARD%"

:: ============================================================
:: T3: Force price refresh (AAPL price changed)
::     retrigger price-fetch, write updated prices
:: ============================================================
echo.
echo === T3: Force price refresh — AAPL now 205.00 ===
%CLI% retrigger --rg "%BOARD%" --task price-fetch

timeout /t 1 /nobreak >nul
echo {"AAPL":205.00,"MSFT":425.30,"GOOG":178.90,"AMZN":192.40,"TSLA":168.75} > "%TMP_FILE%"

echo Waiting for T3 cascade to quiesce...
:wait_t3
timeout /t 2 /nobreak >nul
if exist "%TMP_FILE%" (
  for %%F in ("%TMP_FILE%") do if %%~zF GTR 0 goto wait_t3
)
timeout /t 3 /nobreak >nul
echo.
echo --- T3 Status ---
%CLI% status --rg "%BOARD%"

:: ============================================================
:: T4: Quiescent check
:: ============================================================
echo.
echo === T4: Final board status ===
%CLI% status --rg "%BOARD%"

endlocal
