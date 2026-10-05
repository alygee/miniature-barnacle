#!/bin/sh
# End-to-end: builds tg-ws-proxy and the plugin, sends one real message.
# Skipped (exit 0) unless E2E_TOKEN, E2E_API_ID, E2E_API_HASH and E2E_TO are set.
set -eu

for var in E2E_TOKEN E2E_API_ID E2E_API_HASH E2E_TO; do
  eval "value=\${$var:-}"
  if [ -z "$value" ]; then
    echo "e2e skipped: $var is not set"
    exit 0
  fi
done

cd "$(dirname "$0")"
trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
docker compose up --build --abort-on-container-exit --exit-code-from notify
