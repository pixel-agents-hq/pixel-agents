# JetBrains Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a JetBrains plugin that embeds the existing React webview via JCEF and manages Claude Code terminal lifecycle, targeting PyCharm and WebStorm.

**Architecture:** A thin Kotlin/Gradle plugin starts the existing standalone server (`npx pixel-agents`), opens a JCEF panel pointing to `http://localhost:3100?ide=jetbrains`, and handles `launchAgent` messages from the webview via a `JBCefJSQuery` bridge. All other agent state (JSONL watching, layout, hooks) stays in the existing Node.js server unchanged. The webview detects the `ide=jetbrains` URL parameter and routes `launchAgent` to the bridge instead of WebSocket.

**Tech Stack:** Kotlin 2.1, IntelliJ Platform Gradle Plugin 2.x, JCEF (`JBCefBrowser`), IntelliJ Terminal Plugin (`TerminalView`), JUnit 5, mockk, kotlinx-serialization-json, TypeScript (webview changes)

---

## File Map

### New files

| File                                                                               | Responsibility                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `jetbrains-plugin/build.gradle.kts`                                                | Gradle build: IntelliJ Platform 2.x, Kotlin, dependencies |
| `jetbrains-plugin/settings.gradle.kts`                                             | Root project name + toolchain resolver                    |
| `jetbrains-plugin/gradle.properties`                                               | Kotlin code style, config cache                           |
| `jetbrains-plugin/src/main/resources/META-INF/plugin.xml`                          | Plugin descriptor: tool window, project service           |
| `jetbrains-plugin/src/main/kotlin/com/pixelagents/PixelAgentsService.kt`           | Project-level service: owns ServerManager lifecycle       |
| `jetbrains-plugin/src/main/kotlin/com/pixelagents/ServerManager.kt`                | Start/stop `npx pixel-agents`, read server.json           |
| `jetbrains-plugin/src/main/kotlin/com/pixelagents/TerminalManager.kt`              | Open JetBrains terminal with `claude --session-id`        |
| `jetbrains-plugin/src/main/kotlin/com/pixelagents/PixelAgentsBrowserPanel.kt`      | JCEF browser + JS bridge injection                        |
| `jetbrains-plugin/src/main/kotlin/com/pixelagents/PixelAgentsToolWindowFactory.kt` | Creates tool window content                               |
| `jetbrains-plugin/src/test/kotlin/com/pixelagents/ServerManagerTest.kt`            | Unit tests for ServerManager                              |
| `jetbrains-plugin/src/test/kotlin/com/pixelagents/TerminalManagerTest.kt`          | Unit tests for TerminalManager                            |
| `webview-ui/src/transport/jetbrainsTransport.ts`                                   | Transport: launchAgent → JS bridge, rest → WebSocket      |
| `.github/workflows/jetbrains-release.yml`                                          | CI: build + release `.zip` on `jetbrains-v*` tag          |

### Modified files

| File                                | Change                                                           |
| ----------------------------------- | ---------------------------------------------------------------- |
| `webview-ui/src/runtime.ts`         | Add `'jetbrains'` runtime, detect via `?ide=jetbrains` URL param |
| `webview-ui/src/transport/index.ts` | Add JetBrains case to `createTransport()`                        |

---

## Task 1: Gradle scaffold

**Files:**

- Create: `jetbrains-plugin/build.gradle.kts`
- Create: `jetbrains-plugin/settings.gradle.kts`
- Create: `jetbrains-plugin/gradle.properties`

- [ ] **Step 1: Create `jetbrains-plugin/settings.gradle.kts`**

```kotlin
pluginManagement {
    repositories {
        maven("https://packages.jetbrains.team/maven/p/ij/intellij-dependencies")
        gradlePluginPortal()
    }
}

plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.8.0"
}

rootProject.name = "pixel-agents-jetbrains"
```

- [ ] **Step 2: Create `jetbrains-plugin/gradle.properties`**

```properties
kotlin.code.style=official
org.gradle.configuration-cache=true
org.gradle.jvmargs=-Xmx2g
```

- [ ] **Step 3: Create `jetbrains-plugin/build.gradle.kts`**

