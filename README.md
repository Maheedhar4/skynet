# skynet

Claude-style local chat app whose brain talks to **quick-commerce MCP servers** — starting with
**Zepto** (groceries & essentials in ~10 minutes, real deliveries). Connect once through the
"Connect to Quick Commerce MCPs" sheet, watch the connector dot go green, then just ask:

> *"find me chennai-grown tomatoes under ₹40 and start a cart"*

npm workspaces monorepo:

| Workspace | What it is |
|---|---|
| `apps/web` | Angular 20 standalone chat UI — streaming bubbles, tool-activity chips, connector dots |
| `apps/server` | Node + TypeScript Express brain — OAuth 2.1, MCP client, Gemini agent, order gate |

```text
          ┌──────────── apps/web (Angular, :4200 dev proxy → :8080) ────────────┐
 browser ─┤  chat composer · streaming deltas · tool chips · confirmation card  │
          └────────────── /api    ───────────┬────────────── /callback ────────┘
                                             │                       ┌─ :4180 ──┐
          ┌──────────── apps/server (Express) ┴───────────────────────┤  http     │
          │  ChatService ─► Gemini (direct @google/genai loop or ADK) │  callback │
          │      │                                                    └─────┬─────┘
          │      │  tools ──► MCP Streamable HTTP client ──► https://mcp.zepto.co.in
          │  OAuth 2.1: discovery → dynamic registration → PKCE → Zepto login (OTP)
          │  tokens: ~/.skynet (0600)            history: ~/.skynet (0600)
          └──────────────────────────────────────────────────────────────────────────
```

## Quick start

```bash
npm install                 # installs both workspaces at the root
npm run -w apps/server smoke   # optional offline sanity check of the brain + order gate

cp .env.example .env        # then put a key in GEMINI_API_KEY (see below)
npm run dev                 # server :8080 + Angular dev server :4200 (proxied /api)
```

Open **http://localhost:4200** → press **"Connect to Quick Commerce MCPs"** → Zepto in the sheet
→ a browser tab opens the Zepto login (Indian mobile + OTP) → approve, come back, dot goes green.

Prefer a single origin (no dev server)? Build the web app and let Express serve it:

```bash
npm run build:web
npm run start:server        # http://localhost:8080 serves the SPA + API
```

### Getting a Gemini API key

The chat brain needs a Google AI Studio key (the free tier is enough):

1. Open https://aistudio.google.com/apikey and create a key.
2. Put it in `.env`: `GEMINI_API_KEY=...` — `.env` is gitignored, never commit it.

Without a key the app still boots and the UI works; chat replies surface the engine error.

## The callback port (read this if connect fails)

Zepto validates the OAuth `redirect_uri` **exact-match** against the URIs
registered for the client — authorizing `http://localhost:4180/callback` with a
client registered for `http://localhost/callback` bounces with
`uri_not_registered_for_client` (verified live; no RFC 8252 port leniency). But
`/register` **accepts ported URIs** (verified live 2026-10), so skynet's default
covers both truths root-free: at connect time it registers
`http://localhost:<callbackPort>/callback` and serves `/callback` on that same
plain port — **default 4180, no sudo, no capabilities** — and Zepto redirects
your browser straight there after the OTP + consent screens. Whatever else owns
port 80 (Ubuntu ships apache2 on it) stays untouched.

Only if you deliberately register a **port-less** URI
(`SKYNET_ZEPTO_REDIRECT_URI=http://localhost/callback` — the URI implies port 80)
does the old privilege problem return. Then pick any one of:

