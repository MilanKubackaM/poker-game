#!/usr/bin/env bash
# Beží NA VM (spúšťa ho deploy.sh cez SSH). Idempotentné — dá sa spustiť znova pri každom nasadení.
set -euo pipefail
DOMAIN="$1"
cd "$HOME/poker-game"

if ! command -v docker >/dev/null 2>&1; then
  echo "== Inštalujem Docker"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

# Malé VM (1 GB RAM) by pri builde klienta spadlo na pamäť — pridáme swap.
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ] && ! sudo swapon --show | grep -q swapfile; then
  echo "== Pridávam 2 GB swap"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# Oracle Ubuntu image má v iptables povolený len port 22 — otvoríme 80 a 443 (TCP aj UDP pre HTTP/3).
for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p udp --dport 443"; do
  if ! sudo iptables -C INPUT $rule -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 5 $rule -j ACCEPT
  fi
done
if command -v netfilter-persistent >/dev/null 2>&1; then
  sudo netfilter-persistent save >/dev/null
fi

echo "== Spúšťam hru na https://$DOMAIN"
sudo DOMAIN="$DOMAIN" docker compose -f deploy/oracle/docker-compose.cloud.yml up -d --build

if [ -f "$HOME/poker-data.tgz" ]; then
  echo "== Nahrávam uložené stoly z Macu"
  sudo DOMAIN="$DOMAIN" docker compose -f deploy/oracle/docker-compose.cloud.yml stop poker
  sudo docker run --rm -v poker-night_poker-data:/data -v "$HOME":/backup alpine sh -c 'cd /data && tar xzf /backup/poker-data.tgz && chown -R 1000:1000 /data'
  rm -f "$HOME/poker-data.tgz"
  sudo DOMAIN="$DOMAIN" docker compose -f deploy/oracle/docker-compose.cloud.yml start poker
fi

for _ in $(seq 1 60); do
  if curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" >/dev/null 2>&1; then
    echo "== HTTPS certifikát aj hra odpovedajú"
    break
  fi
  sleep 3
done
sudo docker ps --format '{{.Names}}  {{.Status}}'
echo "== Hotovo: https://$DOMAIN"
