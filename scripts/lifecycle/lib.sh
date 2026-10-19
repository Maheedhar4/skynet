#!/usr/bin/env bash
#
# skynet startup lifecycle — shared library.
#
# Sourced by scripts/lifecycle.sh and the thin wrappers in scripts/lifecycle/.
# Holds everything mode-independent: repo-root discovery, pid/port tracking,
# npm dependency checks, the AUTH placeholder hook loader and the component
# start/stop/status/logs machinery.
#
# Runtime state lives in .run/lifecycle/ (gitignored):
#   .run/lifecycle/<component>.pid    session-leader pid (setsid)
#   .run/lifecycle/logs/<component>.log
#   .run/lifecycle/last-mode          last started mode
#
# AUTH PLACEHOLDER — skynet has no app auth yet. With-auth start modes load
# hook files from scripts/lifecycle/hooks/auth-*.sh before launching a
# component; no-auth modes never source them. See hooks/README.md.
# ─────────────────────────────────────────────────────────────────────────────

set -u

# ── paths ────────────────────────────────────────────────────────────────────
_LC_SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"  # scripts/lifecycle
REPO_ROOT="$(cd -- "$_LC_SELF_DIR/../.." && pwd)"
LC_DIR="$_LC_SELF_DIR"
LC_HOOKS="$LC_DIR/hooks"
LC_RUN="$REPO_ROOT/.run/lifecycle"
LC_LOGS="$LC_RUN/logs"
LC_NPM_CMD="npm"

if [ ! -f "$REPO_ROOT/apps/web/package.json" ] || [ ! -f "$REPO_ROOT/package.json" ]; then
  echo "stack: cannot locate the skynet repo root (expected apps/web workspace above $(dirname "$LC_DIR"))" >&2
  exit 1
fi

# ── tiny log helpers ─────────────────────────────────────────────────────────
say()  { printf '[stack] %s\n' "$*"; }
ok()   { printf '[stack] ✓ %s\n' "$*"; }
warn() { printf '[stack] ⚠ %s\n' "$*" >&2; }
die()  { printf '[stack] ✗ %s\n' "$*" >&2; exit 1; }

# ── ports ────────────────────────────────────────────────────────────────────
# The server parses the repo-root .env itself; the scripts only need to know
# which port to probe. Read SKYNET_API_PORT non-secretly from .env when the
# variable is not already exported. UI port is fixed: apps/web has no CLI
# port override wired up today (ng serve defaults to 4200).
api_port() {
  if [ -n "${SKYNET_API_PORT:-}" ]; then
    printf '%s\n' "$SKYNET_API_PORT"
    return 0
  fi
  local v
  if [ -f "$REPO_ROOT/.env" ]; then
    v="$(
      grep -E '^[[:space:]]*(export[[:space:]]+)?SKYNET_API_PORT[[:space:]]*=' "$REPO_ROOT/.env" 2>/dev/null |
        head -n 1 |
        sed -E "s/^[^=]*=*[[:space:]]*//; s/[[:space:]]*#.*$//; s/^['\"]//; s/['\"][[:space:]]*$//"
    )"
    case "${v:-}" in
      *[!0-9]* | '') : ;;
      *) printf '%s\n' "$v"; return 0 ;;
    esac
  fi
  printf '8080\n'
}
ui_port() { printf '4200\n'; }

# bash /dev/tcp probe — no lsof/nc/ss dependency on the hot path.
port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1" 2>/dev/null) 2>/dev/null
}

# ── pid tracking ─────────────────────────────────────────────────────────────
pid_file()   { printf '%s/%s.pid\n' "$LC_RUN" "$1"; }
log_file()   { printf '%s/%s.log\n' "$LC_LOGS" "$1"; }
pid_of()     { cat "$(pid_file "$1")" 2>/dev/null || true; }
component_port() {
  case "$1" in
    api) api_port ;;
    ui)  ui_port ;;
    *)   printf '' ;;
  esac
}