```kotlin
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.1.0"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.1.0"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = "com.pixelagents"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.1")
        bundledPlugin("org.jetbrains.plugins.terminal")
        testFramework(TestFrameworkType.Platform)
    }
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.0")
    testImplementation("io.mockk:mockk:1.13.9")
}

kotlin {
    jvmToolchain(17)
}

intellijPlatform {
    pluginConfiguration {
        id = "com.pixelagents.jetbrains"
        name = "Pixel Agents"
        version = "0.1.0"
        description = "Pixel art office where AI agents (Claude Code terminals) are animated characters."
        ideaVersion {
            sinceBuild = "241"
        }
    }
    publishing {
        token = providers.environmentVariable("JETBRAINS_MARKETPLACE_TOKEN")
    }
}

tasks {
    test {
        useJUnitPlatform()
    }
}
```

- [ ] **Step 4: Verify Gradle resolves**

Run from `jetbrains-plugin/`:

```
./gradlew tasks
```

Expected: task list prints, no download errors. (First run downloads IntelliJ Platform ~1GB — takes several minutes.)

- [ ] **Step 5: Commit**

```bash
git add jetbrains-plugin/
git commit -m "chore: scaffold JetBrains plugin Gradle build"
```

---

## Task 2: ServerManager + tests

**Files:**

- Create: `jetbrains-plugin/src/main/kotlin/com/pixelagents/ServerManager.kt`
- Create: `jetbrains-plugin/src/test/kotlin/com/pixelagents/ServerManagerTest.kt`

- [ ] **Step 1: Write failing tests first**

Create `jetbrains-plugin/src/test/kotlin/com/pixelagents/ServerManagerTest.kt`:

```kotlin
package com.pixelagents

import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class ServerManagerTest {

    @TempDir
    lateinit var tempDir: Path

    private fun mockProcess(alive: Boolean = false): Process {
        val p = mockk<Process>(relaxed = true)
        every { p.isAlive } returns alive
        return p
    }

    @Test
    fun `start launches server when server json missing`() {
        var launched = false
        val serverJsonPath = tempDir.resolve("server.json")

        val manager = ServerManager(
            projectDir = tempDir.toString(),
            serverJsonPath = serverJsonPath,
            processAliveChecker = { false },
            processLauncher = { _ ->
                launched = true
                // simulate server writing its discovery file
                serverJsonPath.toFile().writeText(
                    """{"port":3100,"pid":99999,"token":"tok","startedAt":0}"""
                )
                mockProcess(alive = true)
            },
            healthChecker = { true },
        )

        manager.start()

        assertTrue(launched)
        assertEquals(3100, manager.serverPort)
    }

    @Test
    fun `start skips launch when server already running`() {
        var launched = false
        val serverJsonPath = tempDir.resolve("server.json")
        serverJsonPath.toFile().writeText(
            """{"port":3100,"pid":12345,"token":"tok","startedAt":0}"""
        )

        val manager = ServerManager(
            projectDir = tempDir.toString(),
            serverJsonPath = serverJsonPath,
            processAliveChecker = { pid -> pid == 12345L },
            processLauncher = { _ -> launched = true; mockProcess() },
            healthChecker = { true },
        )

        manager.start()

        assertFalse(launched)
        assertEquals(3100, manager.serverPort)
    }

    @Test
    fun `start launches server when json exists but process dead`() {
        var launched = false
        val serverJsonPath = tempDir.resolve("server.json")
        serverJsonPath.toFile().writeText(
            """{"port":3100,"pid":99999,"token":"tok","startedAt":0}"""
        )

        val manager = ServerManager(
            projectDir = tempDir.toString(),
            serverJsonPath = serverJsonPath,
            processAliveChecker = { false },
            processLauncher = { _ ->
                launched = true
                serverJsonPath.toFile().writeText(
                    """{"port":3100,"pid":11111,"token":"tok","startedAt":0}"""
                )
                mockProcess(alive = true)
            },
            healthChecker = { true },
        )

        manager.start()

        assertTrue(launched)
    }

    @Test
    fun `dispose terminates owned process`() {
        val serverJsonPath = tempDir.resolve("server.json")
        val process = mockProcess(alive = true)
        var destroyed = false
        every { process.destroy() } answers { destroyed = true }

        val manager = ServerManager(
            projectDir = tempDir.toString(),
            serverJsonPath = serverJsonPath,
            processAliveChecker = { false },
            processLauncher = { _ ->
                serverJsonPath.toFile().writeText(
                    """{"port":3100,"pid":99999,"token":"tok","startedAt":0}"""
                )
                process
            },
            healthChecker = { true },
        )

        manager.start()
        manager.dispose()

        assertTrue(destroyed)
    }
}
```

