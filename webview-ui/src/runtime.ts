/**
 * Runtime detection, provider-agnostic
 *
 * Single source of truth for determining whether the webview is running
 * inside an IDE extension (VS Code, Cursor, Windsurf, etc.) or standalone
 * in a browser.
 */

declare function acquireVsCodeApi(): unknown;

type Runtime = "vscode" | "browser";
// Future: 'cursor' | 'windsurf' | 'electron' | etc.

const runtime: Runtime =
  typeof acquireVsCodeApi !== "undefined" ? "vscode" : "browser";

export const isBrowserRuntime = runtime === "browser";