# Guard against pid-reuse disasters: the recorded pid must still have a
# cmdline that plausibly belongs to this component before any signal is sent.
# Note: modern npm rewrites its process title ("npm run dev"), so the generic
# launch forms are accepted fits too — the recorded pid is our own session
# leader either way, and this check only distinguishes it from pid reuse.
pid_plausible_for_component() {
  local comp="$1" pid="$2" cmd
  [ -r "/proc/$pid/cmdline" ] || return 1
  cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || echo '')"
  case "$comp:$cmd" in
    api:*) case "$cmd" in
             *apps/server* | *tsx* | *"npm run dev"* | *src/index.ts* | *esbuild*) return 0 ;;
             *) return 1 ;;
           esac ;;
    ui:*)  case "$cmd" in
             *apps/web* | *\.bin/ng* | *"npm run start"* | *"ng serve"* | *ng19* | *ng20*) return 0 ;;
             *) return 1 ;;
           esac ;;
    *) return 1 ;;
  esac
}

tracked_alive() {
  local comp="$1" pid
  pid="$(pid_of "$comp")"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # A dead session leader still answers kill -0 as a zombie for a moment.
  [ "$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null)" = "Z" ] && return 1
  return 0
}

# ── dependencies ─────────────────────────────────────────────────────────────
# Determine whether npm packages are needed for the requested components and
# install them if missing. Set LC_SKIP_INSTALL=1 to hard-fail instead.
ensure_npm_deps() { # $@ = component list (api ui)
  local comps="$*" need_api=0 need_ui=0 reason=""
  node -e 'process.stdout' 2>/dev/null || die "node not found on PATH (skynet needs Node >= 20)"
  [ -f "$REPO_ROOT/package-lock.json" ] || warn "no package-lock.json at repo root — expected in a committed monorepo"
  case " $comps " in
    *' api '*) { [ -d "$REPO_ROOT/node_modules" ] && [ -e "$REPO_ROOT/node_modules/tsx" ]; } || { need_api=1; reason="server deps (tsx, express, @google/genai …)"; } ;;
  esac
  case " $comps " in
    *' ui '*) { [ -d "$REPO_ROOT/node_modules" ] && [ -e "$REPO_ROOT/node_modules/@angular/core" ]; } || { need_ui=1; reason="web deps (@angular/*, rxjs …)"; } ;;
  esac
  if [ "$need_api" = 0 ] && [ "$need_ui" = 0 ]; then
    ok "packages: look installed — no npm install needed"
    return 0
  fi
  if [ "${LC_SKIP_INSTALL:-0}" = "1" ]; then
    die "packages missing ($reason) and LC_SKIP_INSTALL=1 — run: npm install"
  fi
  say "packages missing → running npm install at repo root ($reason)"
  (cd "$REPO_ROOT" && "$LC_NPM_CMD" install --no-audit --no-fund --loglevel=error) || {
    warn "npm install failed — see output above"
    return 1
  }
  case " $comps " in
    *' api '*) [ -e "$REPO_ROOT/node_modules/tsx" ] || { warn "tsx still missing after install"; return 1; } ;;
  esac
  case " $comps " in
    *' ui '*) [ -e "$REPO_ROOT/node_modules/@angular/core" ] || { warn "@angular/core still missing after install"; return 1; } ;;
  esac
  ok "npm packages installed"
}

# Warn (never fail) about the .env the server expects. Reads key names only —
# never prints values.
ensure_env_file() {
  if [ ! -f "$REPO_ROOT/.env" ]; then
    warn "no .env at repo root — booting with defaults; chat stays broken until you: cp .env.example .env (needs GEMINI_API_KEY)"
    return 0
  fi
  if ! grep -qE '^GEMINI_API_KEY=[^[:space:]]' "$REPO_ROOT/.env" 2>/dev/null; then
    warn ".env present but GEMINI_API_KEY looks empty — UI/server still boot; chat replies will surface the engine error"
  fi
}