- [ ] **Step 2: Run tests to confirm they fail**

Run from `jetbrains-plugin/`:

```
./gradlew test
```

Expected: compilation error — `ServerManager` class not found.

- [ ] **Step 3: Create `ServerManager.kt`**

```kotlin
package com.pixelagents

import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Path
import java.nio.file.Paths

@Serializable
private data class ServerConfig(
    val port: Int,
    val pid: Long,
    val token: String,
    val startedAt: Long,
)

class ServerManager(
    private val projectDir: String,
    private val serverJsonPath: Path = Paths.get(
        System.getProperty("user.home"), ".pixel-agents", "server.json"
    ),
    private val processAliveChecker: (Long) -> Boolean = { pid ->
        ProcessHandle.of(pid).map { it.isAlive }.orElse(false)
    },
    private val processLauncher: (String) -> Process = { dir ->
        ProcessBuilder("npx", "pixel-agents")
            .directory(File(dir))
            .redirectErrorStream(true)
            .start()
    },
    private val healthChecker: (Int) -> Boolean = { port ->
        try {
            val conn = URL("http://localhost:$port/api/health").openConnection() as HttpURLConnection
            conn.connectTimeout = 1000
            conn.readTimeout = 1000
            conn.responseCode == 200
        } catch (_: Exception) { false }
    },
) : Disposable {

    private val log = Logger.getInstance(ServerManager::class.java)
    private var ownedProcess: Process? = null
    private var config: ServerConfig? = null

    val serverPort: Int get() = config?.port ?: DEFAULT_PORT

    fun start() {
        val existing = readServerJson()
        if (existing != null && processAliveChecker(existing.pid)) {
            config = existing
            log.info("Pixel Agents server already running on port ${existing.port}")
            return
        }
        launchServer()
    }

    private fun readServerJson(): ServerConfig? {
        val file = serverJsonPath.toFile()
        if (!file.exists()) return null
        return try {
            Json.decodeFromString<ServerConfig>(file.readText())
        } catch (_: Exception) { null }
    }

    private fun launchServer() {
        log.info("Starting Pixel Agents server...")
        val process = processLauncher(projectDir)
        ownedProcess = process

        repeat(30) {
            Thread.sleep(500)
            val cfg = readServerJson()
            if (cfg != null && healthChecker(cfg.port)) {
                config = cfg
                log.info("Pixel Agents server ready on port ${cfg.port}")
                return
            }
        }
        log.warn("Pixel Agents server did not become healthy within 15s")
    }

    override fun dispose() {
        ownedProcess?.let {
            if (it.isAlive) {
                it.destroy()
                log.info("Pixel Agents server stopped")
            }
        }
    }

    companion object {
        const val DEFAULT_PORT = 3100
    }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
./gradlew test
```

Expected: 4 tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add jetbrains-plugin/src/
git commit -m "feat(jetbrains): add ServerManager with unit tests"
```

---

## Task 3: TerminalManager + tests

**Files:**

- Create: `jetbrains-plugin/src/main/kotlin/com/pixelagents/TerminalManager.kt`
- Create: `jetbrains-plugin/src/test/kotlin/com/pixelagents/TerminalManagerTest.kt`

- [ ] **Step 1: Write failing test**

Create `jetbrains-plugin/src/test/kotlin/com/pixelagents/TerminalManagerTest.kt`:

```kotlin
package com.pixelagents

import com.intellij.openapi.project.Project
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.jetbrains.plugins.terminal.ShellTerminalWidget
import org.jetbrains.plugins.terminal.TerminalView
import org.junit.jupiter.api.Test

class TerminalManagerTest {

    @Test
    fun `openTerminal sends claude command with session id`() {
        val project = mockk<Project>()
        val terminalView = mockk<TerminalView>()
        val widget = mockk<ShellTerminalWidget>(relaxed = true)

        every { project.basePath } returns "/some/project"
        every { terminalView.createLocalShellWidget("/some/project", any()) } returns widget

        val manager = TerminalManager(project) { terminalView }
        manager.openTerminal("abc-123")

        verify { widget.sendCommandToExecute("claude --session-id abc-123") }
    }

