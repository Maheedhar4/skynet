#!/usr/bin/env bash
#
# skynet startup lifecycle — MODE 1 of 6
#
#   full-noauth — full stack with NO auth: UI (Angular :4200) + API (:8080)
#
# AUTH PLACEHOLDER: this is a no-auth mode — the AUTH hook loader is skipped
# by design and nothing auth-related runs or loads. When real auth lands in
# skynet, wire it via scripts/lifecycle/hooks/auth-*.sh (see hooks/README.md);
# no change to this file will be needed.
set -euo pipefail
DIR_SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR_SELF/../lifecycle.sh" start full-noauth "$@"
