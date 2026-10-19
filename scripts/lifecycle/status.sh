#!/usr/bin/env bash
#
# skynet startup lifecycle — status.
#
# Shows: last mode started, per-component state (pid / port), API health when
# reachable. Exit code is always 0 — it's informational.
set -euo pipefail
DIR_SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR_SELF/../lifecycle.sh" status "$@"
