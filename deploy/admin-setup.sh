#!/usr/bin/env bash
# Einrichtungs-Link für die Admin-Oberfläche erzeugen (läuft `tandem-server admin setup <kennung>` im
# Container auf dem Server über die Portainer-Exec-API). Aufruf: deploy/admin-setup.sh [kennung]
set -euo pipefail
cd "$(dirname "$0")/.."
# Einstellungen aus deploy/local.env (Vorlage: deploy/local.env.example)
[ -f deploy/local.env ] && . deploy/local.env
: "${PORTAINER_URL:?PORTAINER_URL fehlt (deploy/local.env)}" "${PORTAINER_ENDPOINT:?PORTAINER_ENDPOINT fehlt}"
TOKEN_FILE=${PORTAINER_TOKEN_FILE:-~/.config/portainer/token}
T=$(cat "${TOKEN_FILE/#\~/$HOME}")
B=$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT/docker
USER_ID=${1:-${TANDEM_ADMIN_USER:?Kennung angeben}}
H=(-H "X-API-Key: $T" -H "Content-Type: application/json")
ID=$(curl -sS -X POST "${H[@]}" \
  -d "{\"Cmd\":[\"/tandem-server\",\"admin\",\"setup\",\"$USER_ID\"],\"AttachStdout\":true,\"AttachStderr\":true,\"Tty\":true}" \
  "$B/containers/tandem/exec" | python3 -c "import sys,json; print(json.load(sys.stdin)['Id'])")
curl -sS -X POST "${H[@]}" -d '{"Detach":false,"Tty":true}' "$B/exec/$ID/start"
echo