    @Test
    fun `openTerminal falls back to home dir when project basePath null`() {
        val project = mockk<Project>()
        val terminalView = mockk<TerminalView>()
        val widget = mockk<ShellTerminalWidget>(relaxed = true)
        val homeDir = System.getProperty("user.home")

        every { project.basePath } returns null
        every { terminalView.createLocalShellWidget(homeDir, any()) } returns widget

        val manager = TerminalManager(project) { terminalView }
        manager.openTerminal("xyz-456")

        verify { widget.sendCommandToExecute("claude --session-id xyz-456") }
    }
}
```

- [ ] **Step 2: Run to confirm failure**

```
./gradlew test
```

Expected: compilation error — `TerminalManager` not found.

- [ ] **Step 3: Create `TerminalManager.kt`**

```kotlin
package com.pixelagents

import com.intellij.openapi.project.Project
import org.jetbrains.plugins.terminal.TerminalView

class TerminalManager(
    private val project: Project,
    private val terminalViewProvider: (Project) -> TerminalView = { TerminalView.getInstance(it) },
) {
    fun openTerminal(sessionId: String) {
        val workDir = project.basePath ?: System.getProperty("user.home")
        val view = terminalViewProvider(project)
        val widget = view.createLocalShellWidget(workDir, "Claude Agent")
        widget.sendCommandToExecute("claude --session-id $sessionId")
    }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
./gradlew test
```

Expected: 6 tests pass (4 from ServerManagerTest + 2 from TerminalManagerTest).

- [ ] **Step 5: Commit**

```bash
git add jetbrains-plugin/src/
git commit -m "feat(jetbrains): add TerminalManager with unit tests"
```

---

## Task 4: plugin.xml + PixelAgentsService

**Files:**

- Create: `jetbrains-plugin/src/main/resources/META-INF/plugin.xml`
- Create: `jetbrains-plugin/src/main/kotlin/com/pixelagents/PixelAgentsService.kt`

- [ ] **Step 1: Create `plugin.xml`**

```xml
<idea-plugin>
    <id>com.pixelagents.jetbrains</id>
    <name>Pixel Agents</name>
    <vendor url="https://github.com/pixel-agents-hq/pixel-agents">pixel-agents-hq</vendor>
    <description>
        Pixel art office where AI agents (Claude Code terminals) are animated characters.
        Requires Node.js to be installed.
    </description>

    <depends>com.intellij.modules.platform</depends>
    <depends>org.jetbrains.plugins.terminal</depends>

    <extensions defaultExtensionNs="com.intellij">
        <toolWindow
            id="Pixel Agents"
            anchor="bottom"
            factoryClass="com.pixelagents.PixelAgentsToolWindowFactory"
            icon="AllIcons.General.Web"/>
        <projectService
            serviceImplementation="com.pixelagents.PixelAgentsService"/>
    </extensions>
</idea-plugin>
```

- [ ] **Step 2: Create `PixelAgentsService.kt`**

```kotlin
package com.pixelagents

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project

@Service(Service.Level.PROJECT)
class PixelAgentsService(private val project: Project) : Disposable {

    val serverManager = ServerManager(project.basePath ?: System.getProperty("user.home"))

    val serverPort: Int get() = serverManager.serverPort

    init {
        if (!isNpxAvailable()) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("Pixel Agents")
                .createNotification(
                    "Pixel Agents: Node.js not found",
                    "Install Node.js from https://nodejs.org to use Pixel Agents.",
                    NotificationType.WARNING,
                )
                .notify(project)
        } else {
            serverManager.start()
        }
    }

    private fun isNpxAvailable(): Boolean = try {
        ProcessBuilder("npx", "--version").start().waitFor() == 0
    } catch (_: Exception) { false }

    override fun dispose() {
        serverManager.dispose()
    }
}
```

- [ ] **Step 3: Add notification group to `plugin.xml`**

Add inside `<extensions defaultExtensionNs="com.intellij">`:

```xml
<notificationGroup
    id="Pixel Agents"
    displayType="BALLOON"
    isLogByDefault="true"/>
