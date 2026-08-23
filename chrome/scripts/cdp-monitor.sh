#!/usr/bin/env bash
set -euo pipefail

PORT="${CHROME_CDP_PORT:-9222}"
DATA_DIR="${CHROME_CDP_DATA_DIR:-$HOME/Library/Application Support/Google/Chrome-CDP}"
START_URL="${CHROME_CDP_START_URL:-https://chatgpt.com/}"

mkdir -p "$DATA_DIR"

cdp_ready() {
  /usr/bin/curl -sf --max-time 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null
}

while true; do
  if cdp_ready; then
    /bin/sleep 2
    continue
  fi

  /usr/bin/open -na "Google Chrome" --args \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="${PORT}" \
    --user-data-dir="${DATA_DIR}" \
    --no-first-run \
    --no-default-browser-check \
    "${START_URL}"

  for _ in $(/usr/bin/seq 1 30); do
    cdp_ready && break
    /bin/sleep 1
  done

  /bin/sleep 2
done