# ── AUTH PLACEHOLDER ─────────────────────────────────────────────────────────
# Loaded before launching a component in an AUTH-stanza mode. Future auth
# should provide scripts/lifecycle/hooks/auth-*.sh scripts; they run with:
#   LC_STANZA=AUTH|NOAUTH  LC_COMPONENT=api|ui  LC_MODE=<mode>
# and may export env vars (e.g. SKYNET_AUTH_*) that the started process
# inherits. NOAUTH modes deliberately never source hooks.
load_auth_hooks() { # $1 = stanza  $2 = component  $3 = mode
  local stanza="$1" comp="$2" mode="$3" hook found=0
  if [ "$stanza" != "AUTH" ]; then
    say "auth: none requested (no-auth mode) — hooks skipped by design"
    return 0
  fi
  if [ ! -d "$LC_HOOKS" ]; then
    say "auth: PLACEHOLDER — no hooks/ directory; starting UNAUTHENTICATED (auth is not built yet)"
    return 0
  fi
  for hook in "$LC_HOOKS"/auth-*.sh; do
    [ -e "$hook" ] || continue
    found=1
    LC_STANZA="$stanza" LC_COMPONENT="$comp" LC_MODE="$mode" . "$hook"
  done
  if [ "$found" = 0 ]; then
    say "auth: PLACEHOLDER — no auth-*.sh hooks installed; starting UNAUTHENTICATED (see scripts/lifecycle/hooks/README.md)"
  else
    ok "auth hooks applied for $comp"
  fi
  return 0
}

# ── start/stop machinery ─────────────────────────────────────────────────────
banner() { # $1=component $2=mode  — separates runs inside a log file
  {
    printf '\n===== %s — mode=%s — %s =====\n' "$1" "$2" "$(date -Is)"
  } >>"$(log_file "$1")"
}

wait_ready() { # $1=component $2=pid $3=timeout-seconds
  local comp="$1" pid="$2" timeout="$3" port i
  port="$(component_port "$comp")"
  for ((i = 1; i <= timeout; i++)); do
    if port_open "$port"; then
      ok "$comp ready → http://localhost:$port (waited ${i}s)"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || {
      warn "$comp process (pid $pid) exited during startup — last lines of $(log_file "$comp"):"
      tail -n 40 "$(log_file "$comp")" >&2 || true
      return 1
    }
    sleep 1
  done
  warn "$comp did not open :$port within ${timeout}s (pid $pid alive — likely still building/starting; watch $(log_file "$comp"))"
  return 2
}

start_component() { # $1=component $2=mode $3=stanza
  local comp="$1" mode="$2" stanza="$3" port pid code waits

  port="$(component_port "$comp")"

  if tracked_alive "$comp"; then
    ok "$comp already running (tracked pid $(pid_of "$comp")) — nothing to do"
    return 0
  fi
  rm -f "$(pid_file "$comp")" 2>/dev/null || true

  if port_open "$port"; then
    warn ":$port is busy but no tracked pidfile — someone started $comp by hand (npm run dev / ng serve?)"
    warn "lifecycle will not duplicate it: stop that process first, or use: scripts/lifecycle.sh stop $comp"
    return 1
  fi

  mkdir -p "$LC_LOGS"
  case "$comp" in
    api) ensure_npm_deps api || return 1; ensure_env_file ;;
    ui)  ensure_npm_deps ui || return 1 ;;
  esac

  # AUTH placeholder hook point (before the process env exists).
  load_auth_hooks "$stanza" "$comp" "$mode" || return 1

  banner "$comp" "$mode"
  # Launch rule: the child records ITS OWN pid before exec'ing into the
  # session leader — `echo "$$"` runs in the exact process that becomes
  # setsid → npm, so the pidfile always names the session leader and
  # stop_component() can group-kill the whole tree by that pid.
  case "$comp" in
    api)
      code='echo "$$" >"$LC_PIDFILE"; cd "$LC_ROOT"; exec setsid nohup "$LC_NPM" run dev -w apps/server >>"$LC_LOGFILE" 2>&1 </dev/null'
      ;;
    ui)
      code='echo "$$" >"$LC_PIDFILE"; cd "$LC_ROOT"; exec setsid nohup "$LC_NPM" run start -w apps/web >>"$LC_LOGFILE" 2>&1 </dev/null'
      ;;
    *) die "unknown component: $comp" ;;
  esac
  LC_PIDFILE="$(pid_file "$comp")" LC_LOGFILE="$(log_file "$comp")" LC_ROOT="$REPO_ROOT" LC_NPM="npm" \
    bash -c "$code" &

  waits=0
  while :; do
    pid="$(pid_of "$comp")"
    [ -n "$pid" ] && break
    waits=$((waits + 1)); [ "$waits" -gt 20 ] && { warn "$comp: launcher never wrote $(pid_file "$comp")"; return 1; }
    sleep 0.1
  done
  say "$comp launching → session leader pid $pid, log $(log_file "$comp")"
  case "$comp" in
    ui) say "first UI start may take a couple of minutes (Angular cold build)" ;;
  esac

  local timeout=90
  [ "$comp" = "ui" ] && timeout=240
  case "$comp" in
    api) timeout="${LC_WAIT_API_SEC:-$timeout}" ;;
    ui)  timeout="${LC_WAIT_UI_SEC:-$timeout}" ;;
  esac

  wait_ready "$comp" "$pid" "$timeout"
  local rc=$?
  [ "$rc" = 0 ] && printf '%s %s\n' "$mode" "$(date -Is)" >"$LC_RUN/last-mode"
  return $rc
}

