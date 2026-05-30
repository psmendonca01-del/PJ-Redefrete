$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Start-RedefreteApp {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$LogPrefix
  )

  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($listeners) {
    $localOnly = $listeners | Where-Object { $_.LocalAddress -eq "127.0.0.1" -or $_.LocalAddress -eq "::1" }
    if ($localOnly) {
      $processIds = $localOnly | Select-Object -ExpandProperty OwningProcess -Unique
      foreach ($processId in $processIds) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
      }
      Start-Sleep -Seconds 1
    } else {
      Write-Host "$Name ja esta rodando na porta $Port."
      return
    }
  }

  $env:HOST = "0.0.0.0"
  Start-Process -FilePath "node" `
    -ArgumentList "server.js" `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput (Join-Path $ProjectDir "$LogPrefix.log") `
    -RedirectStandardError (Join-Path $ProjectDir "$LogPrefix.err.log") `
    -WindowStyle Hidden

  Start-Sleep -Seconds 3
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($listeners) {
    Write-Host "$Name iniciado: http://localhost:$Port"
  } else {
    Write-Host "Nao foi possivel confirmar $Name. Veja $LogPrefix.err.log."
  }
}

Start-RedefreteApp -Port 3000 -Name "PJ-Redefrete" -WorkingDirectory $ProjectDir -LogPrefix "pj-redefrete"
Start-RedefreteApp -Port 3100 -Name "Reembolso de Despesas" -WorkingDirectory (Join-Path $ProjectDir "reembolso-despesas") -LogPrefix "reembolso-despesas"
