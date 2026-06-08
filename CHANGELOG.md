# Changelog

## v1.4.0

### Features

- **OpenAI Codex CLI support** — Adds Codex as a second `HookProvider` alongside Claude Code. Select the active engine via `pixel-agents.agentEngine` (`claude-code` or `codex`) in VS Code settings or the Settings modal. Includes Codex hook installer (`~/.codex/hooks.json`), transcript parsing for Codex JSONL format, and hot-swap when the setting changes without reloading the extension.
- **Agent engine picker in Settings modal** — Switch between Claude Code and Codex from the in-panel Settings UI.

### Fixes

- **Codex session binding** — Launched Codex terminals rebind to real `rollout-*.jsonl` transcript files on `SessionStart` hook events, with correct hook session routing when the CLI-assigned session ID differs from the placeholder used at spawn time.

## v1.3.0

### Features

- **Hooks-first session management with dual-mode architecture** ([#214](https://github.com/pablodelucca/pixel-agents/pull/214)) — Splits agent detection into a preferred hooks path and a heuristic fallback. When Claude Code hooks are available, session lifecycle, tool activity, permissions, and sub-agent events are reported instantly via a local HTTP server; when unavailable, the extension transparently falls back to JSONL polling. Builds on [#187](https://github.com/pablodelucca/pixel-agents/pull/187). Closes [#188](https://github.com/pablodelucca/pixel-agents/issues/188), [#201](https://github.com/pablodelucca/pixel-agents/issues/201).
- **Claude Code hooks for instant agent status detection** ([#187](https://github.com/pablodelucca/pixel-agents/pull/187)) — Adds a standalone HTTP server and hook installer that routes 11 Claude Code hook events (SessionStart, Stop, PreToolUse, PostToolUse, SubagentStart, Notification, and others) to the webview for sub-second status updates, replacing filesystem polling when hooks are installed.
- **External session support and Agent tool recognition** ([#115](https://github.com/pablodelucca/pixel-agents/pull/115)) — Detects Claude sessions launched outside the extension (external CLIs, other editors) and recognizes the renamed `Agent` sub-agent tool so sub-agent characters spawn correctly with current Claude Code versions. Closes [#184](https://github.com/pablodelucca/pixel-agents/issues/184), [#74](https://github.com/pablodelucca/pixel-agents/issues/74), [#9](https://github.com/pablodelucca/pixel-agents/issues/9), [#8](https://github.com/pablodelucca/pixel-agents/issues/8), [#1](https://github.com/pablodelucca/pixel-agents/issues/1). Supersedes [#2](https://github.com/pablodelucca/pixel-agents/pull/2), [#77](https://github.com/pablodelucca/pixel-agents/pull/77), [#101](https://github.com/pablodelucca/pixel-agents/pull/101), [#141](https://github.com/pablodelucca/pixel-agents/pull/141).
- **Multi-root workspace agent detection** ([#102](https://github.com/pablodelucca/pixel-agents/pull/102)) — Scans all workspace folders in multi-root workspaces instead of only the first, so agents launched in any folder are discovered and adopted. Closes [#30](https://github.com/pablodelucca/pixel-agents/issues/30). Supersedes [#103](https://github.com/pablodelucca/pixel-agents/pull/103), [#157](https://github.com/pablodelucca/pixel-agents/pull/157).
- **Load custom characters from external asset directories** ([#208](https://github.com/pablodelucca/pixel-agents/pull/208)) — Users can drop custom character PNGs into an external asset directory and have them loaded alongside the built-in palettes, enabling community-contributed character skins without forking the extension.
- **Tailwind CSS v4 migration for the webview UI** ([#204](https://github.com/pablodelucca/pixel-agents/pull/204)) — Modernizes the webview styling stack to Tailwind v4, simplifying theming, reducing custom CSS, and improving build times.

### Fixes

- **Prevent duplicate restores, fix tool status reconnect, and improve agent tool detection** ([#197](https://github.com/pablodelucca/pixel-agents/pull/197)) — Stops agents being restored twice on reload, restores tool status correctly after a reconnect, and tightens the tool-name detection heuristics so active tool animations match the running tool.

### Maintenance

- **Add `shared/` to lint, format, and lint-staged** ([#212](https://github.com/pablodelucca/pixel-agents/pull/212)) — Brings the shared package under the project's lint, format, and pre-commit pipeline so cross-package code stays consistent.
- Dependabot dev-dependency group bumps ([#209](https://github.com/pablodelucca/pixel-agents/pull/209), [#210](https://github.com/pablodelucca/pixel-agents/pull/210))

### Contributors

Thank you to the contributors who made this release possible:

- [@drewf](https://github.com/drewf) — External session support and Agent tool recognition
- [@Commandershadow9](https://github.com/Commandershadow9) — Multi-root workspace agent detection
- [@mitre88](https://github.com/mitre88), [@noam971](https://github.com/noam971) — Duplicate restore, tool status reconnect, and tool detection fixes
- [@itsManeka](https://github.com/itsManeka) — Custom characters from external asset directories
- [@pablodelucca](https://github.com/pablodelucca), [@NNTin](https://github.com/NNTin) — Claude Code hooks integration, Tailwind v4 migration
- [@florintimbuc](https://github.com/florintimbuc) — Hooks-first dual-mode architecture, review coordination

## v1.2.0

### Features

- **External asset packs** ([#169](https://github.com/pablodelucca/pixel-agents/pull/169)) — Load furniture assets from user-defined directories outside the extension, enabling third-party asset packs alongside built-in furniture. Add/remove directories via Settings modal with live palette refresh.
- **Bypass permissions mode** ([#170](https://github.com/pablodelucca/pixel-agents/pull/170)) — Right-click the "+ Agent" button to launch with `--dangerously-skip-permissions`, skipping all tool-call approval prompts.
- **Improved seating, sub-agent spawning, and background agents** ([#180](https://github.com/pablodelucca/pixel-agents/pull/180)) — Agents prefer seats facing electronics (PCs, monitors). Sub-agents spawn on the closest walkable tile to their parent instead of claiming seats. Background agents stay alive until their queue-operation completes.
- **Agent connection diagnostics and JSONL parser resilience** ([#183](https://github.com/pablodelucca/pixel-agents/pull/183)) — Debug View shows agent connection state with diagnostic info. JSONL parser handles malformed/partial records gracefully. Simplified file watching to single poll for reliability.
- **Browser preview mode** ([#143](https://github.com/pablodelucca/pixel-agents/pull/143)) — Preview the Pixel Agents webview in a browser for development and review.
- **Always show overlay setting** — Option to keep agent overlay labels visible at all times, with reduced opacity for non-focused agents.

### Fixes

- **Agents not appearing on Linux Mint and macOS without a folder open** ([#70](https://github.com/pablodelucca/pixel-agents/pull/70)) — Falls back to `os.homedir()` when no workspace folder is open, matching Claude Code's own behavior.

### Testing

- **Playwright e2e tests** ([#161](https://github.com/pablodelucca/pixel-agents/pull/161)) — End-to-end test infrastructure using Playwright's Electron API with a mock Claude CLI, validating agent spawn flow in a real VS Code instance.

### Maintenance

- Add feature request template and update community docs ([#164](https://github.com/pablodelucca/pixel-agents/pull/164))
- Bump Vite 8.0, ESLint 10, and various dependency updates
- CI improvements: skip PR title check for Dependabot, restrict badge updates to main repo ([#181](https://github.com/pablodelucca/pixel-agents/pull/181))

### Contributors

Thank you to the contributors who made this release possible:

- [@marctebo](https://github.com/marctebo) — External asset packs support
- [@dankadr](https://github.com/dankadr) — Bypass permissions mode
- [@d4rkd0s](https://github.com/d4rkd0s) — Linux/macOS fix for no-folder workspaces
- [@daniel-dallimore](https://github.com/daniel-dallimore) — Always show overlay setting
- [@NNTin](https://github.com/NNTin) — Playwright e2e tests, browser preview mode
- [@florintimbuc](https://github.com/florintimbuc) — Agent diagnostics, JSONL resilience, CI improvements, code review

## v1.1.1

### Fixes

- **Fix Open VSX publishing** — Created namespace on Open VSX and added `skipDuplicate` to publish workflow for idempotent releases.

## v1.1.0

### Features

- **Migrate to open-source assets with modular manifest-based loading** ([#117](https://github.com/pablodelucca/pixel-agents/pull/117)) — Replaces bundled proprietary tileset with open-source assets loaded via a manifest system, enabling community contributions and modding.
- **Recognize 'Agent' tool name for sub-agent visualization** ([#76](https://github.com/pablodelucca/pixel-agents/pull/76)) — Claude Code renamed the sub-agent tool from 'Task' to 'Agent'; sub-agent characters now spawn correctly with current Claude Code versions.
- **Dual-publish workflow for VS Code Marketplace + Open VSX** ([#44](https://github.com/pablodelucca/pixel-agents/pull/44)) — Automates extension releases to both VS Code Marketplace and Open VSX via GitHub Actions.

### Maintenance

- **Add linting, formatting, and repo infrastructure** ([#82](https://github.com/pablodelucca/pixel-agents/pull/82)) — ESLint, Prettier, Husky pre-commit hooks, and lint-staged for consistent code quality.
- **Add CI workflow, Dependabot, and ESLint contributor rules** ([#116](https://github.com/pablodelucca/pixel-agents/pull/116)) — Continuous integration, automated dependency updates, and shared linting configuration.
- **Lower VS Code engine requirement to ^1.105.0** — Broadens compatibility with older VS Code versions and forks (Cursor, Antigravity, Windsurf, VSCodium, Kiro, TRAE, Positron, etc.).

### Contributors

Thank you to the contributors who made this release possible:

- [@drewf](https://github.com/drewf) — Agent tool recognition for sub-agent visualization
- [@Matthew-Smith](https://github.com/Matthew-Smith) — Open VSX publishing workflow
- [@florintimbuc](https://github.com/florintimbuc) — Project coordination, CI workflow, Dependabot, linting infrastructure, publish workflow hardening, code review

## v1.0.2

### Bug Fixes

- **macOS path sanitization and file watching reliability** ([#45](https://github.com/pablodelucca/pixel-agents/pull/45)) — Comprehensive path sanitization for workspace paths with underscores, Unicode/CJK chars, dots, spaces, and special characters. Added `fs.watchFile()` as reliable secondary watcher on macOS. Fixes [#32](https://github.com/pablodelucca/pixel-agents/issues/32), [#39](https://github.com/pablodelucca/pixel-agents/issues/39), [#40](https://github.com/pablodelucca/pixel-agents/issues/40).

### Features

- **Workspace folder picker for multi-root workspaces** ([#12](https://github.com/pablodelucca/pixel-agents/pull/12)) — Clicking "+ Agent" in a multi-root workspace now shows a picker to choose which folder to open Claude Code in.

### Maintenance

- **Lower VS Code engine requirement to ^1.107.0** ([#13](https://github.com/pablodelucca/pixel-agents/pull/13)) — Broadens compatibility with older VS Code versions and forks (Cursor, etc.) without code changes.

### Contributors

Thank you to the contributors who made this release possible:

- [@johnnnzhub](https://github.com/johnnnzhub) — macOS path sanitization and file watching fixes
- [@pghoya2956](https://github.com/pghoya2956) — multi-root workspace folder picker, VS Code engine compatibility

## v1.0.1

Initial public release.
