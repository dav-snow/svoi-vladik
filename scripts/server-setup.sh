#!/usr/bin/env bash
# One-time server preparation. Run ONCE on the server (interactive sudo).
# Installs Docker, adds the deploy user to the docker group and creates the app dir.
set -euo pipefail

APP_DIR=/opt/svoi-vladik
DEPLOY_USER="${1:-tech}"

echo "== 1/4 checking sudo =="
sudo -v

echo "== 2/4 installing docker if missing =="
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl gnupg rsync
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  echo "docker installed"
else
  echo "docker already present: $(docker --version)"
fi

echo "== 3/4 adding $DEPLOY_USER to docker group =="
sudo usermod -aG docker "$DEPLOY_USER" || true
echo "NOTE: logout/login may be required for the group to apply"

echo "== 4/4 preparing $APP_DIR =="
sudo mkdir -p "$APP_DIR"
sudo chown "$DEPLOY_USER":"$DEPLOY_USER" "$APP_DIR"

echo
echo "DONE. Next:"
echo "  1) log out and back in so the docker group applies"
echo "  2) check: docker ps"
echo "  3) then run deploy.cmd from the developer machine"
