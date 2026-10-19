#!/usr/bin/env bash
#
# skynet startup lifecycle — MODE 5 of 6
#
#   api-auth — API only, WITH auth: Express server on :8080
#
# AUTH PLACEHOLDER: skynet has no auth yet. Runs the exact same API boot as
# api-noauth, but first sources optional
# scripts/lifecycle/hooks/auth-*.sh (LIFECYCLE.AUTH, api) so that when auth is
# built it plugs in here without touching the scripts again. Today the API
# starts UNAUTHENTICATED — expect a "PLACEHOLDER" note in the output while no
# hooks exist. See hooks/README.md for the future contract.
set -euo pipefail
DIR_SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR_SELF/../lifecycle.sh" start api-auth "$@"
