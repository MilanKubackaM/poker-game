#!/usr/bin/env bash
# Beží NA NAS: doplní deploy/nas/.env (TURN_SECRET, TURN_URLS, STATS_TOKEN). Súbor ostáva len na NAS (práva 600), nie v repozitári.
# Kľúč Cloudflare TURN (CF_TURN_KEY_ID, CF_TURN_API_TOKEN) sa nevytvára — doplní sa ručne z Cloudflare → Realtime → TURN.
set -euo pipefail
DOCKER="${1:-docker}"
cd "$(dirname "$0")"
umask 077
touch .env
if ! grep -q '^TURN_SECRET=' .env; then
  echo "TURN_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> .env
fi
if ! grep -q '^STATS_TOKEN=' .env; then
  echo "STATS_TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> .env
fi
if ! grep -q '^CF_TURN_KEY_ID=.' .env || ! grep -q '^CF_TURN_API_TOKEN=.' .env; then
  echo "Cloudflare TURN nie je nastavený — kamery idú cez coturn (TCP cez Funnel). Doplň CF_TURN_KEY_ID a CF_TURN_API_TOKEN do .env"
fi
if ! grep -q '^TURN_URLS=' .env; then
  DOMAIN="$($DOCKER exec poker-tailscale tailscale status --json 2>/dev/null | grep -m1 '"DNSName"' | sed -E 's/.*"DNSName": *"([^"]*)\.".*/\1/' || true)"
  if [ -n "$DOMAIN" ]; then
    echo "TURN_URLS=turns:$DOMAIN:8443?transport=tcp" >> .env
  else
    echo "TURN_URLS zatiaľ chýba (Tailscale ešte nie je prihlásený) — po prihlásení spusti nasadenie znova"
  fi
fi
