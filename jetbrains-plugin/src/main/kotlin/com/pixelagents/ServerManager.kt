package com.pixelagents

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Path
import java.nio.file.Paths
import java.util.concurrent.CompletableFuture

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
        val cmd = if (System.getProperty("os.name").startsWith("Windows"))
            listOf("cmd", "/c", "npx", "it-crowd-pixel-agents")
        else
            listOf("npx", "it-crowd-pixel-agents")
        ProcessBuilder(cmd)
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
    private val maxRetries: Int = 30,
    private val executor: (Runnable) -> Unit = { r ->
        ApplicationManager.getApplication().executeOnPooledThread(r)
    },
) : Disposable {

    private val log = Logger.getInstance(ServerManager::class.java)
    @Volatile private var ownedProcess: Process? = null
    private var config: ServerConfig? = null

    val portFuture: CompletableFuture<Int> = CompletableFuture()

    val serverPort: Int get() = portFuture.getNow(DEFAULT_PORT)

    fun start() {
        val existing = readServerJson()
        if (existing != null && processAliveChecker(existing.pid)) {
            config = existing
            log.info("Pixel Agents server already running on port ${existing.port}")
            portFuture.complete(existing.port)
            return
        }
        executor(Runnable { launchServer() })
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

        repeat(maxRetries) {
            Thread.sleep(500)
            val cfg = readServerJson()
            if (cfg != null && healthChecker(cfg.port)) {
                config = cfg
                log.info("Pixel Agents server ready on port ${cfg.port}")
                portFuture.complete(cfg.port)
                return
            }
        }
        log.warn("Pixel Agents server did not become healthy within 15s")
        ownedProcess?.destroy()
        ownedProcess = null
        portFuture.completeExceptionally(RuntimeException("Pixel Agents server failed to start"))
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
