#!/usr/bin/env bash
#
# skynet startup lifecycle — MODE 2 of 6
#
#   full-auth — full stack WITH auth: UI (Angular :4200) + API (:8080)
#
# AUTH PLACEHOLDER: skynet has no auth yet. Runs the exact same UI + API boot
# as full-noauth, but first sources optional
# scripts/lifecycle/hooks/auth-*.sh (LIFECYCLE.AUTH, api + ui) so that when
# auth is built it plugs in here without touching the scripts again. Today the
# stack starts UNAUTHENTICATED — expect a "PLACEHOLDER" note in the output
# while no hooks exist. See hooks/README.md for the future contract.
set -euo pipefail
DIR_SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR_SELF/../lifecycle.sh" start full-auth "$@"
