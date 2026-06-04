package com.pixelagents

import com.intellij.openapi.project.Project
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.jetbrains.plugins.terminal.ShellTerminalWidget
import org.jetbrains.plugins.terminal.TerminalView
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Test

class TerminalManagerTest {

    private fun syncManager(project: Project, view: TerminalView) =
        TerminalManager(project, terminalViewProvider = { view }, edtInvoker = { it() })

    @Test
    fun `openTerminal sends claude command with session id`() {
        val project = mockk<Project>()
        val terminalView = mockk<TerminalView>()
        val widget = mockk<ShellTerminalWidget>(relaxed = true)

        every { project.basePath } returns "/some/project"
        every { terminalView.createLocalShellWidget("/some/project", any()) } returns widget

        syncManager(project, terminalView).openTerminal("abc-123")

        verify { widget.executeCommand("claude --session-id abc-123") }
    }

    @Test
    fun `openTerminal falls back to home dir when project basePath null`() {
        val project = mockk<Project>()
        val terminalView = mockk<TerminalView>()
        val widget = mockk<ShellTerminalWidget>(relaxed = true)
        val homeDir = System.getProperty("user.home")

        every { project.basePath } returns null
        every { terminalView.createLocalShellWidget(homeDir, any()) } returns widget

        syncManager(project, terminalView).openTerminal("xyz-456")

        verify { widget.executeCommand("claude --session-id xyz-456") }
    }

    @Test
    fun `openTerminal does not throw when executeCommand fails with IOException`() {
        val project = mockk<Project>()
        val terminalView = mockk<TerminalView>()
        val widget = mockk<ShellTerminalWidget>(relaxed = true)

        every { project.basePath } returns "/some/project"
        every { terminalView.createLocalShellWidget("/some/project", any()) } returns widget
        every { widget.executeCommand(any()) } throws java.io.IOException("shell busy")

        assertDoesNotThrow { syncManager(project, terminalView).openTerminal("fail-123") }
    }
}
