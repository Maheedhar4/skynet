#!/usr/bin/env bash
#
# skynet startup lifecycle — MODE 3 of 6
#
#   api-noauth — API only, no auth: Express server on :8080 (no UI on :4200)
#
# AUTH PLACEHOLDER: this is a no-auth mode — the AUTH hook loader is skipped
# by design and nothing auth-related runs or loads. When real auth lands in
# skynet, wire it via scripts/lifecycle/hooks/auth-*.sh (see hooks/README.md).
# UI-only start works standalone; /api calls from a UI you open by hand will
# fail until the API (this script) is running anyway.
set -euo pipefail
DIR_SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR_SELF/../lifecycle.sh" start api-noauth "$@"
