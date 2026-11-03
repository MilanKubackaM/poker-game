#!/usr/bin/env bash
# Nasadí hru z Macu na Oracle VM. Použitie (z koreňa repozitára):
#   deploy/oracle/deploy.sh <verejná-IP-VM> [--ssh-key ~/.ssh/oracle] [--user ubuntu] [--with-data]
# --with-data skopíruje aj uložené stoly z lokálneho kontajnera poker-night (prepíše stoly na VM).
set -euo pipefail
IP=""; KEY=""; REMOTE_USER="ubuntu"; WITH_DATA=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-key) KEY="$2"; shift 2 ;;
    --user) REMOTE_USER="$2"; shift 2 ;;
    --with-data) WITH_DATA=1; shift ;;
    *) IP="$1"; shift ;;
  esac
done
[ -n "$IP" ] || { echo "Použitie: $0 <IP> [--ssh-key cesta] [--user ubuntu] [--with-data]"; exit 1; }
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
[ -n "$KEY" ] && SSH_OPTS+=(-i "$KEY")
# sslip.io: 129-153-1-2.sslip.io → 129.153.1.2, bez registrácie domény; Caddy na ňu vydá Let's Encrypt certifikát.
DOMAIN="${IP//./-}.sslip.io"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="$REMOTE_USER@$IP"

echo "== Kopírujem projekt na $TARGET"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude node_modules --exclude dist --exclude data --exclude .git --exclude docs/screenshots \
  "$ROOT/" "$TARGET:poker-game/"

if [ "$WITH_DATA" = 1 ]; then
  echo "== Balím uložené stoly z kontajnera poker-night"
  TMP="$(mktemp -d)"
  docker cp poker-night:/app/data "$TMP/data"
  tar czf "$TMP/poker-data.tgz" -C "$TMP/data" .
  scp "${SSH_OPTS[@]}" "$TMP/poker-data.tgz" "$TARGET:poker-data.tgz"
fi

ssh "${SSH_OPTS[@]}" "$TARGET" "bash poker-game/deploy/oracle/remote-setup.sh '$DOMAIN'"
echo "Hra: https://$DOMAIN"