```bash
# Option A — one-shot capability on the node binary (no sudo at runtime):
sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")"

# Option B — dedicated port ACL helper:
sudo apt install authbind
sudo touch /etc/authbind/byport/80 && sudo chmod 777 /etc/authbind/byport/80
# then start the server under the helper:  authbind --deep npm run dev:server

# Option C — redirect at the firewall, keep the app unprivileged:
sudo iptables -t nat -A OUTPUT -p tcp -d 127.0.0.1 --dport 80 -j REDIRECT --to-ports 4180
#   …with SKYNET_ZEPTO_REDIRECT_URI pointing at that localhost/callback URI

# Option D — if something else already owns :80 (e.g. apache2 on Ubuntu):
sudo systemctl stop apache2 && sudo systemctl disable apache2   # or nginx
```

skynet logs a warning and keeps running if the callback port can't be bound — **no dead end**:

### Paste fallback (no privileges required)

Even if the redirect dead-ends (listener down, port repurposed, callback
unreachable), the login completes through the escape hatch:

1. Press Connect — Zepto login opens in a new tab.
2. After approving, the redirect lands on the callback URL, e.g.
   `http://localhost:4180/callback?code=…&state=…`.
3. If that tab shows a connection refused / some other service's default page,
   **copy the full URL** from the browser address bar and paste it into the
   "having trouble?" field in the connector sheet (ASCII escape hatch:
   `POST /api/connectors/:id/paste-callback`).
4. skynet finishes the token exchange and the dot goes green like normal.

Disable via `SKYNET_ALLOW_PASTE_FALLBACK=0` if you don't want the field shown.

## What connect actually does

| Step | Detail |
|---|---|
| 1 | RFC 8414 + RFC 9728 discovery — AS metadata + resource metadata fetched live |
| 2 | Dynamic client registration against `auth.zepto.co.in` (`/register`) |
| 3 | PKCE (S256) authorize URL opened in the browser, state stored in `~/.skynet` |
| 4 | You log in with Indian mobile + OTP at Zepto |
| 5 | `GET /callback?code=…&state=…` on the **callback port** (default 4180, unprivileged) matches the state and completes the code exchange |
| 6 | Tokens land in `~/.skynet/*tokens.json` (mode **0600**, atomic writes, never in the repo) |
| 7 | MCP Streamable HTTP handshake + `tools/list` → the connector dot turns **green** |
| 8 | On every later restart the refresh token silently reconnects — *no login again* |

Disconnect hits `/revoke` server-side, deletes the token files, and the dot goes red —
red is "just press Connect again", never a dead end.

## Order gate (real money)

Checkout/order placement tools are zero-trust: the agent **must stop and show a confirmation
card** before it touches anything that spends money. Reply `yes` (or `no`) in chat; nothing
runs until you do. Read-only tools (search, catalog, location, cart view, order history) run
directly without prompting.

- Gate classification: `SKYNET_CONFIRM_TOOL_RE` env regex overrides the built-in
  order-verb/checkout name heuristics.
- `SKYNET_UNGATED=1` disables the gate entirely — **strongly discouraged**; skynet prints a
  warning in-chat when you do.

## Engines

`SKYNET_ENGINE` selects the agent runtime:

| Engine | Value | Notes |
|---|---|---|
| direct (default) | `direct` | Bullet-proof `@google/genai` function-calling loop |
| Google ADK | `adk` | `@google/adk` agent with native `requireConfirmation` pauses; **auto-falls back to direct** if the runtime misbehaves |

