# Changelog

## [0.2.0] - 2026-11-11

### Changed

- **专家阵容改用宿主的模型目录**：设置页不再维护自己的模型清单，也不再要求手填 `provider` / `model`。终裁、取证、互审、日常主力四处统一读取宿主的 `modelDirectories` 服务——provider 显示名、模型名与可选推理档位全部来自宿主，分组下拉呈现。
- `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-model-selection`；`engines.dsh` 提升到 `>=0.2.2-rc.1`（该宿主包从这个版本起才有）。

### Removed

- `collectAvailableModels()` 与状态快照里的 `availableModels` 字段（自建候选清单）。
- 手填路由输入框、内置的默认模型种子、写死的推理档位。
- 仓库层面预置的任何 `provider` / `model`：未配置阵容时，工具、`/expert` 命令与 system prompt 三处都给出同一句配置引导，且不启动任何子会话。

### Compatibility

- 落盘结构保持 `{ provider, model, label?, reasoningEffort? }` 不变，已有配置无需迁移。

## [0.1.0] - 2026-11-11

First public release.

> Version note: earlier iterations used internal sequence numbers (the sections below). The public series restarts here at 0.1.0; internal numbers are not carried over.


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
- 设置页的模型选择改为复用宿主 `modelDirectories` 服务（`@deepseek-ai/dsh-client-ui-model-selection` 提供，
  与新会话窗口的模型选择同一份目录）：删掉插件自建的 provider/model 手填框、
  自建候选清单（Host 侧 `availableModels`）与写死的推理档位；推理档位改为只列该模型在目录里声明的档位。
  `package.json` 的 `dsh.client.inject` 增加该宿主客户端包。
  **磁盘格式不变**：仍是 `{ provider, model, label?, reasoningEffort? }`，已有配置无需迁移。
  该选择器需要宿主自带 `@deepseek-ai/dsh-client-ui-model-selection`，故 `engines.dsh` 提到 `>=0.2.2-rc.1`。

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
