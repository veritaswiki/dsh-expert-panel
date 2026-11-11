# dsh-expert-panel · Multi-round Review Expert Panel

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](https://nodejs.org/en/download)
<!-- npm: first publish pending; uncomment once the package is on the registry.
[![npm version](https://img.shields.io/npm/v/dsh-expert-panel.svg)](https://www.npmjs.com/package/dsh-expert-panel)
-->

> **Axiom**: when the main model gets stuck, run **one** adversarial cross-model review under a hard budget-and-wrap-up contract, and compress the blind spots into a dispatch the main model can execute directly.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. Not "more models" — the differentiator is the **hard wrap-up contract** that guarantees every summon ends with a conclusion instead of an empty report.

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

`Config` in `index.js` (Schemastery) has exactly these keys; all of them are editable in `Settings → Expert Panel → Settings`.

**Models are never typed by hand.** The expert dropdowns read the host `modelDirectories` service (provided by `@deepseek-ai/dsh-client-ui-model-selection`) — the same catalog, provider names and reasoning effort levels the new-session model picker uses. The plugin keeps no model list of its own.

**The repository ships no `provider` / `model` at all.** After installing, pick a roster on that settings page first; `/expert routes` lists the routes your host actually exposes.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `finalExpert` | `{ label, provider, model, reasoningEffort? }` | empty (unconfigured) | ③ arbiter; falls back to the first panelist when empty |
| `panelists` | array of the same object | `[]` | ① evidence experts; **parallel count = array length** (single source of truth) |
| `reviewer` | optional same object | empty | ② cross-reviewer; falls back to the first panelist |
| `enableArbiter` | boolean | `true` | enable ③; off runs the first two stages only |
| `workerModel` | optional same object | empty (unconfigured) | daily worker model (display / hand-off only); does not affect the pipeline |
| `requireApproval` | boolean | `true` | confirm card for model-initiated requests (user `/expert` never prompts) |
| `maxStepsPerExpert` | number (min 4, step 1) | `30` | step budget; hitting it forces a wrap-up back to the main model |
| `expertTimeoutSeconds` | number (min 60, step 1) | `1800` | active work-time budget in seconds (tool wait excluded) |

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

All four model slots (arbiter / evidence / reviewer / worker) use the host catalog dropdown, and the reasoning-effort list only offers the levels that model declares in the catalog.

## Install

> Not published to the npm registry yet (`npm view dsh-expert-panel` returns 404), so neither route below uses the npm package name.

**A. Through `plugin_manager` (recommended).** Ask the agent to install `dsh-expert-panel`; it calls `plugin_manager` with `action: "install_bundle"` and `target` = `github:veritaswiki/dsh-expert-panel` (or `file:/abs/path/to/dsh-expert-panel`), then `action: "set_bundle"` to enable it.

**B. From source, into a profile.**

```bash
git clone https://github.com/veritaswiki/dsh-expert-panel.git
cd dsh-expert-panel
# dsh plugin forwards its arguments to pnpm inside the profile; --profile picks the target
dsh plugin --profile web add .
```

### Configure the roster right after installing

Open `Settings → Expert Panel → Settings` and pick at least one evidence expert from the model dropdown (the host catalog); the arbiter / reviewer / worker slots work the same way. Until then `/expert` only answers "roster is not configured" and no model is called. `/expert routes` still prints the routes as text.

## Develop

```bash
npm test
```

## Known limitations

- **It needs external models to be reachable.** All three stages run on the `provider` / `model` routes you configure; there is no local inference. Failure is not a hard stop though: when an expert fails at step 1 with zero output (auth, upstream 403, stream timeout), the run retries once on another panelist's route (the route failover in `index.js`) and only then fails the stage — so "we got a verdict in the end" does not prove the route you picked is healthy.
- **Every summon has a real cost.** One review is N evidence experts + 1 reviewer (+ 1 arbiter when `enableArbiter` is on), each burning up to `maxStepsPerExpert`, billed on the models you picked. It is not a single cheap completion.
- **Cross-model latency is visible.** Evidence runs in parallel, review and verdict run serially, so an end-to-end run typically takes tens of seconds to minutes; hitting the step or time budget forces a wrap-up, which yields a partial conclusion, not the fullest one.
- **It does not replace diff-level code review.** The output is a root-cause verdict plus a work dispatch (what to change, who changes it, how to verify) — not a line-by-line patch review. Someone still has to read the diff.
- **The model dropdown depends on the host model-selection package.** Candidates come from the `modelDirectories` service provided by `@deepseek-ai/dsh-client-ui-model-selection` (hence `engines.dsh` is `>=0.2.2-rc.1`). When the host catalog returns nothing, the page shows a degraded hint plus a "reload catalog" button — it never falls back to hand typing.
- **You must configure the roster; no model is shipped.** With both `panelists` and `finalExpert` empty, `/expert` returns a "go configure the roster" hint, `consult_expert_panel` raises the same hint, and the system prompt carries the same warning — no implicit default model is ever used. With a single evidence expert configured, that one expert also acts as reviewer and arbiter (`normalizeConfig` fallback).

## License

MIT