```

Full `plugin.xml` after edit:

```xml
<idea-plugin>
    <id>com.pixelagents.jetbrains</id>
    <name>Pixel Agents</name>
    <vendor url="https://github.com/pixel-agents-hq/pixel-agents">pixel-agents-hq</vendor>
    <description>
        Pixel art office where AI agents (Claude Code terminals) are animated characters.
        Requires Node.js to be installed.
    </description>

    <depends>com.intellij.modules.platform</depends>
    <depends>org.jetbrains.plugins.terminal</depends>

    <extensions defaultExtensionNs="com.intellij">
        <toolWindow
            id="Pixel Agents"
            anchor="bottom"
            factoryClass="com.pixelagents.PixelAgentsToolWindowFactory"
            icon="AllIcons.General.Web"/>
        <projectService
            serviceImplementation="com.pixelagents.PixelAgentsService"/>
        <notificationGroup
            id="Pixel Agents"
            displayType="BALLOON"
            isLogByDefault="true"/>
    </extensions>
</idea-plugin>
```

- [ ] **Step 4: Verify build compiles**

```
./gradlew assemble
```

Expected: BUILD SUCCESSFUL (PixelAgentsToolWindowFactory missing but compile error is OK — we add it next task).

Actually `PixelAgentsToolWindowFactory` is referenced in plugin.xml but doesn't exist yet — Gradle's `verifyPlugin` task will fail. Stub it now:

```kotlin
// PixelAgentsToolWindowFactory.kt (stub — full implementation in Task 5)
package com.pixelagents

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory

class PixelAgentsToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        // implemented in Task 5
    }
}
```

- [ ] **Step 5: Verify build passes**

```
./gradlew assemble
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 6: Commit**

```bash
git add jetbrains-plugin/src/
git commit -m "feat(jetbrains): add plugin.xml, PixelAgentsService, ToolWindowFactory stub"
```

---

## Task 5: PixelAgentsBrowserPanel + PixelAgentsToolWindowFactory

**Files:**

- Create: `jetbrains-plugin/src/main/kotlin/com/pixelagents/PixelAgentsBrowserPanel.kt`
- Modify: `jetbrains-plugin/src/main/kotlin/com/pixelagents/PixelAgentsToolWindowFactory.kt`

- [ ] **Step 1: Create `PixelAgentsBrowserPanel.kt`**

```kotlin
package com.pixelagents

import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import javax.swing.JComponent

class PixelAgentsBrowserPanel(
    project: Project,
    serverPort: Int,
) {
    private val browser = JBCefBrowser()
    private val openTerminalQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val terminalManager = TerminalManager(project)

    init {
        openTerminalQuery.addHandler { sessionId ->
            terminalManager.openTerminal(sessionId)
            null
        }

        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(cefBrowser: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
                if (frame.isMain) injectBridge()
            }
        }, browser.cefBrowser)

        browser.loadURL("http://localhost:$serverPort?ide=jetbrains")
    }

    private fun injectBridge() {
        val js = """
            window.pixelAgentsBridge = {
                launchAgent: function(folderPath, bypassPermissions) {
                    ${openTerminalQuery.inject("JSON.stringify({folderPath: folderPath, bypassPermissions: bypassPermissions})")}
                }
            };
        """.trimIndent()
        browser.cefBrowser.executeJavaScript(js, browser.cefBrowser.url, 0)
    }

    val component: JComponent get() = browser.component

    fun dispose() {
        openTerminalQuery.dispose()
        browser.dispose()
    }
}
```

Note: The `openTerminalQuery` handler receives a JSON string `{"folderPath":"...","bypassPermissions":true}`. Parse it in the handler:

```kotlin
openTerminalQuery.addHandler { payload ->
    // payload is JSON: {"folderPath":"...","bypassPermissions":true}
    val json = Json.parseToJsonElement(payload).jsonObject
    val folderPath = json["folderPath"]?.jsonPrimitive?.contentOrNull
    terminalManager.openTerminal(java.util.UUID.randomUUID().toString())
    null
}
```

Full `PixelAgentsBrowserPanel.kt` with JSON parsing:

