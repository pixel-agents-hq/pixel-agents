package com.pixelagents

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project

@Service(Service.Level.PROJECT)
class PixelAgentsService(private val project: Project) : Disposable {

    private val serverManager = ServerManager(project.basePath ?: System.getProperty("user.home"))

    val serverPort: Int get() = serverManager.serverPort
    val portFuture: java.util.concurrent.CompletableFuture<Int> get() = serverManager.portFuture

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
        val cmd = if (System.getProperty("os.name").startsWith("Windows"))
            listOf("cmd", "/c", "npx", "--version")
        else
            listOf("npx", "--version")
        ProcessBuilder(cmd).start().waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
    } catch (_: Exception) { false }

    override fun dispose() {
        serverManager.dispose()
    }
}
