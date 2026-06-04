package com.pixelagents

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class PixelAgentsToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val service = project.getService(PixelAgentsService::class.java)
        val panel = PixelAgentsBrowserPanel(project, service.portFuture, toolWindow.disposable)
        val content = ContentFactory.getInstance().createContent(panel.component, "", false)
        toolWindow.contentManager.addContent(content)

        val reloadAction = object : AnAction(
            "Reload",
            "Reload the Pixel Agents office",
            AllIcons.Actions.Refresh,
        ) {
            override fun actionPerformed(e: AnActionEvent) = panel.reload()
        }
        toolWindow.setTitleActions(listOf(reloadAction))
    }

    override fun shouldBeAvailable(project: Project) = true
}
