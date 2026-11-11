# Contributing

Thanks for taking a look at `dsh-expert-panel`.

## Ground rules

This plugin has an explicit **axiom** and a short list of **safety invariants**. Changes that violate them are rejected regardless of how useful they look:

> **Axiom**: when the main model gets stuck, run one adversarial cross-model review under a hard budget-and-wrap-up contract, and compress the blind spots into a dispatch the main model can execute directly.

1. **Never ship a silent empty run.** Every expert run must end with prose or an explicit `emptyConclusion` marker.
2. **Evidence and review stages are hard read-only.** `write` / `edit` are denied at the tool level, not by prompt.
3. **No cross-session writes.** The plugin must not inject instructions into a session other than the one that summoned it.
4. **One gate, not two.** A model-initiated request shows a confirm card; a user's own `/expert` does not. Do not "unify" this.
5. **Keep the three budget guards**: `maxStepsPerExpert`, `expertTimeoutSeconds`, and the child tool guard.

## Before opening a PR

```bash
npm test          # syntax check + pipeline unit tests
```

## What gets rejected

- A new feature that only adds narrative ("looks like collaboration") without changing what the dispatch says.
- Anything that runs a background timer, listens to global session events, or writes state while no one summoned the panel.
- A new HTTP action that starts subagents or mutates session state without going through `consult_expert_panel` or `/expert`.

## Style

- ESM only (`"type": "module"`), no build step.
- Host and client halves stay dependency-free beyond what DSH injects.
- Keep the design tokens in `client.js` (`EP_CSS`) at 5 font sizes / 8 spacing steps / 3 radii / 4 accents.