Both engines speak the same tool schema, share the gate, and stream the same ndjson wire
events, so the UI can't tell them apart.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | — | Required for chat (Google AI Studio, free tier OK) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Override if you hit a model 404 |
| `SKYNET_ENGINE` | `direct` | `direct` or `adk` |
| `SKYNET_API_PORT` | `8080` | API server port |
| `SKYNET_CALLBACK_PORT` | `4180` | OAuth callback port — the redirect URI (`http://localhost:<port>/callback`) is registered with Zepto at connect time; unprivileged by default |
| `SKYNET_WEB_ORIGIN` | `http://localhost:4200` | `/callback` redirects here (dev server or any static origin) |
| `SKYNET_DATA_DIR` | `~/.skynet` | Tokens + chat history, written 0600 |
| `SKYNET_ZEPTO_REDIRECT_URI` | `http://localhost:4180/callback` | Only change if you registered your own URI (a port-less URI implies a port-80 listener — privileges needed) |
| `SKYNET_ALLOW_PASTE_FALLBACK` | `1` | Show the paste-the-redirect-URL escape hatch |
| `SKYNET_CONFIRM_TOOL_RE` | built-in | Regex overriding gate classification |
| `SKYNET_UNGATED` | `0` | `1` disables the order gate (prints a warning) |
| `SKYNET_OTEL` | `1` | Tracing master switch — the ⏱ Traces drawer included; `0` loses only the viewer/export |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP/HTTP trace mirror (e.g. `http://localhost:4318` for Jaeger all-in-one) |
| `SKYNET_OTEL_SERVICE` | `skynet-server` | `service.name` resource attribute |
| `SKYNET_OTEL_CONTENT` | `0` | `1` opts in to embedding prompt/response text in spans (metadata-only by default; tokens are never traced) |

## Tracing your session

Every network action runs inside OpenTelemetry spans, so "what happened in this
session?" — turn → model rounds → MCP tool calls → the order gate decision,
all with durations — is answerable with **zero external infrastructure**:

- Open the **⏱ Traces** header button in the web UI. It lists the recent
  traces for your session newest-first; expand one for the waterfall (span
  name, duration bar, status color, metadata attributes). Refreshes manually
  or every 5s while open. The store is in-memory (~2000 spans) and resets on
  restart — a local dev tool, deliberately.
- To see the same traces in a real backend (Jaeger, Grafana Tempo, …):

  ```bash
  docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one
  # put in .env:  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
  npm run stack:restart full-noauth
  # browse http://localhost:16686 → service "skynet-server"
  ```

Content policy: traces are **metadata-only by default** (tool names, argument
previews, durations, statuses, model, round numbers, gate decisions).
Prompt/response text stays out unless `SKYNET_OTEL_CONTENT=1`; tokens/secrets
are never traced. The `/api/health` payload reports
`otel: { enabled, otlp, spans, service }` for a quick pipeline check.

## Data & secrets

- Token files live only in `SKYNET_DATA_DIR` (`~/.skynet` by default), Unix mode **0600**,
  written atomically per file. The repo never sees tokens; `.env*`, `*.tokens.json`, `dist`,
  `node_modules` are all gitignored.
- Chat sessions persist to the same directory so a restart keeps your history — and lets a
  restart finish an in-flight OAuth state.

## Repo scripts

| Command (repo root) | Effect |
|---|---|
| `npm run dev` | server (tsx watch) + Angular dev server via `concurrently` |
| `npm run build:web` / `build:server` | build one workspace |
| `npm run start:server` | run compiled server on `:8080`, serves the built SPA |
| `npm run connect:probe` | live Zepto probe: discovery, registration, PKCE shape (registered throwaway client, harmless) |
| `npm run -w apps/server smoke` | offline smoke test: engines + order gate |
| `npm run -w apps/server build` | tsc the server |

## Troubleshooting

- **`curl :8080` 404 / blank** — you loaded the server before `npm run build:web`; the SPA
  serving needs `apps/web/dist/skynet-web/browser` to exist (dev via `:4200` doesn't need it).
- **`cannot bind the callback port (EACCES / EADDRINUSE)`** — see [the callback port](#the-callback-port-read-this-if-connect-fails).
  The paste fallback always works meanwhile.
- **Login finished but the dot stays red** — check the server log for the MCP handshake /
  `tools/list` error; a `401` from `mcp.zepto.co.in` usually means the access token was
  rejected (expired or leaked) — press Connect again for a fresh login.
- **Chat says it can't reach Zepto** — the MCP host is unreachable or the token expired;
  skynet reconnects lazily (one silent retry on `UnauthorizedError` per tool call), otherwise
  press Connect.
- **model 404 from Gemini** — set `GEMINI_MODEL` to a model your key can access.
