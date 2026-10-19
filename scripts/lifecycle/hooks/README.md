# lifecycle hooks — AUTH PLACEHOLDER directory

skynet does **not** have application auth yet. The with-auth startup modes
(`full-auth`, `api-auth`, `ui-auth`) reserve an extension point here so auth
can be wired in later **without touching any startup script**.

## Contract

Before the lifecycle launches a component in an **AUTH stanza** mode
(`*-auth`), every file matching:

```text
scripts/lifecycle/hooks/auth-*.sh
```

is sourced by the lifecycle shell **after** dependency checks and **before**
the component process is spawned. Files are sourced in shell glob order.
No-auth modes (`*-noauth`) never source these files.

Each hook runs with:

| Variable       | Meaning                                   |
| -------------- | ----------------------------------------- |
| `LC_STANZA`    | always `AUTH` for hooks                   |
| `LC_COMPONENT` | what is about to start: `api` or `ui`     |
| `LC_MODE`      | the full mode name, e.g. `full-auth`      |

Anything a hook `export`s is inherited by the started component, so hooks can
set auth-related server env (a future `SKYNET_AUTH_*`, etc.) or perform extra
boot steps (e.g. start an auth sidecar, seed auth data). A hook that fails
aborts that component's start.

## Until auth exists

With zero hooks installed (the state today), with-auth modes are functionally
identical to their no-auth siblings and print a one-line notice:

    [stack] auth: PLACEHOLDER — no auth-*.sh hooks installed; starting UNAUTHENTICATED (see scripts/lifecycle/hooks/README.md)

When the auth feature is implemented, drop a file like
`scripts/lifecycle/hooks/auth-api.sh`:

```bash
#!/usr/bin/env bash
# auth-api.sh — placeholder example (future)
export SKYNET_AUTH_ENABLED=1        # example: server env for a future auth layer
```

…and `full-auth` / `api-auth` / `ui-auth` automatically become the
authenticated variants.
