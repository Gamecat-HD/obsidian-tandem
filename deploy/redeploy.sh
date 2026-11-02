#!/usr/bin/env bash
# tandem-server auf dem Server aktualisieren – ohne Portainer-Stack-Update (das hängt dort zurzeit):
# statischen Binary bauen → Image auf dem Server bauen → Container per Docker-API mit gleicher Konfiguration
# neu erstellen. Wird der neue Container nicht „healthy“, kommt automatisch der alte zurück.
set -euo pipefail
cd "$(dirname "$0")/.."
# Einstellungen aus deploy/local.env (Vorlage: deploy/local.env.example)
[ -f deploy/local.env ] && . deploy/local.env
: "${PORTAINER_URL:?PORTAINER_URL fehlt (deploy/local.env)}" "${PORTAINER_ENDPOINT:?PORTAINER_ENDPOINT fehlt}"
TOKEN_FILE=${PORTAINER_TOKEN_FILE:-~/.config/portainer/token}
T=$(cat "${TOKEN_FILE/#\~/$HOME}")
B=$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT/docker
: "${TANDEM_PUBLIC_URL:?TANDEM_PUBLIC_URL fehlt}"
# Nie zwei Deploys gleichzeitig (mehrere Sitzungen deployen): der zweite wartet auf den ersten.
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/tandem-redeploy.lock"
flock 9
H=(-H "X-API-Key: $T" -H "Content-Type: application/json")
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

server/build-static.sh >/dev/null
VER=$(grep -m1 '^version' server/Cargo.toml | cut -d'"' -f2)
mkdir -p "$W/ctx/data"
cp deploy/Dockerfile.prebuilt "$W/ctx/Dockerfile"
cp server/target/x86_64-unknown-linux-musl/release/tandem-server "$W/ctx/"
tar -C "$W/ctx" -cf "$W/ctx.tar" Dockerfile tandem-server data
echo "Image bauen (tandem-server:$VER) …"
curl -sS -X POST -H "X-API-Key: $T" -H "Content-Type: application/x-tar" --data-binary @"$W/ctx.tar" \
  "$B/build?t=tandem-server:latest&t=tandem-server:$VER&rm=1" | grep -q "Successfully tagged" || { echo "Build fehlgeschlagen"; exit 1; }

curl -sS "${H[@]}" "$B/containers/tandem/json" > "$W/old.json"
TANDEM_PUBLIC_URL=$TANDEM_PUBLIC_URL python3 - "$W" <<'PY'
import json, os, sys
W = sys.argv[1]
d = json.load(open(f"{W}/old.json"))
hc = d["HostConfig"]
env = [e for e in d["Config"]["Env"] if not e.startswith("TANDEM_PUBLIC_URL=")] + ["TANDEM_PUBLIC_URL=" + os.environ["TANDEM_PUBLIC_URL"]]
keep = {k: hc[k] for k in ["Binds", "PortBindings", "RestartPolicy", "Memory", "PidsLimit", "ReadonlyRootfs", "SecurityOpt", "CapDrop", "Mounts", "LogConfig", "NetworkMode"] if hc.get(k) is not None}
cfg = {"Image": "tandem-server:latest", "Tty": True, "OpenStdin": True, "Env": env, "User": d["Config"]["User"],
       "Labels": d["Config"]["Labels"], "ExposedPorts": d["Config"]["ExposedPorts"], "Healthcheck": d["Config"].get("Healthcheck"), "HostConfig": keep,
       "NetworkingConfig": {"EndpointsConfig": {n: {"Aliases": v.get("Aliases") or ["tandem"]} for n, v in d["NetworkSettings"]["Networks"].items()}}}
json.dump(cfg, open(f"{W}/create.json", "w"))
PY
echo "Container austauschen …"
curl -sS -o /dev/null -X POST "${H[@]}" -d '{}' "$B/containers/tandem/stop?t=10"
curl -sS -o /dev/null -X POST "${H[@]}" -d '{}' "$B/containers/tandem/rename?name=tandem-alt"
curl -sS -o /dev/null -X POST "${H[@]}" --data @"$W/create.json" "$B/containers/create?name=tandem"
curl -sS -o /dev/null -X POST "${H[@]}" -d '{}' "$B/containers/tandem/start"
for i in $(seq 1 30); do
  st=$(curl -sS "${H[@]}" "$B/containers/tandem/json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['State'].get('Health',{}).get('Status','?'))")
  [ "$st" = healthy ] && break
  sleep 2
done
if [ "$st" != healthy ]; then
  echo "Neuer Container nicht healthy ($st) → alter Container zurück"
  curl -sS -o /dev/null -X DELETE "${H[@]}" "$B/containers/tandem?force=1"
  curl -sS -o /dev/null -X POST "${H[@]}" -d '{}' "$B/containers/tandem-alt/rename?name=tandem"
  curl -sS -o /dev/null -X POST "${H[@]}" -d '{}' "$B/containers/tandem/start"
  exit 1
fi
curl -sS -o /dev/null -X DELETE "${H[@]}" "$B/containers/tandem-alt"
echo "tandem-server $VER läuft (healthy)."
