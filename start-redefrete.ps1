$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 3000

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listeners) {
  Write-Host "Redefrete ja esta rodando na porta $Port."
  return
}

Start-Process -FilePath "node" `
  -ArgumentList "server.js" `
  -WorkingDirectory $ProjectDir `
  -RedirectStandardOutput (Join-Path $ProjectDir "server.log") `
  -RedirectStandardError (Join-Path $ProjectDir "server.err.log") `
  -WindowStyle Hidden

Start-Sleep -Seconds 3
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listeners) {
  Write-Host "Redefrete iniciado: http://localhost:$Port"
} else {
  Write-Host "Nao foi possivel confirmar a inicializacao. Veja server.err.log."
}
