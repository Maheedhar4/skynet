#!/usr/bin/env bash
#
# skynet startup lifecycle — MODE 6 of 6
#
#   ui-auth — UI only, WITH auth: Angular dev server on :4200
#
# Starts ONLY the Angular dev server (proxies /api and /callback to
# http://localhost:8080). The backend won't be running until an API mode is
# started as well.
#
# AUTH PLACEHOLDER: skynet has no auth yet. Runs the exact same UI boot as
# ui-noauth, but first sources optional
# scripts/lifecycle/hooks/auth-*.sh (LIFECYCLE.AUTH, ui) so that when auth is
# built it plugs in here without touching the scripts again. Today the UI
# starts UNAUTHENTICATED — expect a "PLACEHOLDER" note in the output while no
# hooks exist. See hooks/README.md for the future contract.
set -euo pipefail
DIR_SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR_SELF/../lifecycle.sh" start ui-auth "$@"
