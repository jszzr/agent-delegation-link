#!/bin/sh
set -eu

: "${ADL_PUBLIC_BASE_URL:?Set ADL_PUBLIC_BASE_URL to the relay HTTPS origin}"

set -- relay \
  --host 0.0.0.0 \
  --port "${ADL_PORT:-8787}" \
  --public-base-url "$ADL_PUBLIC_BASE_URL" \
  --rate-limit "${ADL_RATE_LIMIT:-120}" \
  --trust-proxy

if [ -n "${ADL_ACCESS_FILE:-}" ]; then
  : "${ADL_RELAY_ADMIN_TOKEN:?Set ADL_RELAY_ADMIN_TOKEN when ADL_ACCESS_FILE is enabled}"
  set -- "$@" \
    --access-file "$ADL_ACCESS_FILE" \
    --admin-token-env ADL_RELAY_ADMIN_TOKEN
  if [ -n "${ADL_ACCESS_AUDIT_FILE:-}" ]; then
    set -- "$@" --access-audit-file "$ADL_ACCESS_AUDIT_FILE"
  fi
elif [ -n "${ADL_RELAY_REGISTRATION_TOKEN:-}" ]; then
  set -- "$@" --registration-token-env ADL_RELAY_REGISTRATION_TOKEN
fi

exec node /app/dist/cli.js "$@"
