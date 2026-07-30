# Changelog

## v1.4.0

### Features

- **Claude Code Agent Teams visualization** ([#218](https://github.com/pixel-agents-hq/pixel-agents/pull/218)) — Renders team leads and teammates as coordinated characters in both tmux and inline modes, with role labels, lead badges, token fuel gauges, tool activity, persistence, and coordinated cleanup. Builds on the early implementations in [#79](https://github.com/pixel-agents-hq/pixel-agents/pull/79) and [#177](https://github.com/pixel-agents-hq/pixel-agents/pull/177). Closes [#65](https://github.com/pixel-agents-hq/pixel-agents/issues/65).
- **Claude Code sub-agents and teammates compatible up to v2.1.220** ([#351](https://github.com/pixel-agents-hq/pixel-agents/pull/351)) — Supports the newer Claude harness, where every `Agent` spawn runs in the background against an implicit per-session team. Named spawns become seated teammate characters with their own hook routing; unnamed spawns stay Subtask sub-agents whose transcripts are watched for live tool activity. Resumed leads re-latch to their newest team instead of stranding departed teammates or showing a phantom lead, and teammates take the free seat closest to their lead.
- **Context gauge on every agent** ([#351](https://github.com/pixel-agents-hq/pixel-agents/pull/351)) — Shows each agent's context occupancy above its character, sized to the context window of the model that session actually runs.
- **Animated pets** ([#315](https://github.com/pixel-agents-hq/pixel-agents/pull/315)) — Adds Claudio and Gitcat to the layout editor, autonomous walking and idle animations, petting interactions, saved placement, and custom pets loaded from external asset directories. Reimplements and supersedes [#219](https://github.com/pixel-agents-hq/pixel-agents/pull/219) on the new architecture.
- **Carpets and workspace Areas** ([#316](https://github.com/pixel-agents-hq/pixel-agents/pull/316)) — Adds three auto-tiling carpet styles with WYSIWYG color controls, paint/erase/eyedropper tools, undo, and persistence. Named Areas can be painted onto the office, mapped to workspace folders, and used to seat agents in the right part of the layout. Integrates the original carpet work from [#213](https://github.com/pixel-agents-hq/pixel-agents/pull/213) and Areas work from [#259](https://github.com/pixel-agents-hq/pixel-agents/pull/259).
- **Optional startup automation** ([#221](https://github.com/pixel-agents-hq/pixel-agents/pull/221)) — Adds `pixel-agents.autoShowPanel` and `pixel-agents.autoSpawnAgent` settings to open the panel and launch an agent automatically when VS Code starts. Both remain off by default.

### Standalone and Architecture

- **Layered architecture and provider-ready core** ([#236](https://github.com/pixel-agents-hq/pixel-agents/pull/236), [#238](https://github.com/pixel-agents-hq/pixel-agents/pull/238), [#273](https://github.com/pixel-agents-hq/pixel-agents/pull/273), merged through [#275](https://github.com/pixel-agents-hq/pixel-agents/pull/275)) — Separates shared contracts, the runtime server, the VS Code adapter, and the webview; centralizes lifecycle state in `AgentRuntime` and `AgentStateStore`; and removes runtime VS Code dependencies from the server. Provider, adapter, transport, and state interfaces now give future clients and agent providers stable integration points.
- **Standalone browser app and npm package** ([#273](https://github.com/pixel-agents-hq/pixel-agents/pull/273), [#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — `npx pixel-agents` starts a local Fastify server and browser office with WebSocket state delivery. The standalone UI now covers the core VS Code experience, including settings, diagnostics, asset reloads, layout import/export, Areas, carpets, and pets, while user state is centralized under `~/.pixel-agents/`. Closes [#120](https://github.com/pixel-agents-hq/pixel-agents/issues/120).
- **Multi-server hook discovery and fan-out** ([#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Lets the VS Code extension and one or more standalone servers run together. Each server registers independently, Claude hook events fan out to every live server, and each surface adopts only the sessions in its configured scope.
- **Published WebSocket protocol contract** ([#273](https://github.com/pixel-agents-hq/pixel-agents/pull/273)) — Makes `core/asyncapi.yaml` the authoritative AsyncAPI contract and generates the shared TypeScript message bindings with CI drift detection.

### Fixes

- **Agent and teammate lifecycle reliability** ([#287](https://github.com/pixel-agents-hq/pixel-agents/pull/287), [#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Fixes idle/done state regressions, aligns teammate lifecycle behavior, and preserves agent tracking when terminals move between VS Code locations.
- **Standalone server and development reliability** ([#316](https://github.com/pixel-agents-hq/pixel-agents/pull/316), [#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Honors an explicit `--port`, restores browser-mock hot reload, adds connection-state feedback, and fixes Windows e2e startup behavior.
- **Areas editor and seating polish** ([#316](https://github.com/pixel-agents-hq/pixel-agents/pull/316)) — Correctly seats agents from custom-named workspace folders, fits four Area cards per row, and prevents the folder picker from being clipped.
- **File watching and session adoption** ([#352](https://github.com/pixel-agents-hq/pixel-agents/pull/352)) — Fixes duplicate agent adoption on Windows, where case-sensitive path comparison let the same session be adopted twice, and closes a `/clear` race in which the external scanner could adopt a replacement transcript before `SessionStart` reassigned it.
- **Hook install failures and restored-agent rendering** ([#351](https://github.com/pixel-agents-hq/pixel-agents/pull/351)) — Hook installation now reports failure instead of logging false success, and restored agents render regardless of the order in which `layoutLoaded` and `existingAgents` arrive. Closes [#333](https://github.com/pixel-agents-hq/pixel-agents/issues/333), [#334](https://github.com/pixel-agents-hq/pixel-agents/issues/334).
- **Standalone rendering of already-running agents** ([#349](https://github.com/pixel-agents-hq/pixel-agents/pull/349)) — Sends `layoutLoaded` after `existingAgents` on `webviewReady`, so a standalone client that connects once agents already exist renders their characters instead of an empty office.
- **Workspace transcript discovery with hooks enabled** ([#330](https://github.com/pixel-agents-hq/pixel-agents/pull/330)) — Keeps workspace JSONL discovery active when hooks are installed, so sessions are still found by file path rather than relying on hook delivery alone.
- **Cross-platform build and server tests** ([#289](https://github.com/pixel-agents-hq/pixel-agents/pull/289)) — Fixes `npm run build` failing outright on Windows for paths containing spaces, and server tests that bypassed temp-home isolation and wrote to the real `~/.pixel-agents`.

### Testing and Release Infrastructure

- **Comprehensive Playwright e2e suite** ([#287](https://github.com/pixel-agents-hq/pixel-agents/pull/287), [#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Expands coverage across VS Code and standalone, hooks-on and hooks-off lifecycles, Agent Teams, pets, carpets, Areas, and multi-server behavior. Adds a deterministic mock Claude process, narrated run videos, an in-repo coverage inventory, and combined Allure reporting.
- **Verified npm publishing pipeline** ([#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Adds package-contract tests, installed-tarball smoke verification, release tag/version checks, and provenance-ready npm publishing for the standalone package.
- **CI gating and platform coverage** ([#352](https://github.com/pixel-agents-hq/pixel-agents/pull/352)) — Adds a single aggregate `Required Checks` job so branch protection can gate on one stable check instead of every shard name, and unblocks the e2e suite on macOS Tahoe by making video recording optional.

### Maintenance

- **Move project links to `pixel-agents-hq`** ([#274](https://github.com/pixel-agents-hq/pixel-agents/pull/274)) — Updates repository, issue, and community links after the GitHub organization migration.
- Dependency and release-action updates ([#224](https://github.com/pixel-agents-hq/pixel-agents/pull/224), [#225](https://github.com/pixel-agents-hq/pixel-agents/pull/225), [#226](https://github.com/pixel-agents-hq/pixel-agents/pull/226), [#227](https://github.com/pixel-agents-hq/pixel-agents/pull/227))

### Contributors

Thank you to the contributors who made this release possible:

- [@itsManeka](https://github.com/itsManeka) — Animated pet system, bundled pet sprites, and pet interactions
- [@NNTin](https://github.com/NNTin) — Carpet system and foundational Playwright e2e infrastructure
- [@balgaly](https://github.com/balgaly) — Automatic panel display and agent startup settings
- [@elietwd](https://github.com/elietwd) — Cross-platform Windows build script and server test isolation
- [@snvtac](https://github.com/snvtac) — Workspace JSONL discovery with hooks enabled
- [@bezzborodth-tech](https://github.com/bezzborodth-tech) — Standalone rendering fix for agents that already exist on connect
- [@srasantos](https://github.com/srasantos) — Reported the hook-install and restored-agent rendering bugs
- [@ErickGross-19](https://github.com/ErickGross-19), [@ZenidX](https://github.com/ZenidX) — Early Agent Teams implementations that informed the shipped design
- [@pablodelucca](https://github.com/pablodelucca) — Claude 2.1.220 sub-agent and teammate support, context gauge, Workspace Areas, layout-editor polish, and watchable narrated e2e review
- [@modtanoii](https://github.com/modtanoii) — Architecture refactor collaboration, server and WebSocket design, and extensibility hardening
- [@florintimbuc](https://github.com/florintimbuc) — Architecture refactor, Agent Teams integration, standalone and npm package, multi-server support, file-watcher and CI hardening, e2e expansion, and release coordination

### Community acknowledgements

#### Architecture and standalone direction

Earlier standalone implementations from [@rollecode](https://github.com/rollecode) ([#156](https://github.com/pixel-agents-hq/pixel-agents/pull/156)), [@MikaelDDavidd](https://github.com/MikaelDDavidd) ([#166](https://github.com/pixel-agents-hq/pixel-agents/pull/166)), and [@TimpiaAI](https://github.com/TimpiaAI) ([#63](https://github.com/pixel-agents-hq/pixel-agents/pull/63)) demonstrated community demand and validated the browser SPA, WebSocket, and server discovery direction. These PRs were closed as superseded, with many thanks to their authors.

#### Independent fixes

Several community PRs independently diagnosed or fixed issues resolved in v1.4.0. Some overlapped with the final implementation, but each helped validate and strengthen the release:

- **Standalone hook path:** [@sakuramoon44](https://github.com/sakuramoon44) ([#283](https://github.com/pixel-agents-hq/pixel-agents/pull/283)), [@joemanat1997](https://github.com/joemanat1997) ([#292](https://github.com/pixel-agents-hq/pixel-agents/pull/292)), [@Ralphive](https://github.com/Ralphive) ([#295](https://github.com/pixel-agents-hq/pixel-agents/pull/295)), [@AxlLinares](https://github.com/AxlLinares) ([#306](https://github.com/pixel-agents-hq/pixel-agents/pull/306)), [@mariopablobarron](https://github.com/mariopablobarron) ([#325](https://github.com/pixel-agents-hq/pixel-agents/pull/325)), and [@NatVich](https://github.com/NatVich) ([#326](https://github.com/pixel-agents-hq/pixel-agents/pull/326)).
- **Windows message generation:** [@sakuramoon44](https://github.com/sakuramoon44) ([#280](https://github.com/pixel-agents-hq/pixel-agents/pull/280)) and [@joemanat1997](https://github.com/joemanat1997) ([#291](https://github.com/pixel-agents-hq/pixel-agents/pull/291)).
- **Standalone agent rendering:** shipped through [@bezzborodth-tech](https://github.com/bezzborodth-tech) ([#349](https://github.com/pixel-agents-hq/pixel-agents/pull/349)), with independent fixes and tests from [@miguemlima-creator](https://github.com/miguemlima-creator) ([#324](https://github.com/pixel-agents-hq/pixel-agents/pull/324)), [@Ralphive](https://github.com/Ralphive) ([#297](https://github.com/pixel-agents-hq/pixel-agents/pull/297)), [@meganechan](https://github.com/meganechan) ([#299](https://github.com/pixel-agents-hq/pixel-agents/pull/299)), [@SichAlexander](https://github.com/SichAlexander) ([#336](https://github.com/pixel-agents-hq/pixel-agents/pull/336)), and [@yshyuk](https://github.com/yshyuk) ([#338](https://github.com/pixel-agents-hq/pixel-agents/pull/338)).
- **Windows test isolation:** [@sakuramoon44](https://github.com/sakuramoon44) ([#281](https://github.com/pixel-agents-hq/pixel-agents/pull/281)), consolidated by [@elietwd](https://github.com/elietwd) ([#289](https://github.com/pixel-agents-hq/pixel-agents/pull/289)).
- **Dependency audit cleanup:** [@Suoriks](https://github.com/Suoriks) ([#345](https://github.com/pixel-agents-hq/pixel-agents/pull/345)).

Special thanks to [@sakuramoon44](https://github.com/sakuramoon44), [@Ralphive](https://github.com/Ralphive), and [@joemanat1997](https://github.com/joemanat1997) for contributing multiple fixes during this release cycle.

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
