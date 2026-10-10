param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$studioDir = $PSScriptRoot
$runtime = Join-Path $studioDir 'runtime\node.exe'
$serverScript = Join-Path $studioDir 'server.mjs'
$runningFile = Join-Path $studioDir 'data\running.json'
$studioHasher = [System.Security.Cryptography.SHA256]::Create()
$studioHashBytes = $studioHasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($studioDir.ToLowerInvariant()))
$studioInstance = ([System.BitConverter]::ToString($studioHashBytes).Replace('-', '').ToLowerInvariant()).Substring(0, 20)
$studioHasher.Dispose()
function Get-StudioAddress {
    if (Test-Path -LiteralPath $runningFile) {
        try {
            $running = Get-Content -LiteralPath $runningFile -Raw | ConvertFrom-Json
            $uri = 'http://127.0.0.1:' + $running.port
            $health = Invoke-RestMethod -Uri ($uri + '/api/health') -TimeoutSec 2
            if ($health.name -eq 'CodeStudio' -and $health.instance -eq $studioInstance) { return $uri }
        } catch { }
    }
    return $null
}
try {
    if (-not (Test-Path -LiteralPath $runtime)) { throw 'Bundled runtime missing. Please extract the complete ZIP first.' }
    if (-not (Test-Path -LiteralPath (Join-Path $studioDir 'dist\index.html'))) { throw 'Editor files missing. Please extract the complete ZIP first.' }
    $studioAddress = Get-StudioAddress
    if (-not $studioAddress) {
        New-Item -ItemType Directory -Force -Path (Join-Path $studioDir 'data') | Out-Null
        $stdoutLog = Join-Path $studioDir 'data\server.log'
        $stderrLog = Join-Path $studioDir 'data\server-error.log'
        $studioProcess = Start-Process -FilePath $runtime -ArgumentList @('"' + $serverScript + '"') -WorkingDirectory $studioDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
        for ($attempt = 0; $attempt -lt 80; $attempt++) {
            Start-Sleep -Milliseconds 200
            $studioAddress = Get-StudioAddress
            if ($studioAddress) { break }
            if ($studioProcess.HasExited) { throw ('Unable to start. See ' + $stderrLog) }
        }
        if (-not $studioAddress) { throw ('Startup timed out. See ' + $stderrLog) }
    }
    if (-not $NoBrowser) { Start-Process $studioAddress }
    Write-Host ('Code Studio: ' + $studioAddress)
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
