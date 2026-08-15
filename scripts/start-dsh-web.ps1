# start-dsh-web.ps1 — one-click launcher for dsh web with the latest dsh.
#
# Uses a fixed port outside Windows' WinNAT reserved ranges (4035-4234 etc.)
# and opens the browser automatically. Restart dsh web after installing or
# upgrading plugins (host-half changes need a restart; this script is exactly
# that restart).
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\scripts\start-dsh-web.ps1
#         .\scripts\start-dsh-web.ps1            (from PowerShell)

$Port = 4500

# Pick the latest dsh (modlens and other modern plugins require >= latest rc).
$NpxArgs = @('-y', '@deepseek-ai/dsh@latest', 'web', '--port', "$Port")

# Reuse the user's existing profile (web) — plugins installed via
# `dsh plugin --profile web add ...` show up here.
Write-Host "Starting DeepSeek Harness web on http://127.0.0.1:$Port ..." -ForegroundColor Cyan

# Launch detached so the terminal stays usable; log output to temp.
$outLog = Join-Path $env:TEMP 'dsh-web-launch.out.log'
$errLog = Join-Path $env:TEMP 'dsh-web-launch.err.log'
Start-Process -FilePath 'npx.cmd' -ArgumentList $NpxArgs -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden

# Wait for the port, then open the browser.
$deadline = (Get-Date).AddSeconds(60)
$up = $false
while ((Get-Date) -lt $deadline) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        $up = $true
        break
    }
    Start-Sleep -Milliseconds 1000
}

if ($up) {
    Write-Host "Ready: http://127.0.0.1:$Port" -ForegroundColor Green
    Start-Process "http://127.0.0.1:$Port"
} else {
    Write-Host "Timed out waiting for the server. See log: $errLog" -ForegroundColor Red
    if (Test-Path $errLog) { Get-Content $errLog -Tail 20 }
}
