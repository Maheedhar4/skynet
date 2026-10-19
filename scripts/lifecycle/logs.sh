#!/usr/bin/env bash
#
# skynet startup lifecycle — logs.
#
#   logs.sh            tail (last 40 lines) of every lifecycle log
#   logs.sh api        only the API log
#   logs.sh ui         only the UI log
#
# To follow live: tail -F .run/lifecycle/logs/api.log
set -euo pipefail
DIR_SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR_SELF/../lifecycle.sh" logs "$@"
