#!/usr/bin/env bash
# Nasadí hru z Macu na NAS (SSH alias „nas“). Použitie z koreňa repozitára:
#   deploy/nas/deploy.sh [--host nas] [--dir /volume1/docker/poker-night] [--with-data] [--authkey tskey-...]
# --with-data prenesie stoly z lokálneho kontajnera poker-night (prepíše stoly na NAS).
# --authkey  jednorazový Tailscale auth kľúč pre prvé prihlásenie sidecaru (inak sa v logoch objaví prihlasovací odkaz).
# --setup-sudo  raz: povolí na NAS „sudo docker“ bez hesla pre tvojho používateľa (vypýta si sudo heslo na NAS).
# Príkaz pre docker sa zistí sám („docker“, ak si v skupine docker, inak „sudo -n docker“); prepíšeš ho cez NAS_DOCKER.
set -euo pipefail
HOST="nas"; DIR="/volume1/docker/poker-night"; WITH_DATA=0; AUTHKEY=""; SETUP_SUDO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --with-data) WITH_DATA=1; shift ;;
    --authkey) AUTHKEY="$2"; shift 2 ;;
    --setup-sudo) SETUP_SUDO=1; shift ;;
    *) echo "Neznámy parameter $1"; exit 1 ;;
  esac
done
# Mimo domu napr.: NAS_SSH_OPTS="-o HostName=<tailscale-ip> -o HostKeyAlias=<lan-ip>" (Tailscale IP, overí sa známy kľúč z LAN)
read -r -a SSH_EXTRA <<< "${NAS_SSH_OPTS:-}"
# LogLevel=ERROR skryje varovanie o post-quantum výmene kľúčov (starší OpenSSH na NAS), chyby ostávajú
ssh() { command ssh -o LogLevel=ERROR ${SSH_EXTRA[@]+"${SSH_EXTRA[@]}"} "$@"; }

if [ "$SETUP_SUDO" = 1 ]; then
  echo "== Povoľujem na $HOST „sudo docker“ bez hesla (zadaj sudo heslo NAS)"
  ssh -t "$HOST" 'set -e; BIN="$(command -v docker || true)"; BIN="${BIN:-/usr/bin/docker}"; RULE="/etc/sudoers.d/poker-night-docker"
    echo "$(id -un) ALL=(root) NOPASSWD: $BIN" | sudo tee "$RULE" >/dev/null
    sudo chmod 440 "$RULE"
    if ! sudo visudo -cf "$RULE" >/dev/null; then sudo rm -f "$RULE"; echo "Pravidlo sudo je neplatné, zrušené"; exit 1; fi
    echo "OK: $(id -un) smie spúšťať $BIN cez sudo bez hesla"'
fi

if [ -n "${NAS_DOCKER:-}" ]; then
  DOCKER="$NAS_DOCKER"
elif ssh "$HOST" 'docker info >/dev/null 2>&1'; then
  DOCKER="docker"
elif ssh "$HOST" 'sudo -n docker info >/dev/null 2>&1'; then
  DOCKER="sudo -n docker"
else
  echo "Na $HOST sa nedá spustiť docker bez hesla (cez SSH nemá sudo kde vypýtať heslo)."
  echo "Raz spusti:  deploy/nas/deploy.sh --setup-sudo   (vypýta si sudo heslo NAS), potom už len deploy/nas/deploy.sh"
  exit 1
fi
echo "== Docker na NAS: $DOCKER"
# macOS tar pridáva rozšírené atribúty (xattr), ktoré GNU tar na NAS hlási ako „unknown extended header“
TAR_EXTRA=()
if tar --version 2>/dev/null | grep -qi bsdtar; then
  TAR_EXTRA=(--no-xattrs --no-mac-metadata)
fi
export COPYFILE_DISABLE=1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE="$DOCKER compose -f deploy/nas/docker-compose.yml"

echo "== Kopírujem projekt na $HOST:$DIR"
tar ${TAR_EXTRA[@]+"${TAR_EXTRA[@]}"} -C "$ROOT" --exclude node_modules --exclude dist --exclude data --exclude .git --exclude docs/screenshots -czf - . \
  | ssh "$HOST" "mkdir -p '$DIR' && tar -xzf - -C '$DIR'"

echo "== Kontrolujem tajomstvá TURN v $DIR/deploy/nas/.env (len na NAS, nie v repozitári)"
ssh "$HOST" "bash '$DIR/deploy/nas/ensure-env.sh' '$DOCKER'"

echo "== Buildujem a spúšťam (typecheck + testy bežia v builde)"
ssh "$HOST" "cd '$DIR' && TS_AUTHKEY='$AUTHKEY' $COMPOSE up -d --build"

if [ "$WITH_DATA" = 1 ]; then
  echo "== Prenášam uložené stoly z Macu"
  TMP="$(mktemp -d)"
  docker cp poker-night:/app/data "$TMP/data"
  tar -C "$TMP/data" -czf - . | ssh "$HOST" "cd '$DIR' && $COMPOSE stop poker >/dev/null && \
    $DOCKER run --rm -i -v poker-night_poker-data:/data alpine:3.20 sh -c 'cd /data && tar -xzf - && chown -R 1000:1000 /data' && \
    $COMPOSE start poker >/dev/null"
fi

echo "== Stav"
ssh "$HOST" "$DOCKER ps --filter name=poker --format '{{.Names}}  {{.Status}}'; $DOCKER logs --tail 30 poker-tailscale 2>&1 | grep -Ei 'login|https://|funnel|error' | tail -5 || true"
echo "Verejná adresa: https://poker.<tvoj-tailnet>.ts.net (presne ju ukáže: ssh $HOST \"$DOCKER exec poker-tailscale tailscale serve status\")"
# Odkaz na sieťové štatistiky s kľúčom (kľúč je za #, takže nejde na server ani do logov)
ssh "$HOST" "cd '$DIR/deploy/nas' && DOMAIN=\$(sed -nE 's/^TURN_URLS=turns:([^:]+):.*/\\1/p' .env) && TOKEN=\$(sed -nE 's/^STATS_TOKEN=(.+)/\\1/p' .env) && [ -n \"\$DOMAIN\" ] && [ -n \"\$TOKEN\" ] && echo \"Štatistiky siete: https://\$DOMAIN/stats#key=\$TOKEN\"" || true
