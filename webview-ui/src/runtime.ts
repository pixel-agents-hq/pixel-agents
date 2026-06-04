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
