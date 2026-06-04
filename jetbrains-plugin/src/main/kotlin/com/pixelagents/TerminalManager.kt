package com.pixelagents

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import org.jetbrains.plugins.terminal.TerminalView

class TerminalManager(
    private val project: Project,
    private val terminalViewProvider: (Project) -> TerminalView = { TerminalView.getInstance(it) },
    private val edtInvoker: (() -> Unit) -> Unit = { block ->
        ApplicationManager.getApplication().invokeLater(block)
    },
) {
    private val log = Logger.getInstance(TerminalManager::class.java)

    fun openTerminal(sessionId: String) {
        edtInvoker {
            val workDir = project.basePath ?: System.getProperty("user.home")
            val view = terminalViewProvider(project)
            val widget = view.createLocalShellWidget(workDir, "Claude Agent")
            try {
                widget.executeCommand("claude --session-id $sessionId")
            } catch (e: java.io.IOException) {
                log.warn("Failed to send claude command to terminal: ${e.message}")
            }
        }
    }
}
