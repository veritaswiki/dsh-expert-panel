# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Changed
- 不再内置任何默认阵容：`Config` 的 `finalExpert` / `workerModel` / `reviewer` 默认值与
  `client.js` 的种子模型清单全部清空，`cordis.patch.yml` 只保留纯行为开关。
  插件不再假设任何 provider / model，装好后由用户在设置页选。
- 未配置阵容时明确引导而不是用假默认：`/expert` 返回「去设置页配置阵容」文案、
  `consult_expert_panel` 抛同一句提示、system prompt 顶部注入同一警告，且不启动任何专家子会话。
- 灾备路由不再按具体 provider / model 字面量判断，改为「同 provider 的另一条路由 → 任意另一位取证专家」的路由比较。
- `maxStepsPerExpert` 在仓库 `cordis.patch.yml` 与 schema 之间统一为 `30`（此前 patch 写 `60`）。

### Added
- `test/pipeline.test.mjs` 增加 5 个用例：空阵容下的工具 / 命令 / prompt 行为，以及「只配一位专家时该位兼终裁」。

## [5.0.0] - 2026-11-09

First public release. First-principles rewrite of the plugin.

### Added
- Three-stage review pipeline: **① independent evidence → ② cross-review → ③ arbiter verdict**.
- Hard wrap-up contract:
  - step-budget nudge at 60%, tool lock at 100%;
  - active-work-time budget with `timeBudgetLocked` at 70% (tool wait excluded);
  - automatic "wrap-up only" round when a run is aborted without prose;
  - `emptyConclusion` flag + reasoning fallback so a hand-off is never blank.
- Unforgeable telemetry ledger inlined into the dispatch.

### Changed
- Config surface reduced to 8 fields; parallel count now derives from `panelists.length`.
- Settings collapsed from 6 cards to 2.
- Endpoint surface reduced from 12 actions to 4.

### Removed
- Session supervision subsystem (heuristic per-turn audit, nightly digest, sidebar badge, macOS notifications, suggestion / expert-analysis / one-click-execute flows) — it monitored *global* session health, which is orthogonal to "does this summon solve the problem", and its `analyze` bypassed the approval gate while `act` wrote into other sessions.
- Shared-task DAG bookkeeping (`createExpertTeamTask` and friends) — pure accounting, no control flow.
- Team-board digest injected into the expert prompt — token noise.
- `takeover` and `summon` endpoints plus their UI entry points — backdoors around the conversation gate.
- Side modes: single-expert takeover and in-session model takeover.

## [4.2.0] - 2026-11-09

### Changed
- Minimal design system: 5 font sizes, 8 spacing steps, 3 radii, 4 accent colours, borderless cards.
- Fixed scroll container in the `main` slot.

## [4.1.0] - 2026-11-09

### Added
- Rule-based remediation suggestions for audit findings, on-demand expert analysis, one-click execute.

## [4.0.0] - 2026-11-09

### Changed
- Unified to a single multi-round review pipeline; removed `solo` / `final` / `direct_takeover` modes.

## [3.1.0] - 2026-11-08

### Added
- Session supervision: per-turn heuristic audit, sidebar badge, macOS notifications, nightly digest.

### Changed
- Moved the panel from the top bar to the sidebar (`order: 16`).

### Fixed
- Progress-aware watchdog replacing the wall-clock kill.
