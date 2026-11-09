# dsh-expert-panel · Multi-round Review Expert Panel

> **Axiom**: when the main model gets stuck, run **one** adversarial cross-model review under a hard budget-and-wrap-up contract, and compress the blind spots into a dispatch the main model can execute directly.

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin. Not "more models" — the differentiator is the **hard wrap-up contract** that guarantees every summon ends with a conclusion instead of an empty report.

## The pipeline (the only path)

| Stage | Who | Permission | Output |
|---|---|---|---|
| **① Independent evidence** | all `panelists`, in parallel | read-only | per-expert report with file/line evidence |
| **② Cross-review** | `reviewer` | read-only | picks apart every claim, overturns wrong ones, converges a plan |
| **③ Arbiter verdict** | `finalExpert` (toggleable) | may write | 《Verdict & Work Dispatch》 |

Stage ② is mandatory. There are **no** single-expert or in-session-takeover side modes.

## Hard wrap-up contract (the real differentiator)

- **Step budget**: at 60% a "start wrapping up" nudge is injected; at 100% evidence tools are locked.
- **Time budget**: at 70% of active work time (tool wait excluded) `timeBudgetLocked` is set and tools are locked.
- **No empty verdict**: if aborted without prose, one automatic "wrap up only, no new evidence" round runs.
- **Last resort**: fall back to the final reasoning excerpt and flag `emptyConclusion` — never a blank hand-off.

## Config (8 fields)

| Field | Meaning |
|---|---|
| `finalExpert` | ③ arbiter |
| `panelists` | ① evidence experts; **parallel count = array length** |
| `reviewer` | ② cross-reviewer; falls back to first panelist |
| `enableArbiter` | enable ③ |
| `workerModel` | daily worker model (display / hand-off only) |
| `requireApproval` | confirm card for model-initiated requests (user `/expert` never prompts) |
| `maxStepsPerExpert` | step budget (default 30) |
| `expertTimeoutSeconds` | active work-time budget (default 1800s, tool wait excluded) |

## HTTP surface (4 actions)

| Method | Path | Purpose |
|---|---|---|
| GET | `/expert-panel/api/state` | runs + config |
| POST/PUT | `/expert-panel/api/config` | save config |
| GET | `/expert-panel/api/detail?childId=` | child tool trace |
| POST | `/expert-panel/api/stop` | interrupt an expert |

## UI

Sidebar entry → two tabs:

- **Runs**: fire a review, history, telemetry, stop / follow-up / open child session;
- **Settings**: ① roster & pipeline, ② gating & wrap-up budget.

Design system: 5 font sizes / 8 spacing steps / 3 radii / 4 accent colours / borderless cards.

## Install

```bash
dsh plugin add dsh-expert-panel
```

## Develop

```bash
npm test
```

## License

MIT
