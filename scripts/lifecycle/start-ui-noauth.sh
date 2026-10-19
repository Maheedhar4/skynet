#!/usr/bin/env bash
#
# skynet startup lifecycle — MODE 4 of 6
#
#   ui-noauth — UI only, no auth: Angular dev server on :4200
#
# Starts ONLY the Angular dev server (proxies /api and /callback to
# http://localhost:8080). Chat/pages that need the backend won't work until an
# API mode is started as well — that is the point of a UI-only boot.
#
# AUTH PLACEHOLDER: this is a no-auth mode — the AUTH hook loader is skipped
# by design. When real auth lands in skynet, wire it via
# scripts/lifecycle/hooks/auth-*.sh (see hooks/README.md).
set -euo pipefail
DIR_SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR_SELF/../lifecycle.sh" start ui-noauth "$@"
