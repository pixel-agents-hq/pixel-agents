# Contributing to Pixel Agents

Thanks for your interest in contributing to Pixel Agents! All contributions are welcome — features, bug fixes, documentation improvements, refactors, and more.

This project is licensed under the [MIT License](LICENSE), so your contributions will be too. No CLA or DCO is required.

Questions while you work on something? Ask in [Discord](https://discord.gg/Yk7jXebv9H).

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (use the version in [`.nvmrc`](.nvmrc), currently v22)
- [VS Code](https://code.visualstudio.com/) (v1.105.0 or later)

### Setup

```bash
git clone https://github.com/pixel-agents-hq/pixel-agents.git
cd pixel-agents
npm install
npm run build
```

Then press **F5** in VS Code to launch the Extension Development Host. To run the standalone CLI built from source:

```bash
node dist/cli.js
```

It prints a local URL, the same as `npx pixel-agents`.

### Build and install the packaged extension locally

If you want to test the extension the same way end users install it, build a `.vsix` package and install it through the VS Code CLI:

```bash
npx @vscode/vsce package --allow-star-activation --out pixel-agents-local.vsix
code --install-extension ./pixel-agents-local.vsix --force
```

`--force` updates the existing local install with your freshly built package.

If you are using Remote SSH, WSL, or a dev container, `code --install-extension` installs the extension into that current VS Code target.

After installing the `.vsix`, run **Developer: Reload Window** in VS Code to load the updated extension.

### Verify the npm package locally

The npm artifact has its own gate because source-level tests cannot detect a missing tarball file or a package-relative path bug:

```bash
npm run test:package-contract
npm run verify:npm-package
```

The verifier runs the production `prepack` build, creates a tarball outside the repository, installs that exact tarball into a temporary project, and exercises CLI help, the health endpoint, the standalone SPA, bundled assets, and default Hook ON setup. Temporary files and the child server are removed automatically; it never publishes to npm.

### Maintainer release checklist

A published GitHub Release coordinates publishing to the VS Code Marketplace, Open VSX, and npm through [`.github/workflows/publish-extension.yml`](.github/workflows/publish-extension.yml). Publishing is release-driven, not triggered by a push to `main` alone.

One-time npm setup: configure the `pixel-agents` package's GitHub Actions [trusted publisher](https://docs.npmjs.com/trusted-publishers/) for `pixel-agents-hq/pixel-agents`, workflow `publish-extension.yml`, no environment, and allow `npm publish`.
The GitHub-hosted workflow enforces Node >=22.14.0 and npm >=11.5.1 and uses OIDC (`id-token: write`); do not configure a long-lived publish token, and revoke any unused one.

For each release:

1. Update `CHANGELOG.md`, then set the same new version in the root `package.json` and both root-version fields in `package-lock.json`. The private workspace manifests are not released and do not receive the extension version.
2. Run `npm ci`, `npm test`, and `npm run verify:npm-package`. Inspect the generated package if needed by manually dispatching **Publish Extension** in dry-run mode and downloading its `npm-package-*` artifact; manual dispatch never publishes to npm.
3. Merge the release changes into `main` and wait for CI to pass.
4. Create and publish a GitHub Release whose tag is exactly `v<package.json version>` and points to that commit on `main` (for example, `v1.4.0`). The npm job rejects a mismatched tag, ref, package identity, non-incrementing version, or changed tarball integrity.
5. Confirm the Marketplace, Open VSX, and npm jobs succeeded, and verify the new npm version with `npm view pixel-agents version`.

## Development Workflow

For development with live rebuilds, run:

```bash
npm run watch
```

This starts parallel watchers for both the extension backend (esbuild) and TypeScript type-checking.

> **Note:** The webview (Vite) is not included in `watch` — after changing webview code, run `npm run build:webview` or the full `npm run build`.

## Running the Mocked Pixel Agent

You can run the mocked Pixel Agent web app either from the CLI or from VS Code tasks.

### Option 1: CLI

From the repository root:

```bash
npm run dev -w webview-ui
```

Vite will print a local URL (typically `http://localhost:5173`) where the mocked app is available.

### Option 2: VS Code Run Task

1. Open the command palette and run **Tasks: Run Task**.
2. Select **Mocked Pixel Agent Dev Server**.
3. Open the local URL shown in the task terminal output (typically `http://localhost:5173`).

### Project Structure

Pixel Agents uses a layered codebase. `core/` depends on nothing; `server/` and `webview-ui/` depend only on `core/`; `adapters/vscode/` depends on `core/` and `server/`.

| Directory                        | Description                                                                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/`                          | Protocol + interface definitions (AsyncAPI 3.0 contract, HookProvider, MessageTransport, StateAdapter). Zero runtime side effects.                                                                                                                    |
| `server/`                        | Lifecycle runtime: `AgentRuntime`, `AgentStateStore`, `SessionRouter`, `DismissalTracker`, Fastify HTTP/WS server, file watching, transcript parsing, hook installer, providers, Vitest test suite. Also ships the `npx pixel-agents` standalone CLI. |
| `adapters/vscode/`               | VS Code surface — `extension.ts`, `WebviewViewProvider`, terminal lifecycle, one-time state migration. Composes `core/` and `server/`.                                                                                                                |
| `webview-ui/`                    | React 19 + Canvas UI. Transport abstraction (`PostMessageTransport` + `WebSocketTransport`). Depends only on `core/`.                                                                                                                                 |
| `webview-ui/public/assets/`      | Bundled office art: furniture (one folder and `manifest.json` per item), floors, walls, carpets, pets, and the default layout.                                                                                                                        |
| `webview-ui/src/characters/art/` | Character wardrobe art (one PNG per part) and `wardrobe.json`; characters are composed from it in the webview.                                                                                                                                        |
| `scripts/`                       | Build/CI tooling: `generate-messages.ts` (AsyncAPI → TS), `run-e2e.mjs`, `build-allure-report.mjs`, `assemble-vercel-output.mjs`, and the asset extraction pipeline.                                                                                  |
| `e2e/`                           | Playwright suite — fixtures, helpers, specs for `claude/hooks-on/`, `claude/hooks-off/`, and `standalone/`.                                                                                                                                           |
| `eslint-rules/`                  | Custom rules (`no-inline-colors`, `pixel-shadow`, `pixel-font`) enforced project-wide.                                                                                                                                                                |

The repo uses **npm workspaces** (`server`, `webview-ui` declared in the root `package.json`). A single `npm install` at the root installs dependencies for all workspaces; no nested `cd ... && npm install` is needed.

The extension and CLI are bundled with esbuild; the webview is built with Vite. Unit tests use Vitest, and end-to-end coverage uses Playwright against VS Code and the standalone server.

### How an event reaches the office

Agent activity comes from two sources: the hook script (`POST /api/hooks/:providerId`) and the JSONL session transcripts, which are also read in hooks mode for details an event doesn't carry. The provider normalizes both into a shared `AgentEvent` model. `AgentRuntime` updates the central `AgentStateStore`, and the active transport (postMessage in VS Code, WebSocket in the browser) sends typed messages to the React webview, which renders the office on a Canvas 2D with pathfinding and character state machines.

### Adding another agent CLI

Claude Code is the only provider today, and everything that knows about it lives in `server/src/providers/hook/claude/`. The integration boundary is the typed `HookProvider` interface in `core/src/provider.ts`: a new CLI is one subdirectory under `server/src/providers/hook/<id>/` (provider, installer, hook scripts, and optionally a `TeamProvider`), with no changes to the runtime or the UI. If the interface is missing something your CLI needs, open an issue or a Discussion before changing `core/`.

### Office assets

Each furniture item has its own folder under `webview-ui/public/assets/furniture/` with a `manifest.json` describing its sprites, rotation groups, state groups (on/off), and animation frames. [docs/external-assets.md](docs/external-assets.md) documents the directory structure and manifest format, which external asset directories (**Settings → Add Asset Directory**) share. The visual asset manager at `scripts/asset-manager.html` helps create and edit manifests.

## Manual Hook Testing

The repo includes [server/manual-hook-events.http](server/manual-hook-events.http) for manually driving the local hook server while the extension is running.

It covers the basic external-session lifecycle:

- `SessionStart` to stage a pending external session
- `PreToolUse` to confirm it and mark the agent active
- `PermissionRequest`, `Notification`, and `Stop` to drive permission/waiting states
- `SessionEnd` to despawn the agent

Before using it, copy `port` and `token` from `~/.pixel-agents/server.json` into the file variables and set `cwd` to a workspace folder opened in the Extension Development Host. If `cwd` is outside the current workspace, enable **Watch All Sessions** in Pixel Agents first.

## Code Guidelines

### Constants

**No unused locals or parameters** (`noUnusedLocals` and `noUnusedParameters` are enabled). All magic numbers and strings are centralized — don't add inline constants to source files:

- **Shared backend timing/scanning constants:** `server/src/constants.ts` (imported by `adapters/vscode/` too)
- **VS Code-only IDs / command names:** `adapters/vscode/constants.ts`
- **Protocol-level constants:** `core/src/constants.ts`
- **Webview:** `webview-ui/src/constants.ts` (grid, animation, rendering, camera, zoom, editor, canvas overlay rgba strings)
- **CSS variables:** `webview-ui/src/index.css` `:root` block (`--pixel-*` properties for React inline styles and CSS)

### UI Styling

The project uses a pixel art aesthetic. All overlays should use:

- Sharp corners (`border-radius: 0`)
- Solid backgrounds and `2px solid` borders
- Hard offset shadows (`2px 2px 0px`, no blur) — use `var(--pixel-shadow)`
- The FS Pixel Sans font (loaded in `index.css`)

These conventions are enforced by custom ESLint rules (`eslint-rules/pixel-agents-rules.mjs`):

| Rule               | Scope               | What it checks                                              |
| ------------------ | ------------------- | ----------------------------------------------------------- |
| `no-inline-colors` | Extension + Webview | No hex/rgb/rgba/hsl/hsla literals outside `constants.ts`    |
| `pixel-shadow`     | Webview only        | Box shadows must use `var(--pixel-shadow)` or `2px 2px 0px` |
| `pixel-font`       | Webview only        | Font family must reference FS Pixel Sans                    |

These rules are set to `error` and will block your PR if violated.

## Unit & Integration Tests

```bash
# Run all tests (webview + server)
npm test

# Run only server tests (Vitest)
npm run test:server

# Run only webview tests
npm run test:webview
```

Server tests cover `AgentStateStore` (typed mutations + events), `HookEventHandler` (routing, buffering, team gating), `SessionRouter` and `DismissalTracker`, `FileStateAdapter` (namespaced persistence), `migrateVsCodeState` (verify-before-clear), `teamUtils`, the Claude provider and its team extension, the hook installer, the HTTP server (lifecycle, auth, `/ws`, broadcast), and the hook script via a spawned-process integration test.

`claude-hook.test.ts` requires the bundled hook at `dist/hooks/claude-hook.js`, so build before running it (or use `npm test` which builds first).

## End-to-End Tests

The `e2e/` directory contains Playwright tests of both surfaces: the VS Code specs (`e2e/tests/claude/`) launch a real VS Code instance with the extension loaded in development mode, and the standalone specs (`e2e/tests/standalone/`) start the CLI server and drive it from a headless browser. The VS Code specs open real windows one after another, which take over the screen and keyboard focus while they run.

### Running e2e tests locally

```bash
# Build the extension first (tests load the compiled output)
npm run build

# Runs the e2e tests
npm run e2e

# Step-by-step debug mode
npm run e2e:debug

# Keep and attach videos even for successful tests
npm run e2e -- --attach-videos-on-success

# Combine debugger + success-case videos
npm run e2e:debug -- --attach-videos-on-success
```

On the first run, `@vscode/test-electron` will download a stable VS Code release into `.vscode-test/` (≈200 MB). Subsequent runs reuse the cache.

### Artifacts

All test artifacts are written to `test-results/e2e/`:

| Path                                   | Contents                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `test-results/e2e/videos/<test-name>/` | `.webm` screen recording for failed tests, or all tests with the debug flag |
| `playwright-report/e2e/`               | Playwright HTML report (`npx playwright show-report playwright-report/e2e`) |
| `test-results/e2e/*.png`               | Final screenshots saved on failure                                          |

By default, successful tests discard their videos after teardown. Pass `--attach-videos-on-success` when you need success-case recordings attached to the report for debugging.

### Mock claude

Tests never invoke the real `claude` CLI. A wrapper script (`e2e/fixtures/mock-claude` on POSIX, `mock-claude.cmd` on Windows) is copied into an isolated `bin/` directory and prepended to `PATH` before VS Code starts. The wrapper delegates to `e2e/fixtures/mock-claude-runner.cjs`, which honors a scenario blob set by the test via the `MOCK_CLAUDE_SCENARIO` env var.

Tests build scenarios with the fluent `claudeScenario(...)` helper in `e2e/helpers/mock-claude.ts`:

```typescript
claudeScenario('my-scenario')
  .at(2_000)
  .appendJsonl(buildAssistantToolUseRecord('toolu-1', 'Read', { file_path: '/x' }))
  .at(3_000)
  .emitHook(preToolUseRead('sessionId', '/x'))
  .holdOpenFor(10_000)
  .build();
```

`appendJsonl` writes a record to `$HOME/.claude/projects/<project-hash>/<session-id>.jsonl` at the given offset. `emitHook` POSTs a hook event to the running server's `/api/hooks/:providerId`. `holdOpenFor` keeps the wrapper process alive (and the terminal "busy") for that many ms after the last action, then exits.

Each test runs with an isolated `HOME`, workspace directory, VS Code `--user-data-dir`, and mock log file — no state leaks between runs or into your real VS Code profile.

For the normative model behind this (the process-boundary principle, append-only transcript rule, assertion philosophy, and the one standalone-server exception), see [`e2e/README.md` → "Mocking model & rules"](e2e/README.md#mocking-model--rules).

### E2E test naming

Tests use behavioral sentences with `@area:<tag>` suffixes for grouping. Areas: `spawn`, `lifecycle`, `cross-cutting`, `teams`, `matrix`, `standalone`, `mobile`, `editor`, `areas`, `carpet`, `pets`. Example:

```typescript
test('rapid /clear then new tool within 500ms lands on the reassigned agent @area:lifecycle', ...);
```

The auto-generated test inventory in `e2e/README.md` groups tests by `@area:` tag. After adding or removing tests, run `npm run e2e:inventory` to regenerate — CI fails if it drifts.

### Hosted Test Reports

Build the combined Allure report locally and stage it for Vercel:

```bash
npm run test
npm run e2e
npm run e2e -- --attach-videos-on-success
npm run vercel:prepare
```

Use `npm run test:report` to build the combined report without preparing the Vercel output, then `npm run test:report:open` to serve it locally.

The staged output serves the combined `e2e`, `server`, and `webview` Allure report at `/reports/allure/`; it does not include a standalone webview preview. GitHub Actions creates a Vercel Preview deployment only for same-repository pull requests targeting `main`. The deploy job expects `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` secrets and skips fork pull requests.

## Submitting a Pull Request

1. Fork the repo and create a feature branch from `main`
2. Make your changes
3. Verify everything passes locally:
   ```bash
   npm run lint                         # core + server + adapters + webview lint
   npm run check-types                  # TypeScript strict check across all packages
   npm run asyncapi:validate            # AsyncAPI spec validation
   npm run asyncapi:generate            # Regen core/src/messages.ts (must produce no git diff)
   npm run e2e:inventory                # Regen e2e/README.md (must produce no git diff)
   npm run build                        # esbuild (extension + CLI + hooks) + Vite (webview)
   npm test                             # Server vitest + webview vitest
   npm run e2e                          # Full Playwright suite; inventory lives in e2e/README.md
   ```
   CI runs these same checks automatically on every PR. The AsyncAPI and e2e inventory drift checks fail the build on any diff — always regen + commit the result.
4. Open a pull request against `main` with:
   - A **conventional commit PR title** (e.g. `feat: add zoom controls`, `fix: character freezing on terminal close`, `refactor: extract pathfinding module`). CI enforces this format — see [Conventional Commits](https://www.conventionalcommits.org/).
   - A clear description of what changed and why
   - How you tested the changes (steps to reproduce / verify)
   - **Screenshots or GIFs for any UI changes**

> **Note:** PRs are merged using **squash and merge** — all commits in your PR are combined into a single commit on `main`. Your PR title becomes the commit message, which is why the conventional commit format matters.

## Reporting Bugs

[Open a bug report](https://github.com/pixel-agents-hq/pixel-agents/issues/new?template=bug_report.yml) — the form will guide you through providing the details we need.

## Feature Requests

Have an idea? [Open a feature request](https://github.com/pixel-agents-hq/pixel-agents/issues/new?template=feature_request.yml) — the form will guide you through describing the problem and your proposed solution. You can also browse and join ongoing conversations in [Discussions](https://github.com/pixel-agents-hq/pixel-agents/discussions).

## Security Issues

Please report security vulnerabilities privately — see [SECURITY.md](SECURITY.md) for details.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.
