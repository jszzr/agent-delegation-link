#!/bin/sh
set -eu

: "${ADL_PUBLIC_BASE_URL:?Set ADL_PUBLIC_BASE_URL to the relay HTTPS origin}"

set -- relay \
  --host 0.0.0.0 \
  --port "${ADL_PORT:-8787}" \
  --public-base-url "$ADL_PUBLIC_BASE_URL" \
  --rate-limit "${ADL_RATE_LIMIT:-120}" \
  --trust-proxy

if [ -n "${ADL_RELAY_REGISTRATION_TOKEN:-}" ]; then
  set -- "$@" --registration-token-env ADL_RELAY_REGISTRATION_TOKEN
fi

exec node /app/dist/cli.js "$@"
