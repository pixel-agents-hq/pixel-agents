package com.pixelagents

import io.mockk.every
import io.mockk.mockk
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class ServerManagerTest {

    @TempDir
    lateinit var tempDir: Path

    private fun mockProcess(alive: Boolean = false): Process {
        val p = mockk<Process>(relaxed = true)
        every { p.isAlive } returns alive
        return p
    }

    // Synchronous executor so tests run without needing async waits
    private val syncExecutor: (Runnable) -> Unit = { it.run() }

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
            executor = syncExecutor,
        )

        manager.start()

        assertTrue(launched)
        assertEquals(3100, manager.portFuture.get(5, TimeUnit.SECONDS))
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
            executor = syncExecutor,
        )

        manager.start()

        assertFalse(launched)
        assertEquals(3100, manager.portFuture.get(5, TimeUnit.SECONDS))
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
            executor = syncExecutor,
        )

        manager.start()

        assertTrue(launched)
        assertEquals(3100, manager.portFuture.get(5, TimeUnit.SECONDS))
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
            executor = syncExecutor,
        )

        manager.start()
        manager.dispose()

        assertTrue(destroyed)
    }

    @Test
    fun `start completes future exceptionally when server never becomes healthy`() {
        val serverJsonPath = tempDir.resolve("server.json")

        val manager = ServerManager(
            projectDir = tempDir.toString(),
            serverJsonPath = serverJsonPath,
            processAliveChecker = { false },
            processLauncher = { _ -> mockProcess(alive = true) },
            healthChecker = { false },  // never healthy
            maxRetries = 1,             // instant timeout
            executor = syncExecutor,
        )

        manager.start()

        val ex = assertThrows<ExecutionException> {
            manager.portFuture.get(5, TimeUnit.SECONDS)
        }
        assertNotNull(ex.cause)
    }
}
