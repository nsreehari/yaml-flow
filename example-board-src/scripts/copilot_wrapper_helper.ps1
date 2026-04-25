# clean_copilot_output.ps1
# Cleans copilot CLI output: filters noise lines and stats footer.
# Called by copilot_wrapper.bat after copilot runs and after logging (raw log preserved).
#
# Usage: clean_copilot_output.ps1 <output_file> <result_type> [result_shape_file]
#   output_file       - file containing raw copilot output; overwritten with cleaned result
#   result_type=raw   - strip noise + stats, write plain text back to output_file
#   result_type=json  - extract first JSON object whose keys match result_shape;
#                       if result_shape_file is absent, accepts any valid JSON object
#   result_shape_file - (json result_type only) JSON file whose top-level keys are required in output
#
# raw  result_type: right for chat responses and task executor sources.
# json result_type: right for structured calls where the input contained {prompt, result_shape}.

param(
    [Parameter(Mandatory)][string]$OutputFile,
    [Parameter(Mandatory)][string]$ResultType,
    [string]$ResultShapeFile = ''
)

if (-not (Test-Path $OutputFile)) { exit 0 }

$raw = [IO.File]::ReadAllText($OutputFile, [Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

# --- Step 1: Filter noise lines ---
$lines = $raw -split "`r?`n" | Where-Object {
    $_ -notmatch "^error: unknown option '--no-warnings'" -and
    $_ -notmatch "^Try 'copilot --help' for more information"
}
$cleaned = ($lines -join "`n").Trim()

# --- Step 1b: Strip copilot-cli tool operation lines ---
# These are internal tool invocations that leak into output:
#   ● Create/Read/Edit/List directory/Glob/Check ...
#   X Read ... (failed tool ops)
#   $ Get-Content/Set-Content ... (PowerShell invocations)
#   └ N lines/files found
#   ├ ... (tree lines)
#   "The agent decision has been simulated and saved to ..."
#   session-state file paths
$noiseLines = New-Object System.Collections.Generic.List[string]
$contentLines2 = New-Object System.Collections.Generic.List[string]
foreach ($line in ($cleaned -split "`n")) {
    $t = $line.TrimStart()
    if ($t -match '^[\u25cf\u2022] ' -or           # ● bullet tool ops
        $t -match '^X ' -or                          # X failed tool ops
        $t -match '^\$ ' -or                         # $ shell commands
        $t -match '^[\u2514\u251c]' -or              # └ ├ tree lines
        $t -match 'session-state.*\.json' -or        # session-state file refs
        $t -match 'agent.decision has been simulated' -or
        $t -match 'has been simulated and saved' -or
        $t -match '^\d+ (files?|lines?|matches?) found$' -or  # "3 files found"
        $t -match '^No matches found$' -or
        $t -match '^Path does not exist$' -or
        $t -match '^\d+ lines?( read)?$') {          # "1 line read"
        $noiseLines.Add($line)
    } else {
        $contentLines2.Add($line)
    }
}
$cleaned = ($contentLines2 -join "`n").Trim()

# Write noise to sidecar file for upstream visibility
$NoiseFile = $OutputFile + '.noise'
if ($noiseLines.Count -gt 0) {
    $noiseContent = "STRIPPED_LINES=$($noiseLines.Count)`n" + ($noiseLines -join "`n")
    [IO.File]::WriteAllText($NoiseFile, $noiseContent, [Text.Encoding]::UTF8)
} elseif (Test-Path $NoiseFile) {
    Remove-Item $NoiseFile -Force
}

# --- Step 2: Strip trailing usage stats ---
$statsPrefixes = @('Total usage est:', 'API time spent:', 'Total session time:',
                    'Total code changes:', 'Breakdown by AI model:', 'Session:',
                    'Changes', 'Requests', 'Tokens')
$resultLines = New-Object System.Collections.Generic.List[string]
$hitStats = $false
foreach ($line in $cleaned -split "`n") {
    if (-not $hitStats) {
        foreach ($sp in $statsPrefixes) {
            if ($line.TrimStart().StartsWith($sp)) { $hitStats = $true; break }
        }
    }
    if (-not $hitStats) { $resultLines.Add($line) }
}
$cleaned = ($resultLines -join "`n").Trim()

# --- raw result_type: write cleaned plain text and exit ---
if ($ResultType -eq 'raw') {
    if ([string]::IsNullOrWhiteSpace($cleaned)) {
        [IO.File]::WriteAllText($OutputFile, '', [Text.Encoding]::UTF8)
    } else {
        [IO.File]::WriteAllText($OutputFile, $cleaned, [Text.Encoding]::UTF8)
    }
    exit 0
}

# --- json result_type: extract JSON object matching result_shape ---

# Load result_shape keys (if provided) to use as required-key filter
$shapeKeys = @()
if ($ResultShapeFile -and (Test-Path $ResultShapeFile)) {
    try {
        $shape = [IO.File]::ReadAllText($ResultShapeFile, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
        $shapeKeys = @($shape.PSObject.Properties.Name)
    } catch {}
}

if ([string]::IsNullOrWhiteSpace($cleaned)) {
    $fallback = if ($shapeKeys.Count -gt 0) {
        $obj = [ordered]@{}
        foreach ($k in $shapeKeys) { $obj[$k] = $null }
        $obj | ConvertTo-Json -Depth 2 -Compress
    } else { '{}' }
    [IO.File]::WriteAllText($OutputFile, $fallback, [Text.Encoding]::UTF8)
    exit 0
}

# Helper: check if a parsed object has all required shape keys
function Test-ShapeMatch($obj) {
    if ($shapeKeys.Count -eq 0) { return $true }  # no shape constraint — accept any JSON object
    foreach ($k in $shapeKeys) {
        if (-not $obj.PSObject.Properties[$k]) { return $false }
    }
    return $true
}

$foundJson = $null

# 1: Look in ```json fenced blocks first
if ($cleaned -match '(?s)```json\s*(.*?)```') {
    try {
        $obj = $Matches[1].Trim() | ConvertFrom-Json -ErrorAction Stop
        if (Test-ShapeMatch $obj) { $foundJson = $Matches[1].Trim() }
    } catch {}
}

# 2: Scan for bare JSON objects
if (-not $foundJson) {
    $depth = 0; $start = -1
    for ($i = 0; $i -lt $cleaned.Length; $i++) {
        if ($cleaned[$i] -eq '{') {
            if ($depth -eq 0) { $start = $i }
            $depth++
        } elseif ($cleaned[$i] -eq '}') {
            $depth--
            if ($depth -eq 0 -and $start -ge 0) {
                $candidate = $cleaned.Substring($start, $i - $start + 1)
                try {
                    $obj = $candidate | ConvertFrom-Json -ErrorAction Stop
                    if (Test-ShapeMatch $obj) {
                        $foundJson = $candidate
                        break
                    }
                } catch {}
                $start = -1
            }
        }
    }
}

if ($foundJson) {
    [IO.File]::WriteAllText($OutputFile, $foundJson, [Text.Encoding]::UTF8)
} else {
    # No matching JSON found — record raw in noise file, write shape-skeleton fallback
    $NoiseFile = $OutputFile + '.noise'
    $fallbackNoise = "FALLBACK=no_json_match`nSHAPE_KEYS=$($shapeKeys -join ',')`nRAW_LENGTH=$($cleaned.Length)`n---`n$cleaned"
    if (Test-Path $NoiseFile) {
        $existing = [IO.File]::ReadAllText($NoiseFile, [Text.Encoding]::UTF8)
        [IO.File]::WriteAllText($NoiseFile, "$existing`n$fallbackNoise", [Text.Encoding]::UTF8)
    } else {
        [IO.File]::WriteAllText($NoiseFile, $fallbackNoise, [Text.Encoding]::UTF8)
    }
    $fallback = if ($shapeKeys.Count -gt 0) {
        $obj = [ordered]@{}
        foreach ($k in $shapeKeys) { $obj[$k] = $null }
        $obj | ConvertTo-Json -Depth 2 -Compress
    } else { '{}' }
    [IO.File]::WriteAllText($OutputFile, $fallback, [Text.Encoding]::UTF8)
}