# Stop every process still alive in a given session (never signals ourselves).
sweep_session() { # $1=signal  $2=session id
  local victim sig="$1" sid="$2"
  for victim in $(ps -eo sid=,pid= 2>/dev/null | awk -v s="$sid" '$1==s {print $2}'); do
    case "$victim" in "$$" | "$BASHPID" | "$PPID") continue ;; esac
    kill -"$sig" "$victim" 2>/dev/null || true
  done
}

stop_component() { # $1=component
  local comp="$1" pid port i victim opened plausible
  pid="$(pid_of "$comp")"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    port="$(component_port "$comp")"
    if port_open "$port"; then
      warn "$comp: nothing recorded, but :$port is still serving (untracked/started manually) — NOT killing an unknown process; stop it yourself"
    else
      ok "$comp: not running"
      rm -f "$(pid_file "$comp")" 2>/dev/null || true
    fi
    return 0
  fi

  pid_plausible_for_component "$comp" "$pid" && plausible=1 || plausible=0
  if [ "$plausible" = 0 ]; then
    port="$(component_port "$comp")"
    if ! port_open "$port"; then
      warn "$comp: recorded pid $pid does not match this component and :$port is closed — cleaning up the stale pidfile without signaling anything"
      rm -f "$(pid_file "$comp")" 2>/dev/null || true
      return 0
    fi
    # Recognized service on the port but the recorded leader cmdline is
    # unrecognizable (pid reuse, or a shim replaced the leader): do NOT group-
    # signal that pid. Only sweep the leftover session members by SID.
    say "$comp: leader pid unrecognized but :$port still serving — sweeping its leftover session (SID=$pid) without touching the pid itself"
  else
    say "$comp: stopping session leader pid $pid …"
    kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  fi

  # Sweep stragglers in the leader's session (works even after the leader
  # died, e.g. an npm crash leaving tsx/node behind), skipping ourselves.
  sweep_session TERM "$pid"
  for ((i = 1; i <= 25; i++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    if [ "$plausible" = 1 ]; then
      say "$comp: still alive after 5s — sending SIGKILL to the group and session leftovers"
      kill -KILL -- -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
    sweep_session KILL "$pid"
  fi
  rm -f "$(pid_file "$comp")" 2>/dev/null || true
  opened=0
  for ((i = 1; i <= 15; i++)); do
    port="$(component_port "$comp")"
    port_open "$port" || { opened=0; break; }
    opened=1
    sleep 0.5
  done
  port="$(component_port "$comp")"
  if [ "$opened" = 1 ]; then
    warn "$comp: :$port still listening after stop — an untracked process may own it now (check with: ss -ltnp)"
  else
    ok "$comp stopped"
  fi
}

stop_targets() { # $@ = component names, or "all"
  local target
  if [ "${1:-all}" = "all" ]; then
    set -- api ui
  fi
  for target in "$@"; do
    case "$target" in
      api | ui) stop_component "$target" ;;
      *) die "stop: unknown target '$target' (want: all | api | ui)" ;;
    esac
  done
}

