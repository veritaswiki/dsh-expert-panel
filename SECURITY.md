# Security

## Safety invariants

These are enforced in code, not by prompt instructions. A report that one of them can be bypassed is a vulnerability.

| # | Invariant | Where |
|---|---|---|
| 1 | **Evidence and cross-review stages are physically read-only.** `write`, `edit` and shell-mutation tools are denied on the child agent. | `index.js` — `WRITE_DENY_CANDIDATES` + `ctx.tools.guard` |
| 2 | **No delegation from a read-only stage.** A reviewer cannot spawn further subagents to do writes on its behalf. | `index.js` — `DELEGATION_DENY_CANDIDATES` |
| 3 | **Budget guards are always on.** Step budget, active-work-time budget, and the child tool guard cannot be disabled by the expert itself. | `index.js` — `maxStepsPerExpert`, `expertTimeoutSeconds`, guard |
| 4 | **No cross-session writes.** The plugin only ever writes into the session that summoned it. | `index.js` — `createWakingUserMessage` targets the caller |
| 5 | **Loopback-only HTTP.** The management API is registered on the local web server and rejects non-local callers via the `x-expert-panel-request` header convention. | `http-api.js` |

## Scope

- The plugin does not store credentials. Model routes and keys come from the DSH profile configuration.
- Telemetry recorded in a run (steps, durations, token counts, tool names, touched file paths) is surfaced locally and inlined into the dispatch. It is not transmitted anywhere else.
- State written to disk: `~/.dsh/state/expert-panel-settings.json` (non-secret configuration only).

## Reporting

Open a private security advisory on the repository, or email the maintainer listed in `package.json`. Please do not file a public issue for a bypass of any invariant above.
