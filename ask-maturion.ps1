# run-maturion.ps1 — runs local server and tests /messages
param(
  [string]$ProjectDir = ".",
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

function Info($m){ Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Ok($m){ Write-Host "[OK]   $m" -ForegroundColor Green }
function Warn($m){ Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Err($m){ Write-Host "[ERR]  $m" -ForegroundColor Red }

Set-Location $ProjectDir

# Load env from ../supabase.env if present
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $scriptDir "..\supabase.env"
if (Test-Path $envFile) {
  Info ("Loading env from {0}" -f (Resolve-Path $envFile))
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_.Trim() -eq "") { return }
    $n,$v = $_ -split '=',2
    if ($n -and $v) { [Environment]::SetEnvironmentVariable($n.Trim(), $v.Trim(), "Process") }
  }
} else {
  Warn ("No supabase.env found at {0}" -f $envFile)
}

# Ensure node/npm
try { $nv = node -v; $pv = npm -v; Ok ("Node {0} | npm {1}" -f $nv,$pv) } catch { Err "Install Node.js from https://nodejs.org/"; exit 1 }

# Install deps
Info "npm install..."
npm install | Out-Host

# Start server
$env:PORT = "$Port"
Info ("Starting server on http://localhost:{0}" -f $Port)
$proc = Start-Process node "server.js" -PassThru -NoNewWindow
Start-Sleep 2

# Wait for ready
$base = "http://localhost:$Port"
$ready = $false
for ($i=0; $i -lt 20; $i++) {
  try { if ((Invoke-WebRequest "$base/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 300 }
}
if (-not $ready) { Err ("Server did not become ready on {0}" -f $base); Stop-Process -Id $proc.Id -Force; exit 1 }
Ok ("Server ready at {0}" -f $base)

function TestEndpoint($label, $method, $uri, $jsonBody){
  try{
    if ($null -ne $jsonBody) {
      $r = Invoke-WebRequest -Uri $uri -Method $method -ContentType "application/json" -Body $jsonBody -UseBasicParsing
    } else {
      $r = Invoke-WebRequest -Uri $uri -Method $method -UseBasicParsing
    }
    $ct = $r.Headers["Content-Type"]
    $ok = ($r.StatusCode -eq 200) -and ($ct -match "application/json") -and ($r.Content -match '"result"')
    if ($ok) { Ok ("{0} PASS" -f $label) } else { Warn ("{0} CHECK status={1} ct={2} len={3}" -f $label, $r.StatusCode, $ct, ([Text.Encoding]::UTF8.GetByteCount($r.Content))) }
    return $r.Content
  } catch {
    Err ("{0} FAIL {1}" -f $label, $_.Exception.Message)
  }
}

Info "Test 1: POST /messages with JSON body"
$c1 = TestEndpoint "Test 1" "POST" "$base/messages" '{"ping":"pong"}'

Info "Test 2: POST /messages with empty body (fallback)"
$c2 = TestEndpoint "Test 2" "POST" "$base/messages" $null

Info "Preview of replies (first 200 chars)"
if ($c1) { Write-Host ("#1 -> " + $c1.Substring(0,[Math]::Min(200,$c1.Length))) }
if ($c2) { Write-Host ("#2 -> " + $c2.Substring(0,[Math]::Min(200,$c2.Length))) }

Info "Stop server now? (Y/N)"
$ans = Read-Host
if ($ans -notmatch '^(y|yes)$') { Info "Leaving server running" } else { Stop-Process -Id $proc.Id -Force; Info "Stopped" }
