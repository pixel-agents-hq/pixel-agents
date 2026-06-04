package com.pixelagents

import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import java.util.UUID
import javax.swing.JComponent
import javax.swing.JLabel

class PixelAgentsBrowserPanel(
    project: Project,
    private val portFuture: java.util.concurrent.CompletableFuture<Int>,
    parentDisposable: Disposable,
) : Disposable {

    private val browser: JBCefBrowser?
    private val launchAgentQuery: JBCefJSQuery?
    private val terminalManager = TerminalManager(project)
    private val fallbackComponent: JComponent?
    private val loadHandler: CefLoadHandlerAdapter?

    init {
        if (JBCefApp.isSupported()) {
            val b = JBCefBrowser()
            browser = b
            val query = JBCefJSQuery.create(b as JBCefBrowserBase)
            launchAgentQuery = query

            query.addHandler { _ ->
                val sessionId = UUID.randomUUID().toString()
                terminalManager.openTerminal(sessionId)
                null
            }

            val handler = object : CefLoadHandlerAdapter() {
                override fun onLoadEnd(cefBrowser: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
                    if (frame.isMain) injectBridge()
                }
            }
            loadHandler = handler
            b.jbCefClient.addLoadHandler(handler, b.cefBrowser)

            portFuture.thenAccept { port ->
                browser?.loadURL("http://localhost:$port?ide=jetbrains")
            }.exceptionally { _ ->
                // server failed to start — show nothing, browser remains at blank page
                null
            }

            fallbackComponent = null
            Disposer.register(parentDisposable, this)
        } else {
            browser = null
            launchAgentQuery = null
            loadHandler = null
            fallbackComponent = JLabel(
                "<html><body style='padding:16px'>" +
                    "<b>Pixel Agents</b><br><br>" +
                    "JCEF is not available in this IDE configuration.<br>" +
                    "Please use the bundled JetBrains Runtime to enable the embedded browser." +
                    "</body></html>"
            )
        }
    }

    private fun injectBridge() {
        val b = browser ?: return
        val query = launchAgentQuery ?: return
        val js = """
            window.pixelAgentsBridge = {
                launchAgent: function(folderPath, bypassPermissions) {
                    ${query.inject("JSON.stringify({folderPath: folderPath, bypassPermissions: bypassPermissions})")}
                }
            };
        """.trimIndent()
        b.cefBrowser.executeJavaScript(js, b.cefBrowser.url, 0)
    }

    val component: JComponent
        get() = browser?.component ?: fallbackComponent!!

    /** Hard reload: re-navigates the embedded browser, re-initializing the webview. */
    fun reload() {
        val b = browser ?: return
        if (portFuture.isDone && !portFuture.isCompletedExceptionally) {
            b.loadURL("http://localhost:${portFuture.get()}?ide=jetbrains")
        } else {
            b.cefBrowser.reload()
        }
    }

    override fun dispose() {
        val b = browser
        if (b != null && loadHandler != null) {
            b.jbCefClient?.removeLoadHandler(loadHandler, b.cefBrowser)
        }
        launchAgentQuery?.dispose()
        browser?.dispose()
    }
}
