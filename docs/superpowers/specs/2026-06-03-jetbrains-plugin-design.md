# JetBrains Plugin Design

**Date:** 2026-06-03
**Status:** Approved
**Target IDEs:** PyCharm, WebStorm (IntelliJ platform — all IDEs compatible)

## Overview

Thin Kotlin plugin that embeds the existing React webview via JCEF and manages Claude Code terminal lifecycle. All agent logic stays in the existing standalone Node.js server (`npx pixel-agents`). No logic duplication.

## Architecture

```
jetbrains-plugin/
  build.gradle.kts
  gradle.properties
  settings.gradle.kts
  src/main/kotlin/com/pixelagents/
    PixelAgentsToolWindowFactory.kt
    PixelAgentsBrowserPanel.kt
    ServerManager.kt
    TerminalManager.kt
    PixelAgentsService.kt
  src/main/resources/META-INF/
    plugin.xml
```

### Startup flow

1. `PixelAgentsService` starts → reads `~/.pixel-agents/server.json`
2. If server not running → spawns `npx pixel-agents --port 3100`
3. User opens "Pixel Agents" panel → `PixelAgentsBrowserPanel` loads `http://localhost:3100`
4. React webview works unchanged

### JS ↔ Kotlin bridge

Replaces VS Code's `postMessage` protocol:

- **JS → Kotlin:** `JBCefJSQuery` — actions like `openTerminal(sessionId)`
- **Kotlin → JS:** `executeJavaScript()` — same message shapes the webview already expects

## Components

### `ServerManager.kt`

- On start: check `~/.pixel-agents/server.json`, verify PID alive
- If no server: run `npx pixel-agents`, poll `GET /api/health` until ready
- On IDE close: terminate process if we own it, leave it if external
- Auto-restart on crash: 3 attempts with exponential backoff

### `TerminalManager.kt`

- Receives `openTerminal(sessionId)` from JS bridge
- Uses `TerminalView.getInstance(project)` from IntelliJ platform
- Launches `claude --session-id <uuid>` in project directory
- Mirrors `agentManager.ts` logic from VS Code extension

### `PixelAgentsBrowserPanel.kt`

- `JBCefBrowser` pointing to `http://localhost:3100`
- Injects bridge on load: `window.pixelAgentsBridge = { openTerminal, ... }`
- Webview detects environment: `window.pixelAgentsBridge` → JetBrains, `acquireVsCodeApi` → VS Code

### `plugin.xml`

- `depends`: `com.intellij.modules.platform` only (no PyCharm/WebStorm-specific modules)
- Tool window: `anchor="bottom"`, matches VS Code panel behavior

## Webview changes (minimal)

**`webview-ui/src/App.tsx`** — environment detection:

```ts
const isJetBrains = typeof window.pixelAgentsBridge !== 'undefined';
const isVSCode = typeof acquireVsCodeApi !== 'undefined';
```

Route `openClaude` message to the correct bridge. No changes to rendering, animations, or layout logic.

## Build & Distribution

### Gradle build

```kotlin
plugins {
    id("org.jetbrains.intellij.platform") version "2.x"
    kotlin("jvm") version "2.x"
}
intellijPlatform {
    pluginConfiguration {
        id = "com.pixelagents.jetbrains"
        name = "Pixel Agents"
    }
    // Target IC-2024.1+ covers PyCharm CE, WebStorm, IntelliJ IDEA
}
```

- `./gradlew buildPlugin` → `build/distributions/pixel-agents-X.X.X.zip`
- `./gradlew runIde` → sandbox IDE for development testing

### GitHub Actions

- New workflow: `.github/workflows/jetbrains-release.yml`
- Trigger: tag `jetbrains-v*`
- Steps: build → test → upload `.zip` to GitHub Releases
- Independent of VS Code release workflow

### JetBrains Marketplace

- Initial submission: manual `.zip` upload
- Automated later via `publishPlugin` Gradle task + Marketplace token

## Prerequisites

- Node.js must be installed (plugin checks on startup)
- If missing: IDE notification with install link
- Node.js not bundled (too large for a plugin)

## Testing

- `./gradlew test` — Kotlin unit tests for `ServerManager`, `TerminalManager`
- `./gradlew runIde` — manual testing in sandbox
- No automated E2E initially (matches current VS Code coverage)

## Files changed

| File                                      | Change                                           |
| ----------------------------------------- | ------------------------------------------------ |
| `jetbrains-plugin/`                       | New Gradle project (~8 Kotlin files)             |
| `webview-ui/src/App.tsx`                  | Environment detection (bridge vs VS Code API)    |
| `.github/workflows/jetbrains-release.yml` | New CI workflow                                  |
| `server/package.json`                     | Verify `bin` entry exists for `npx pixel-agents` |

## Out of scope (future)

- Bundling Node.js runtime
- Full WebSocket control protocol (Kotlin → server commands)
- Support for other JetBrains IDEs beyond PyCharm/WebStorm (compatible but untested)
- Automated Marketplace publishing
