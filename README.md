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
                                             │                       ┌─ port 80 ─┐
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

## The port-80 mess (read this if connect fails)

Zepto's OAuth server whitelists redirect URIs **exact-match with NO ports** (verified live:
`http://localhost/callback` is accepted, `http://localhost:8080/callback` bounces with
`uri_not_registered_for_client`). So the OAuth callback **must** be served on port **80**.

When you press Connect, skynet starts a temporary listener on `:80` for the redirect.
Binding port 80 needs *some* privilege on Linux — pick any one:

```bash
# Option A — one-shot capability on the node binary (no sudo at runtime):
sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")"

# Option B — dedicated port ACL helper:
sudo apt install authbind
sudo touch /etc/authbind/byport/80 && sudo chmod 777 /etc/authbind/byport/80
# then start the server under the helper:  authbind --deep npm run dev:server

# Option C — redirect at the firewall, keep the app unprivileged:
sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 8080
#   …and start the server with SKYNET_CALLBACK_PORT=8080

# Option D — if something else already owns :80 (e.g. apache2 on Ubuntu):
sudo systemctl stop apache2 && sudo systemctl disable apache2   # or nginx
```

skynet logs a warning and keeps running if `:80` can't be bound — **no dead end**:

### Paste fallback (no privileges required)

Even without port 80 the login completes through the escape hatch:

1. Press Connect — Zepto login opens in a new tab.
2. After approving, the redirect lands on `http://localhost/callback?code=…&state=…`.
3. If that tab shows the apache default page / connection refused, **copy the full URL** from
   the browser address bar and paste it into the "having trouble?" field in the connector
   sheet (ASCII escape hatch: `POST /api/connectors/:id/paste-callback`).
4. skynet finishes the token exchange and the dot goes green like normal.

Disable via `SKYNET_ALLOW_PASTE_FALLBACK=0` if you don't want the field shown.

## What connect actually does

| Step | Detail |
|---|---|
| 1 | RFC 8414 + RFC 9728 discovery — AS metadata + resource metadata fetched live |
| 2 | Dynamic client registration against `auth.zepto.co.in` (`/register`) |
| 3 | PKCE (S256) authorize URL opened in the browser, state stored in `~/.skynet` |
| 4 | You log in with Indian mobile + OTP at Zepto |
| 5 | `GET /callback?code=…&state=…` on **port 80** matches the state and completes the code exchange |
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
| `SKYNET_CALLBACK_PORT` | `80` | OAuth callback port — must stay 80 (see above) |
| `SKYNET_WEB_ORIGIN` | `http://localhost:4200` | `/callback` redirects here (dev server or any static origin) |
| `SKYNET_DATA_DIR` | `~/.skynet` | Tokens + chat history, written 0600 |
| `SKYNET_ZEPTO_REDIRECT_URI` | `http://localhost/callback` | Only change if you registered your own URI |
| `SKYNET_ALLOW_PASTE_FALLBACK` | `1` | Show the paste-the-redirect-URL escape hatch |
| `SKYNET_CONFIRM_TOOL_RE` | built-in | Regex overriding gate classification |
| `SKYNET_UNGATED` | `0` | `1` disables the order gate (prints a warning) |

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
- **`cannot bind port 80 (EACCES / EADDRINUSE)`** — see [the port-80 mess](#the-port-80-mess-read-this-if-connect-fails).
  The paste fallback always works meanwhile.
- **Login finished but the dot stays red** — check the server log for the MCP handshake /
  `tools/list` error; a `401` from `mcp.zepto.co.in` usually means the access token was
  rejected (expired or leaked) — press Connect again for a fresh login.
- **Chat says it can't reach Zepto** — the MCP host is unreachable or the token expired;
  skynet reconnects lazily (one silent retry on `UnauthorizedError` per tool call), otherwise
  press Connect.
- **model 404 from Gemini** — set `GEMINI_MODEL` to a model your key can access.
