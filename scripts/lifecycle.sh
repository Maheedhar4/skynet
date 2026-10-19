#!/usr/bin/env bash
#
# skynet startup lifecycle — main dispatcher.
#
#   scripts/lifecycle.sh start   <mode>       start the stack for <mode>
#   scripts/lifecycle.sh restart <mode>       stop everything tracked, then start <mode>
#   scripts/lifecycle.sh stop    [api|ui|all] stop tracked components (default all)
#   scripts/lifecycle.sh status              current state (pids, ports, health)
#   scripts/lifecycle.sh logs    [api|ui|all] tail the last 40 lines of lifecycle logs
#
# Modes (6):
#   full-noauth   full stack, no auth    (api + ui)
#   full-auth     full stack, with auth  (api + ui)
#   api-noauth    api only, no auth
#   api-auth      api only, with auth
#   ui-noauth     ui only, no auth
#   ui-auth       ui only, with auth
#
# Thin wrappers exist in scripts/lifecycle/ (start-full-noauth.sh … stop.sh,
# status.sh, logs.sh) and as npm aliases (npm run stack:* — see package.json).
#
# "auth" is a PLACEHOLDER: skynet has no app auth yet. with-auth modes are
# identical to their no-auth siblings except that they source optional
# scripts/lifecycle/hooks/auth-*.sh files before launching. See
# scripts/lifecycle/hooks/README.md.
set -u
DIR_SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR_SELF/lifecycle/lib.sh"

usage() {
  cat <<'USAGE'
skynet startup lifecycle — main dispatcher

  scripts/lifecycle.sh start   <mode>       start the stack for <mode>
  scripts/lifecycle.sh restart <mode>       stop everything tracked, then start <mode>
  scripts/lifecycle.sh stop    [api|ui|all] stop tracked components (default all)
  scripts/lifecycle.sh status              current state (pids, ports, health)
  scripts/lifecycle.sh logs    [api|ui|all] tail the last 40 lines of lifecycle logs

Modes (6):
  full-noauth   full stack, no auth    (api + ui)
  full-auth     full stack, with auth  (api + ui)
  api-noauth    api only, no auth
  api-auth      api only, with auth
  ui-noauth     ui only, no auth
  ui-auth       ui only, with auth

Thin wrappers: scripts/lifecycle/start-full-noauth.sh … stop.sh, status.sh,
logs.sh — npm aliases: npm run stack:*, stack (see package.json).

"auth" is a PLACEHOLDER: skynet has no app auth yet. with-auth modes are
identical to their no-auth siblings except that they source optional
scripts/lifecycle/hooks/auth-*.sh files before launching. See
scripts/lifecycle/hooks/README.md.
USAGE
}

action="${1:-help}"
case "$action" in
  start)
    mode_start "${2:-}"
    ;;
  restart)
    mode_restart "${2:-}"
    ;;
  stop)
    # stop | stop api | stop ui | stop all
    if [ $# -gt 2 ]; then
      die "stop takes at most one target: all | api | ui"
    fi
    stop_targets "${2:-all}"
    ;;
  status)
    lifecycle_status
    ;;
  logs)
    shift || true
    lifecycle_logs "${1:-all}"
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    usage >&2
    die "unknown action: $action"
    ;;
esac
