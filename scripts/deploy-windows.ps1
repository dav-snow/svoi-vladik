#requires -Version 5.1
<#
.SYNOPSIS
  Deploy the demo to the public stand over SSH from Windows, without WSL.

.DESCRIPTION
  Copies the repository (without .git/.venv/node_modules), writes /opt/svoi-vladik/.env,
  rebuilds the prod compose stack and waits for HTTPS. Requires an SSH key that the
  server already accepts and Docker on the server.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/deploy-windows.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/deploy-windows.ps1 -Key C:\Users\me\.ssh\svoi_deploy -DryRun
#>
[CmdletBinding()]
param(
    [string]$User = "tech",
    [string]$TargetHost = "176.53.253.60",
    [string]$Domain = "176-53-253-60.sslip.io",
    [string]$Email = "",
    [string]$Key = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "docker-compose.prod.yml"))) { throw "Запускайте из корня репозитория: $Root" }
if (-not $Email) { $Email = "tech@$Domain" }
$Dest = "$User@$TargetHost"
$Ssh = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new")
$Scp = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new")
if ($Key) { $Ssh += @("-i", $Key, "-o", "IdentitiesOnly=yes"); $Scp += @("-i", $Key, "-o", "IdentitiesOnly=yes") }

$localAnswers = Join-Path $Root "data/private/quest-answers.json"
$hasLocalAnswers = Test-Path $localAnswers
foreach ($required in @("docker-compose.prod.yml", "Caddyfile")) {
    if (-not (Test-Path (Join-Path $Root $required))) { throw "Нет обязательного файла: $required" }
}

function Show-Plan {
    Write-Host "1/7 ssh $Dest 'echo SSH_OK; docker --version; docker compose version'"
    Write-Host "2/7 tar --exclude=.git --exclude=.venv --exclude=node_modules ... -> svoi-vladik-deploy.tar.gz"
    Write-Host "3/7 scp архив -> ${Dest}:/tmp/"
    Write-Host "4/7 ssh: mkdir -p /opt/svoi-vladik && tar -xzf ..."
    Write-Host "5/7 ssh: записать /opt/svoi-vladik/.env (DOMAIN=$Domain, ACME_EMAIL=$Email)"
    Write-Host "6/7 ssh: docker compose -f docker-compose.prod.yml up -d --build && restart caddy"
    Write-Host "7/7 ждать https://$Domain/health, проверить сборку и заголовки безопасности"
    if (-not $hasLocalAnswers) { Write-Host "   (локального quest-answers.json нет — использую существующий на сервере)" }
}

if ($DryRun) { Show-Plan; Write-Host "DryRun: сеть не используется."; return }

function Invoke-Ssh([string]$Command) {
    & ssh @Ssh $Dest $Command
    if ($LASTEXITCODE -ne 0) { throw "ssh завершился с кодом ${LASTEXITCODE}: $Command" }
}

Write-Host "1/7 Проверяю SSH и Docker"
Invoke-Ssh "echo SSH_OK; hostname; docker --version; docker compose version"

if (-not $hasLocalAnswers) {
    Write-Host "Локального quest-answers.json нет; проверяю серверный"
    & ssh @Ssh $Dest "test -s /opt/svoi-vladik/data/private/quest-answers.json"
    if ($LASTEXITCODE -ne 0) {
        throw "Нет data/private/quest-answers.json ни локально, ни в /opt/svoi-vladik на сервере. Положите файл и повторите."
    }
}

Write-Host "2/7 Собираю архив"
$tar = Join-Path ([IO.Path]::GetTempPath()) "svoi-vladik-deploy.tar.gz"
if (Test-Path $tar) { Remove-Item $tar -Force }
& tar -czf $tar -C $Root `
    --exclude=.git --exclude=.venv --exclude=node_modules --exclude=__pycache__ `
    --exclude=.pytest_cache --exclude=frontend-design/review --exclude=.local `
    --exclude=.claude --exclude=.github --exclude=data/demo.sqlite3 --exclude="*.log" `
    --exclude=.env --exclude=backups .
if ($LASTEXITCODE -ne 0) { throw "tar завершился с кодом $LASTEXITCODE" }

Write-Host "3/7 Копирую на сервер"
& scp @Scp $tar "${Dest}:/tmp/svoi-vladik-deploy.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "scp завершился с кодом $LASTEXITCODE" }

Write-Host "4/7 Распаковываю"
Invoke-Ssh "mkdir -p /opt/svoi-vladik && tar -xzf /tmp/svoi-vladik-deploy.tar.gz -C /opt/svoi-vladik && rm -f /tmp/svoi-vladik-deploy.tar.gz"

Write-Host "5/7 Пишу .env"
Invoke-Ssh "printf 'DOMAIN=%s\nACME_EMAIL=%s\n' '$Domain' '$Email' > /opt/svoi-vladik/.env && chmod 600 /opt/svoi-vladik/.env"

Write-Host "6/7 Собираю и запускаю контейнеры"
Invoke-Ssh "cd /opt/svoi-vladik && docker compose -f docker-compose.prod.yml up -d --build"
# Bind-mounted Caddyfile changes do not reload Caddy by themselves.
Invoke-Ssh "cd /opt/svoi-vladik && docker compose -f docker-compose.prod.yml restart caddy"

Write-Host "7/7 Жду HTTPS (до 5 минут)"
$deadline = (Get-Date).AddMinutes(5)
$code = ""
do {
    Start-Sleep -Seconds 5
    try { $code = (& curl.exe -sS -m 10 -o NUL -w "%{http_code}" "https://$Domain/health" 2>$null) } catch { $code = "" }
    Write-Host "  health: $code"
} while ($code -ne "200" -and (Get-Date) -lt $deadline)
if ($code -ne "200") {
    throw "HTTPS не поднялся. Логи: ssh $Dest 'cd /opt/svoi-vladik && docker compose -f docker-compose.prod.yml logs --tail=80'"
}

Write-Host "Смоук:"
& curl.exe -sS "https://$Domain/health"; Write-Host ""
foreach ($path in @("/app.js", "/api/v1/places", "/api/v1/quest", "/assets/places/sukhanov-house--1.jpg")) {
    & curl.exe -sS -o NUL -w "$path -> %{http_code}`n" "https://$Domain$path"
}
$app = (& curl.exe -sS "https://$Domain/app.js") -join "`n"
$missing = @("placeCardThumbnail", "AVATAR_STORAGE", "/me/avatars") | Where-Object { $app -notmatch [regex]::Escape($_) }
if ($missing) { throw "На стенде старая сборка app.js; нет: $($missing -join ', ')" }
$places = Invoke-RestMethod "https://$Domain/api/v1/places"
if ($places.total -lt 14) { throw "API отдаёт $($places.total) мест вместо 14" }
$license = $places.items | ForEach-Object { $_.images } | Where-Object { $_.license_url } | Select-Object -First 1
if (-not $license) { throw "В API нет credit/license/license_url у фото" }
$headers = (& curl.exe -sSI "https://$Domain/") -join "`n"
foreach ($marker in @("Strict-Transport-Security", "X-Frame-Options: DENY", "Content-Security-Policy-Report-Only")) {
    if ($headers -notmatch [regex]::Escape($marker)) { throw "На стенде нет заголовка $marker" }
}
Write-Host "Сборка актуальна: 14 мест, фото с лицензией, синхронизация аватаров."
Write-Host "Заголовки безопасности: HSTS, X-Frame-Options, CSP Report-Only."
Write-Host "Готово: https://$Domain/"
