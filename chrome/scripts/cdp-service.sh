#!/usr/bin/env bash
set -euo pipefail

LABEL="app.zavx0z.chrome-cdp"
UID_VALUE="$(/usr/bin/id -u)"
DOMAIN="gui/${UID_VALUE}"
SERVICE="${DOMAIN}/${LABEL}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR="${SCRIPT_DIR}/cdp-monitor.sh"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST="${PLIST_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/Chrome-CDP"
PORT="${CHROME_CDP_PORT:-9222}"
DATA_DIR="${CHROME_CDP_DATA_DIR:-${HOME}/Library/Application Support/Google/Chrome-CDP}"
START_URL="${CHROME_CDP_START_URL:-https://chatgpt.com/}"

usage() {
  cat <<EOF
Usage: $(basename "$0") install|start|stop|restart|status|uninstall
EOF
}

loaded() {
  /bin/launchctl print "${SERVICE}" >/dev/null 2>&1
}

cdp_ready() {
  /usr/bin/curl -sf --max-time 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null
}

wait_cdp() {
  local attempt
  for attempt in $(/usr/bin/seq 1 40); do
    if cdp_ready; then
      return 0
    fi
    /bin/sleep 1
  done
  return 1
}

xml_escape() {
  /usr/bin/sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

write_plist() {
  local monitor_xml log_out_xml log_err_xml port_xml data_dir_xml start_url_xml tmp

  monitor_xml="$(printf '%s' "${MONITOR}" | xml_escape)"
  log_out_xml="$(printf '%s' "${LOG_DIR}/stdout.log" | xml_escape)"
  log_err_xml="$(printf '%s' "${LOG_DIR}/stderr.log" | xml_escape)"
  port_xml="$(printf '%s' "${PORT}" | xml_escape)"
  data_dir_xml="$(printf '%s' "${DATA_DIR}" | xml_escape)"
  start_url_xml="$(printf '%s' "${START_URL}" | xml_escape)"
  tmp="${PLIST}.tmp.$$"

  /bin/mkdir -p "${PLIST_DIR}" "${LOG_DIR}"

  cat >"${tmp}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${monitor_xml}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CHROME_CDP_PORT</key>
    <string>${port_xml}</string>
    <key>CHROME_CDP_DATA_DIR</key>
    <string>${data_dir_xml}</string>
    <key>CHROME_CDP_START_URL</key>
    <string>${start_url_xml}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${log_out_xml}</string>
  <key>StandardErrorPath</key>
  <string>${log_err_xml}</string>
</dict>
</plist>
EOF

  /usr/bin/plutil -lint "${tmp}" >/dev/null
  /bin/mv "${tmp}" "${PLIST}"
}

start_service() {
  if [ ! -f "${PLIST}" ]; then
    printf 'Chrome CDP service is not installed. Run: %s install\n' "$(basename "$0")" >&2
    return 1
  fi

  if ! loaded; then
    /bin/launchctl bootstrap "${DOMAIN}" "${PLIST}"
  fi

  if wait_cdp; then
    printf 'Chrome CDP service running: %s, CDP ready on 127.0.0.1:%s\n' "${SERVICE}" "${PORT}"
    return 0
  fi

  printf 'Chrome CDP service is loaded, but CDP did not become ready on 127.0.0.1:%s\n' "${PORT}" >&2
  return 1
}

stop_service() {
  if loaded; then
    /bin/launchctl bootout "${SERVICE}"
    printf 'Chrome CDP service stopped: %s\n' "${SERVICE}"
  else
    printf 'Chrome CDP service already stopped: %s\n' "${SERVICE}"
  fi
}

install_service() {
  if [ ! -f "${MONITOR}" ]; then
    printf 'Missing monitor script: %s\n' "${MONITOR}" >&2
    return 1
  fi

  if loaded; then
    /bin/launchctl bootout "${SERVICE}"
  fi

  write_plist
  /bin/launchctl bootstrap "${DOMAIN}" "${PLIST}"

  if wait_cdp; then
    printf 'Installed %s\n' "${PLIST}"
    printf 'Monitor: %s\n' "${MONITOR}"
    printf 'CDP ready on 127.0.0.1:%s\n' "${PORT}"
    return 0
  fi

  printf 'Installed %s, but CDP did not become ready on 127.0.0.1:%s\n' "${PLIST}" "${PORT}" >&2
  return 1
}

status_service() {
  local launch_state cdp_state pid

  launch_state="stopped"
  cdp_state="down"
  pid="-"

  if loaded; then
    launch_state="loaded"
    pid="$(/bin/launchctl print "${SERVICE}" 2>/dev/null | /usr/bin/awk -F'= ' '/^[[:space:]]*pid = / {print $2; exit}')"
    [ -n "${pid}" ] || pid="-"
  fi

  if cdp_ready; then
    cdp_state="ready"
  fi

  printf 'service=%s pid=%s cdp=%s port=%s plist=%s monitor=%s\n' \
    "${launch_state}" "${pid}" "${cdp_state}" "${PORT}" "${PLIST}" "${MONITOR}"

  [ "${launch_state}" = "loaded" ] && [ "${cdp_state}" = "ready" ]
}

uninstall_service() {
  stop_service
  if [ -f "${PLIST}" ]; then
    /bin/rm -f "${PLIST}"
    printf 'Removed %s\n' "${PLIST}"
  else
    printf 'Chrome CDP service already uninstalled: %s\n' "${PLIST}"
  fi
}

case "${1:-}" in
  install)
    install_service
    ;;
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    start_service
    ;;
  status)
    status_service
    ;;
  uninstall)
    uninstall_service
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
