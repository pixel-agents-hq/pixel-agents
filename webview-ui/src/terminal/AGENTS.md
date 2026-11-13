# webview-ui/src/terminal/ - standalone terminal client (xterm)

Score 8, distinct domain: per-agent PTY byte plane + security-sensitive link/clipboard handling. 11 files, ~1.6k LOC, no barrel; consumers import explicit `.js` paths. Standalone only.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| `/terminal/:agentId` socket, reconnect, replay | `terminalClient.ts` | most-imported (5 files): `TerminalConnection`, `TerminalConnectionStatus` |
| Link activation | `terminalLinks.ts` | `terminalLinkOpener`, `urlAtCell`, scheme allowlist |
| Clipboard I/O | `clipboard.ts` | the only read/write path |
| Copy chords, OSC 52 decode | `clipboardKeys.ts` (pure), `clipboardInput.ts` (DOM) | |
| Opt-in soft-wrap re-flow | `flowCopy.ts` | |
| Touch state machine | `touchGesture.ts` (pure, 450 LOC), `touchInput.ts` (DOM adapter) | |
| Selection maths / overlay | `selectionMath.ts` (pure), `selectionOverlay.ts` (DOM) | |
| Screen geometry | `terminalDom.ts` | |

## CONVENTIONS
- Pure rule modules + thin DOM adapters; tests (`webview-ui/test/*`) exercise only the pure side. Link opener takes `open` as a parameter to stay DOM-free.
- Cell geometry and selection logic live once (`selectionMath.ts`, `terminalDom.ts`); adapters call them.
- Adapters bind rescue listeners on the touch target: WebKit keeps addressing events to a node that repainting detached.
- Opened links: new tab, no opener, no referrer - the page URL carries the server token.
- Protocol constants (`TERMINAL_LINK_PROTOCOLS`, `TERMINAL_URL_PATTERN`) live in `../constants.ts`.

## ANTI-PATTERNS
- Routing terminal bytes through `MessageTransport` or adding them to `core/asyncapi.yaml`.
- Opening any non-http(s) scheme (OSC 8 targets are untrusted: `javascript:`, `file:`, OS handlers).
- Using xterm's built-in OSC 8 activator or a second URL regex for taps vs clicks.
- Calling `navigator.clipboard` directly; answering OSC 52 clipboard-READ requests.
- Re-flowing copy by default - verbatim unless Alt+C / "Copy as text".
- Gesture decisions inside `touchInput.ts` instead of the reducer.
