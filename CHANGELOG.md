# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

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