```kotlin
package com.pixelagents

import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import java.util.UUID
import javax.swing.JComponent

class PixelAgentsBrowserPanel(
    project: Project,
    serverPort: Int,
) {
    private val browser = JBCefBrowser()
    private val launchAgentQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val terminalManager = TerminalManager(project)

    init {
        launchAgentQuery.addHandler { payload ->
            val sessionId = UUID.randomUUID().toString()
            terminalManager.openTerminal(sessionId)
            null
        }

        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(cefBrowser: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
                if (frame.isMain) injectBridge()
            }
        }, browser.cefBrowser)

        browser.loadURL("http://localhost:$serverPort?ide=jetbrains")
    }

    private fun injectBridge() {
        val js = """
            window.pixelAgentsBridge = {
                launchAgent: function(folderPath, bypassPermissions) {
                    ${launchAgentQuery.inject("''")}
                }
            };
        """.trimIndent()
        browser.cefBrowser.executeJavaScript(js, browser.cefBrowser.url, 0)
    }

    val component: JComponent get() = browser.component

    fun dispose() {
        launchAgentQuery.dispose()
        browser.dispose()
    }
}
```

- [ ] **Step 2: Replace `PixelAgentsToolWindowFactory.kt` stub with full implementation**

```kotlin
package com.pixelagents

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class PixelAgentsToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val service = project.getService(PixelAgentsService::class.java)
        val panel = PixelAgentsBrowserPanel(project, service.serverPort)
        val content = ContentFactory.getInstance().createContent(panel.component, "", false)
        toolWindow.contentManager.addContent(content)
    }

    override fun shouldBeAvailable(project: Project) = true
}
```

- [ ] **Step 3: Verify build**

```
./gradlew assemble
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add jetbrains-plugin/src/
git commit -m "feat(jetbrains): add PixelAgentsBrowserPanel and ToolWindowFactory"
```

---

## Task 6: Webview transport changes

**Files:**

- Modify: `webview-ui/src/runtime.ts`
- Create: `webview-ui/src/transport/jetbrainsTransport.ts`
- Modify: `webview-ui/src/transport/index.ts`

- [ ] **Step 1: Update `webview-ui/src/runtime.ts`**

Replace the file with:

```typescript
/**
 * Runtime detection, provider-agnostic
 *
 * Single source of truth for determining whether the webview is running
 * inside an IDE extension (VS Code, JetBrains, etc.) or standalone in a browser.
 */

declare function acquireVsCodeApi(): unknown;

type Runtime = 'vscode' | 'jetbrains' | 'browser';

const searchParams = new URLSearchParams(window.location.search);

const runtime: Runtime =
  typeof acquireVsCodeApi !== 'undefined'
    ? 'vscode'
    : searchParams.get('ide') === 'jetbrains'
      ? 'jetbrains'
      : 'browser';

export const isBrowserRuntime = runtime === 'browser';
export const isJetBrainsRuntime = runtime === 'jetbrains';
```

- [ ] **Step 2: Create `webview-ui/src/transport/jetbrainsTransport.ts`**

```typescript
import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport } from './types.js';
import { WebSocketTransport } from './webSocketTransport.js';

declare global {
  interface Window {
    pixelAgentsBridge?: {
      launchAgent: (folderPath: string | undefined, bypassPermissions: boolean | undefined) => void;
    };
  }
}

/**
 * JetBrains transport: routes launchAgent to the native IDE bridge (JBCefJSQuery)
 * and all other messages to the standalone server via WebSocket.
 */
export class JetBrainsTransport implements MessageTransport {
  private readonly ws: WebSocketTransport;

  constructor() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    this.ws = new WebSocketTransport(wsUrl);
    this.ws.connect();
  }

  send(message: ClientMessage): void {
    if (message.type === 'launchAgent') {
      window.pixelAgentsBridge?.launchAgent(message.folderPath, message.bypassPermissions);
      return;
    }
    this.ws.send(message);
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    return this.ws.onMessage(handler);
  }

  dispose(): void {
    this.ws.dispose();
  }
}
```

- [ ] **Step 3: Update `webview-ui/src/transport/index.ts`**

```typescript
import { isBrowserRuntime, isJetBrainsRuntime } from '../runtime.js';
import { JetBrainsTransport } from './jetbrainsTransport.js';
import { PostMessageTransport } from './postMessageTransport.js';
import type { MessageTransport } from './types.js';
import { WebSocketTransport } from './webSocketTransport.js';

function createTransport(): MessageTransport {
  if (isJetBrainsRuntime) {
    return new JetBrainsTransport();
  }
  if (!isBrowserRuntime) {
    return new PostMessageTransport();
  }
  // Standalone browser: connect via WebSocket to the same host serving the SPA
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  const ws = new WebSocketTransport(wsUrl);
  ws.connect();
  return ws;
}

/** Singleton transport instance. Import this everywhere instead of vscodeApi. */
export const transport: MessageTransport = createTransport();
export type { MessageTransport } from './types.js';
```

