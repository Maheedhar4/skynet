#!/usr/bin/env bash
#
# skynet startup lifecycle — stop tracked services.
#
#   stop.sh            stop everything the lifecycle started (api + ui)
#   stop.sh api        stop just the API
#   stop.sh ui         stop just the UI
#
# Never kills processes it didn't track (warns instead).
set -euo pipefail
DIR_SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR_SELF/../lifecycle.sh" stop "$@"
