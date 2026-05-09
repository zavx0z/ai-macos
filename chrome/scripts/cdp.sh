#!/usr/bin/env bash
# Перезапуск Google Chrome с --remote-debugging-port=9222
# для перехода @meta/chrome в CDP-режим.

set -e

PORT="${CHROME_CDP_PORT:-9222}"
# Chrome 137+ запрещает --remote-debugging-port с дефолтным профилем,
# поэтому используем отдельный user-data-dir рядом с дефолтным.
DATA_DIR="${CHROME_CDP_DATA_DIR:-$HOME/Library/Application Support/Google/Chrome-CDP}"
G='\033[32m'; Y='\033[33m'; R='\033[31m'; D='\033[2m'; X='\033[0m'

# Если CDP уже работает на нужном порту — ничего не делаем
if curl -sf "http://localhost:${PORT}/json/version" > /dev/null; then
  printf "${G}✓${X} Chrome уже работает с --remote-debugging-port=${PORT}\n"
  exit 0
fi

printf "${D}user-data-dir: ${DATA_DIR}${X}\n"
mkdir -p "${DATA_DIR}"

# Запускаем отдельный экземпляр Chrome с CDP-флагами и своим профилем,
# не трогая основной Chrome пользователя.
printf "${D}запуск Chrome с --remote-debugging-port=${PORT}...${X}\n"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port="${PORT}" \
  --user-data-dir="${DATA_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  > /dev/null 2>&1 &
disown

# Ждём пока CDP поднимется (до ~9 с)
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/json/version" > /dev/null; then
    BROWSER=$(curl -sf "http://localhost:${PORT}/json/version" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Browser",""))' 2>/dev/null || echo "")
    printf "${G}✓${X} Chrome запущен с --remote-debugging-port=${PORT}"
    [ -n "$BROWSER" ] && printf "  ${D}(${BROWSER})${X}"
    printf "\n"
    exit 0
  fi
  sleep 0.3
done

printf "${Y}!${X} Chrome открыт, но CDP не отвечает на :${PORT}.\n"
printf "${D}  Возможные причины: Chrome ещё инициализируется (повторите curl http://localhost:${PORT}/json/version),${X}\n"
printf "${D}  или нужно открыть хотя бы одну вкладку.${X}\n"
exit 1
