# AGENTS.md

Lean monorepo: `apps/server` = Node ≥ 20 + TypeScript Express backend (`@skynet/server`, ESM) with the Gemini agent loop, OAuth 2.1 Zepto connector, and MCP client. `apps/web` = Angular 20 standalone UI. UI :4200 (proxies `/api`) → API :8080 + OAuth callback listener :4180.

## Start / stop the stack — lifecycle scripts are authoritative

Do **not** hand-launch `npm run dev`, `ng serve`, or `tsx`, and don't background processes yourself — the lifecycle scripts daemonize (`setsid`), track pids, and refuse on port conflicts:

```bash
bash scripts/lifecycle.sh status                # pids, ports, /api/health
bash scripts/lifecycle.sh start <mode>          # full-noauth | full-auth | api-noauth | api-auth | ui-noauth | ui-auth
bash scripts/lifecycle.sh stop [api|ui|all]
bash scripts/lifecycle.sh restart <mode>
bash scripts/lifecycle.sh logs [api|ui|all]
```

- In OpenCode sessions, delegate stack start/stop to the **`startup-lifecycle` subagent** (`.opencode/agents/startup-lifecycle.md`) — it encodes timeouts (UI cold boot 2–4 min), failure diagnosis, and secrets rules.
- Runtime state: `.run/lifecycle/` (pids + logs, gitignored).
- `*-auth` modes are a **placeholder** — no application auth exists yet; they only source optional `scripts/lifecycle/hooks/auth-*.sh` (see that dir's README before "adding auth").

## Verify changes

No lint config, no CI, no unit tests (`ng test`/Karma is wired but the repo has zero `*.spec.ts`). Verification = build + smoke:

```bash
npm run -w apps/server build   # tsc — this project's typecheck
npm run build:web              # Angular build
npm run -w apps/server smoke   # offline, seconds: both engines + order gate; asserts against plans/*.html
```

`npm run connect:probe` registers a throwaway client against the live Zepto auth — run only on request.

## Code conventions & traps

- Target workspaces with `-w apps/server` / `-w apps/web` (package names differ: `@skynet/server` vs `skynet-web`).
- NodeNext ESM: relative imports in `apps/server` must end in `.js` even in `.ts` sources (`from './dto.js'`).
- `apps/server/dist/` is compiled output (gitignored) — edit `src/`, never `dist/`. `npm run start:server` runs `dist/`, stale unless you rebuild.
- `.env` is at repo root (server resolves repoRoot explicitly, runs from any cwd). Never read, echo, or commit it. Missing `GEMINI_API_KEY` still boots the stack; only chat replies error.
- `apps/web`: single quotes, printWidth 100 (prettier config inside its package.json).

## Order gate — do not weaken

`apps/server/src/agent/gate.ts` blocks checkout/order-placing MCP tools behind an explicit chat confirmation card — real money. When touching tool wiring, keep read-only tools ungated and order tools gated. Never set `SKYNET_UNGATED=1` (or an override `SKYNET_CONFIRM_TOOL_RE`) silently.

## OAuth callback listener

A non-fatal `EACCES`/unbind warning on the **callback port** (:4180) is expected in constrained environments — the app keeps running and the UI paste-fallback completes the OAuth flow. The redirect URI is registered verbatim with Zepto at connect time (exact-match policy). Details: README "The callback port" section — don't re-derive this logic.

## Data & tokens

Tokens + chat history live in `SKYNET_DATA_DIR` (`~/.skynet` default), mode 0600, atomic writes. All the env knobs are documented in `.env.example` and the README config table — trust those (executable/truthful) over prose speculation.