# ── modes ────────────────────────────────────────────────────────────────────
#   full-noauth → full stack, no auth   (UI + API)
#   full-auth   → full stack, with auth (UI + API)
#   api-noauth  → API only, no auth
#   api-auth    → API only, with auth
#   ui-noauth   → UI only, no auth
#   ui-auth     → UI only, with auth
mode_components() {
  case "$1" in
    full-noauth | full-auth) printf 'api ui\n' ;;
    api-noauth | api-auth) printf 'api\n' ;;
    ui-noauth | ui-auth) printf 'ui\n' ;;
    *) return 1 ;;
  esac
}
mode_stanza() {
  case "$1" in
    *-auth) printf 'AUTH\n' ;;
    *-noauth) printf 'NOAUTH\n' ;;
    *) return 1 ;;
  esac
}

mode_start() {
  local mode="${1:-}" comps stanza failed=0 c
  [ -n "$mode" ] || die "start: missing mode (want: full-noauth | full-auth | api-noauth | api-auth | ui-noauth | ui-auth)"
  comps="$(mode_components "$mode")" || die "unknown start mode: $mode (want: full-noauth | full-auth | api-noauth | api-auth | ui-noauth | ui-auth)"
  stanza="$(mode_stanza "$mode")"
  say "mode: $mode (components: $comps • auth stanza: $stanza)"
  mkdir -p "$LC_RUN" "$LC_LOGS"
  for c in $comps; do
    start_component "$c" "$mode" "$stanza" || failed=1
  done
  if [ "$failed" = 0 ]; then
    ok "mode '$mode' is up — scripts/lifecycle.sh status"
  else
    warn "mode '$mode' started with failures above — inspect: scripts/lifecycle/logs.sh"
    return 1
  fi
}

mode_restart() {
  local mode="${1:-}"
  [ -n "$mode" ] || die "restart: missing mode (want: full-noauth | full-auth | api-noauth | api-auth | ui-noauth | ui-auth)"
  say "restart → stopping whatever the lifecycle tracks, then starting '$mode'"
  stop_targets all
  mode_start "$mode"
}

# ── status ───────────────────────────────────────────────────────────────────
lifecycle_status() {
  local comp pid state p port_ok health
  local last_mode last_ts
  if [ -f "$LC_RUN/last-mode" ]; then
    last_mode="$(cut -d' ' -f1 "$LC_RUN/last-mode")"
    last_ts="$(cut -d' ' -f2- "$LC_RUN/last-mode")"
  fi
  say "skynet lifecycle status"
  [ -n "${last_mode:-}" ] && say "last started mode: $last_mode (at $last_ts)"
  for comp in api ui; do
    pid="$(pid_of "$comp")"
    if tracked_alive "$comp"; then
      state="running"
    elif [ -n "$pid" ]; then
      state="stale pidfile ($pid dead)"
    else
      state="not started by lifecycle"
    fi
    p="$(component_port "$comp")"
    if port_open "$p"; then port_ok=":$p listening"; else port_ok=":$p closed"; fi
    printf '  %-4s %-34s %s\n' "$comp" "$state" "$port_ok"
    if [ "$comp" = "api" ] && port_open "$p"; then
      health="$(curl -fsS --max-time 2 "http://127.0.0.1:$p/api/health" 2>/dev/null | head -c 300)"
      [ -n "$health" ] && printf '       api/health: %s\n' "$health"
    fi
  done
  return 0
}

# ── logs ─────────────────────────────────────────────────────────────────────
lifecycle_logs() {
  local target="${1:-}" f shown=0
  case "$target" in
    api | ui) set -- "$target" ;;
    '' | all) set -- api ui ;;
    *) die "logs: unknown target '$target' (want: all | api | ui)" ;;
  esac
  for f in "$@"; do
    [ -f "$(log_file "$f")" ] || continue
    say "── tail of $(log_file "$f") ──"
    tail -n 40 "$(log_file "$f")" || true
    shown=1
  done
  [ "$shown" = 1 ] || { warn "no lifecycle logs yet — start something first (scripts/lifecycle.sh start <mode>)"; return 1; }
}
