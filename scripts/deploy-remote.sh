#!/usr/bin/env bash
# Deploy the demo to the server over SSH. Run from WSL:
#   bash scripts/deploy-remote.sh <user> <host> <domain> [email]
# Everything is copied to /opt/svoi-vladik on the server, then docker compose runs.
set -euo pipefail

USER_NAME="${1:?user}"
HOST="${2:?host}"
DOMAIN="${3:?domain}"
EMAIL="${4:-tech@$DOMAIN}"
APP_DIR=/opt/svoi-vladik
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10"

say() { printf '\n== %s ==\n' "$1"; }
fail() { printf '\nFAILED: %s\n' "$1" >&2; exit 1; }

say "1/7 ssh and docker"
$SSH "$USER_NAME@$HOST" true 2>/dev/null || fail "нет доступа по SSH-ключу. Сначала: ssh-copy-id $USER_NAME@$HOST"
if ! $SSH "$USER_NAME@$HOST" 'docker ps >/dev/null 2>&1'; then
  fail "docker недоступен пользователю $USER_NAME. Один раз выполните scripts/server-setup.sh на сервере и перезайдите"
fi
$SSH "$USER_NAME@$HOST" "docker compose version >/dev/null 2>&1" || fail "нет docker compose plugin на сервере"

say "2/7 checking deploy files"
[ -f "$REPO_DIR/docker-compose.prod.yml" ] || fail "нет docker-compose.prod.yml (сначала влей задачу 011)"
[ -f "$REPO_DIR/Caddyfile" ] || fail "нет Caddyfile (сначала влей задачу 011)"
[ -f "$REPO_DIR/data/private/quest-answers.json" ] || fail "нет data/private/quest-answers.json — без него квесты отдадут 503"

say "3/7 copying project to $HOST:$APP_DIR"
$SSH "$USER_NAME@$HOST" "mkdir -p $APP_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -az --delete \
    --exclude '.git' --exclude '.venv' --exclude 'node_modules' \
    --exclude '__pycache__' --exclude '.pytest_cache' --exclude '*.log' \
    --exclude 'data/demo.sqlite3' --exclude 'frontend-design/review' \
    "$REPO_DIR"/ "$USER_NAME@$HOST:$APP_DIR/"
else
  tar -C "$REPO_DIR" --exclude=.git --exclude=.venv --exclude=node_modules \
    --exclude=__pycache__ --exclude=data/demo.sqlite3 -czf - . \
    | $SSH "$USER_NAME@$HOST" "tar -xzf - -C $APP_DIR"
fi

say "4/7 writing .env on the server"
$SSH "$USER_NAME@$HOST" "cat > $APP_DIR/.env <<'ENV'
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
ENV
chmod 600 $APP_DIR/.env"

say "5/7 building and starting"
$SSH "$USER_NAME@$HOST" "cd $APP_DIR && docker compose -f docker-compose.prod.yml up -d --build"

say "6/7 waiting for HTTPS"
ok=0
for _ in $(seq 1 40); do
  if curl -fsS --max-time 5 "https://$DOMAIN/health" 2>/dev/null | grep -q '"status"'; then
    ok=1
    break
  fi
  sleep 5
done
if [ "$ok" != "1" ]; then
  echo "HTTPS ещё не поднялся. Частые причины:"
  echo " - A-запись $DOMAIN не указывает на $HOST (проверьте: nslookup $DOMAIN)";
  echo " - порт 80 закрыт файрволом (Caddy проверяет домен через него);"
  echo " - посмотрите логи: ssh $USER_NAME@$HOST 'cd $APP_DIR && docker compose -f docker-compose.prod.yml logs --tail=50'"
  exit 2
fi

say "7/7 smoke"
curl -fsS "https://$DOMAIN/health"; echo
curl -fsS "https://$DOMAIN/api/v1/places" | head -c 120; echo
curl -fsS "https://$DOMAIN/api/v1/quest"  | head -c 120; echo

echo
echo "OK: https://$DOMAIN/"
echo "Ответы квестов: $(curl -s -o /dev/null -w '%{http_code}' -X POST "https://$DOMAIN/api/v1/quest/quest-three-keys/answer" -H 'Content-Type: application/json' -d '{"stop_id":"keys-house","option_id":"a"}') (200 — ключи на месте, 503 — файла ответов нет)"