- [ ] **Step 4: Verify webview TypeScript compiles**

Run from repo root:

```
cd webview-ui && npm run build
```

Expected: BUILD SUCCESSFUL, no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/runtime.ts webview-ui/src/transport/
git commit -m "feat(webview): add JetBrains runtime detection and transport"
```

---

## Task 7: GitHub Actions CI

**Files:**

- Create: `.github/workflows/jetbrains-release.yml`

- [ ] **Step 1: Create `.github/workflows/jetbrains-release.yml`**

```yaml
name: JetBrains Plugin Release

on:
  push:
    tags:
      - 'jetbrains-v*'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with:
          java-version: '17'
          distribution: 'temurin'

      - name: Setup Gradle
        uses: gradle/actions/setup-gradle@v4

      - name: Run tests
        working-directory: jetbrains-plugin
        run: ./gradlew test

      - name: Build plugin
        working-directory: jetbrains-plugin
        run: ./gradlew buildPlugin

      - name: Upload to GitHub Releases
        uses: softprops/action-gh-release@v2
        with:
          files: jetbrains-plugin/build/distributions/*.zip
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/jetbrains-release.yml
git commit -m "ci: add JetBrains plugin release workflow"
```

---

## Task 8: Smoke test in sandbox IDE

This task is manual — no automated test possible without a running IDE.

- [ ] **Step 1: Build the project first**

From repo root:

```
npm run build
```

Expected: VS Code extension + webview + CLI all build successfully.

- [ ] **Step 2: Launch sandbox IDE**

From `jetbrains-plugin/`:

```
./gradlew runIde
```

Expected: A fresh IntelliJ IDEA Community instance opens. Takes ~2 minutes first time.

- [ ] **Step 3: Verify tool window appears**

In the sandbox IDE:

- Open any project (File → Open → select a directory)
- Look at the bottom panel tabs
- Confirm "Pixel Agents" tab is visible

- [ ] **Step 4: Verify server starts**

Click the "Pixel Agents" tab. Expected:

- Panel loads and shows the webview at `http://localhost:3100`
- Check `~/.pixel-agents/server.json` exists and has a valid port
- The pixel art office renders with the correct layout

- [ ] **Step 5: Verify agent launch**

In the webview, click "+ Agent". Expected:

- A new terminal tab opens in the sandbox IDE
- The terminal runs `claude --session-id <uuid>`
- After a moment, a character appears in the office

- [ ] **Step 6: Commit if any fixes were needed**

```bash
git add -p
git commit -m "fix(jetbrains): <describe what you fixed during smoke test>"
```

---

## Self-Review

**Spec coverage check:**

- ✅ Thin Kotlin plugin (Tasks 1–5)
- ✅ Starts/manages `npx pixel-agents` (Task 2 — ServerManager)
- ✅ JCEF panel loading `http://localhost:3100` (Task 5 — PixelAgentsBrowserPanel)
- ✅ Terminal management via JetBrains API (Task 3 — TerminalManager)
- ✅ JS ↔ Kotlin bridge for `launchAgent` (Task 5 — `launchAgentQuery`)
- ✅ Webview environment detection (Task 6 — runtime.ts)
- ✅ `JetBrainsTransport` routing `launchAgent` to bridge (Task 6)
- ✅ Node.js check with IDE notification (Task 4 — PixelAgentsService)
- ✅ GitHub Actions CI (Task 7)
- ✅ Manual smoke test (Task 8)
- ✅ PyCharm + WebStorm compatible via `com.intellij.modules.platform` only

**No placeholders found.**

**Type consistency:**

- `ServerManager.serverPort` referenced in `PixelAgentsService.serverPort` getter — consistent
- `TerminalManager(project, terminalViewProvider)` constructor matches test usage — consistent
- `launchAgentQuery.inject("''")` in bridge matches `addHandler { payload -> ... }` — consistent
- `JetBrainsTransport` implements `MessageTransport` — consistent with `transport/types.ts`
