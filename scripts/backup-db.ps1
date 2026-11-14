#requires -Version 5.1
<#
.SYNOPSIS
  Copy the demo SQLite database from the public stand and keep the last N backups.

.DESCRIPTION
  Runs `docker compose cp` on the server into /opt/svoi-vladik/backups,
  then removes files older than N days. Does not stop the containers.
  Run it from any machine that has the SSH key for the server.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/backup-db.ps1 -DryRun

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/backup-db.ps1 -Key C:\Users\me\.ssh\svoi_deploy -Keep 14
#>
[CmdletBinding()]
param(
    [string]$User = "tech",
    [string]$TargetHost = "176.53.253.60",
    [string]$Key = "",
    [int]$Keep = 14,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Dest = "$User@$TargetHost"
$Ssh = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new")
if ($Key) { $Ssh += @("-i", $Key, "-o", "IdentitiesOnly=yes") }

# Single quotes keep $(date ...) for the remote shell.
$remote = 'cd /opt/svoi-vladik && mkdir -p backups && docker compose -f docker-compose.prod.yml cp api:/app/storage/demo.sqlite3 "backups/demo-$(date +%F-%H%M%S).sqlite3" && find backups -maxdepth 1 -name "demo-*.sqlite3" -mtime +' + $Keep + ' -delete && ls -1t backups | head -n 5'

if ($DryRun) {
    Write-Host ('ssh {0} "{1}"' -f $Dest, $remote)
    Write-Host "DryRun: сеть не используется."
    return
}

& ssh @Ssh $Dest $remote
if ($LASTEXITCODE -ne 0) { throw "Бэкап не выполнен: ssh завершился с кодом $LASTEXITCODE" }
Write-Host "Бэкап готов. Последние файлы перечислены выше; хранится не больше $Keep дней."
