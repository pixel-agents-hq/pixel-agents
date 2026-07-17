# Standalone Terminal

Status: proposed (branch `feat/standalone-terminal`)
Author: implementation agent, for review by @pablodelucca

## Goal

Give the standalone surface (`npx pixel-agents`) launch/focus/close parity with the VS Code
extension by embedding a real terminal in the browser SPA.

Today the two surfaces are asymmetric:

| Capability       | VS Code                                   | Standalone (before)                   |
| ---------------- | ----------------------------------------- | ------------------------------------- |
| Launch an agent  | `launchNewTerminal()` → `vscode.Terminal` | **`launchAgent` silently dropped**    |
| Focus an agent   | `terminalRef.show()`                      | **`focusAgent` silently dropped**     |
| Close an agent   | `terminalRef.dispose()`                   | dismiss + remove (no process to kill) |
| See agent output | VS Code terminal panel                    | **nothing**                           |

`server/src/clientMessageHandler.ts` routed `launchAgent` and `focusAgent` into its `default:`
branch ("require IDE-specific handling"), and `BottomToolbar.tsx` hid the `+ Agent` button
behind `!isBrowserRuntime`. Standalone could only _observe_ agents started elsewhere.

After this change, standalone spawns Claude in a server-side PTY and streams it to an
xterm.js drawer in the browser.

## Architecture

```
Browser SPA                          Fastify server                     OS
───────────                          ──────────────                     ──
BottomToolbar "+ Agent"
   └─ launchAgent (ClientMessage, /ws)
                          ──────────▶ clientMessageHandler
                                        └─ launchStandaloneAgent()
                                             ├─ provider.buildLaunchCommand(sessionId, cwd)
                                             ├─ PtySessionManager.create(agentId, …) ─▶ pty.spawn(claude)
                                             ├─ store.set(agent)  ─▶ agentCreated broadcast
                                             └─ terminalSessionOpened broadcast
TerminalDrawer (xterm.js)
   └─ WS /terminal/:agentId  ────────▶ terminal WS route
        ◀── {type:"replay"} ──────────── PtySession.snapshot() (serialized mirror)
        ◀── {type:"output"} ──────────── pty.onData
        ─── {type:"input"} ───────────▶  pty.write
        ─── {type:"resize"} ──────────▶  pty.resize
        ◀── {type:"exit"} ────────────── pty.onExit
```

Layering is unchanged: everything new on the server lives under `server/src/terminal/`, depends
only on `core/`, and is never imported by `adapters/vscode/`. The webview drawer depends only on
`core/` + the existing transport singleton.

### Why a separate launch path instead of a shared one

`adapters/vscode/agentManager.ts:launchNewTerminal()` is a 190-line function that takes twelve
positional dependency arguments and imports `vscode`. The standalone launcher
(`server/src/terminal/standaloneAgentLauncher.ts`) deliberately **mirrors** it rather than
refactoring it into a shared core:

- The VS Code path can't move into `server/` (it imports `vscode`).
- Unifying both would mean rewriting `launchNewTerminal`'s signature, which touches
  `PixelAgentsViewProvider` and the whole VS Code lifecycle — well outside this feature, and a
  guaranteed conflict with six sibling branches developing off the same base.

Both launchers reuse `claudeProvider.buildLaunchCommand(sessionId, cwd, { bypassPermissions })`,
so the _command_ is shared even though the _hosting_ is not. **Unifying the two launch paths is
explicitly deferred** — see "Deferred".

### `TerminalAdapter` is not the seam this feature needs

`core/src/terminalAdapter.ts` (`ITerminalAdapter`) exposes only `activeTerminal()` /
`allTerminals()`, and its sole consumer is `fileWatcher.ts`, which casts the handles to
`vscode.Terminal` to adopt JSONL files onto the terminal the user is looking at. It is a
_VS Code terminal-adoption_ seam, not a terminal-lifecycle seam, and `AgentRuntime` never
touches it. Implementing it for standalone would mean implementing `activeTerminal()` for a
concept standalone doesn't have (there is no "focused" terminal server-side; focus is a browser
UI concern).

So this branch leaves `ITerminalAdapter` alone and introduces `PtySessionManager` as the
standalone terminal-lifecycle owner. **Open question for Pablo below.**

## Dependency strategy: node-pty (the important part)

A PTY is non-negotiable for this feature: Claude Code is a full-screen TUI. `child_process.spawn`
with pipes gives no TTY, no resize, no line discipline, and Claude renders unusably. `node-pty` is
the standard, but it is a **native module**, which is a real concern for `npx pixel-agents`.

### What I measured (npm 11.16.0, Node 26.3.1, darwin-arm64)

| Package                          | Install | Result                                                           |
| -------------------------------- | ------- | ---------------------------------------------------------------- |
| `node-pty@1.1.0`                 | 960 ms  | **`require()` succeeds, `spawn()` throws `posix_spawnp failed`** |
| `@lydell/node-pty@1.2.0-beta.12` | 621 ms  | **works** — `DATA:"PTY_OK\r\n"`, `EXIT 0`                        |

Two independent problems with official `node-pty`:

**1. No Linux prebuilds.** `node-pty@1.1.0` ships `prebuilds/` for exactly four targets:

```
darwin-arm64  darwin-x64  win32-arm64  win32-x64
```

There is **no `linux-x64` and no `linux-arm64`**. On Linux its install script
(`node scripts/prebuild.js || node-gyp rebuild`) falls through to `node-gyp`, which needs Python
and a C++ toolchain. For an `npx` one-liner aimed at "run this and see your agents", requiring a
build toolchain on the most common server/dev-container platform is not acceptable.

**2. npm now blocks install scripts by default.** npm 11.16 gates lifecycle scripts behind
`npm approve-scripts`. This is npm's new default, not a local setting — verified:
`npm config get ignore-scripts` → `false`, and no `.npmrc` in the repo or `~`. With scripts
gated, `node-pty`'s `prebuild.js` (copies `prebuilds/<platform>` → `build/Release`) and
`post-install.js` (chmod `+x` the `spawn-helper` binary) never run. The module still
_loads_ — and then fails at `spawn()` with `posix_spawnp failed`, because `spawn-helper` is
`-rw-r--r--`.

That second finding drove a design decision: **`require()` succeeding does not mean the terminal
works.** Availability must be established by actually spawning a PTY, not by a successful import.

### Decision

**Primary: `@lydell/node-pty` as an `optionalDependency`, with `node-pty` as a fallback candidate.**

`@lydell/node-pty` distributes per-platform prebuilt binaries as optionalDependencies
(`@lydell/node-pty-{linux,darwin,win32}-{x64,arm64}` — all six targets) with **no install
scripts at all**, the same model esbuild uses. npm picks the right binary by `os`/`cpu`; nothing
compiles, nothing needs chmod, and npm's script gating is irrelevant.

The loader (`server/src/terminal/ptyModule.ts`) tries a _list_ of module ids in order:

```ts
const PTY_MODULE_CANDIDATES = ['@lydell/node-pty', 'node-pty'];
```

so a user or distro that prefers the Microsoft package can simply install it and it will be
picked up — we are not hard-coupled to the fork.

**Tradeoff, stated plainly:** `@lydell/node-pty` is a third-party fork on a **beta** version tag
(`1.2.0-beta.12`), whereas `node-pty` is maintained by Microsoft and powers VS Code itself.
Taking the fork trades maintainer pedigree for install reliability. Three things de-risk it:

1. It is an `optionalDependency` — if it fails to install, `npm install` still succeeds.
2. The feature degrades gracefully (below) — a missing/broken PTY turns the terminal off,
   it never breaks the office view, which is the app's actual core.
3. The fallback candidate list means switching back to `node-pty` is a one-line change.

### Graceful degradation

`PtySessionManager.probe()` runs **once**, lazily, on first use:

1. Try each candidate module id in `require()`. All fail → unavailable
   (`reason: "no PTY module installed"`).
2. Actually spawn a throwaway PTY, and kill it. Throws → unavailable
   (`reason: "<the real error>"`, e.g. `posix_spawnp failed`).

The result is cached. Availability is broadcast to the client as `terminalAvailability
{ available, reason? }` on `webviewReady`, and:

- The server logs one clear `[Pixel Agents]` warning line with the reason and the remedy.
- The SPA hides `+ Agent` and shows the reason in the drawer instead of a dead terminal.

This is why availability is a _probe_ and not a `try { require } catch`: the npm-11 case produces
a module that imports fine and fails on first keystroke.

## Security model

**The terminal endpoint is arbitrary code execution.** It spawns a process and pipes a browser's
keystrokes into it. It is the most sensitive surface in the codebase and is treated accordingly.

### Bind behavior (verified, unchanged)

`server/src/cli.ts:parseArgs` defaults `host` to `127.0.0.1`, and
`httpServer.ts:createHttpServer` passes `options.host ?? '127.0.0.1'` to `app.listen`. The server
is loopback-only by default. `--host` can override it; the CLI now prints an explicit warning
when `--host` is set to a non-loopback address _and_ a terminal is available, because that
exposes a shell to the network.

`--no-terminal` removes the shell surface entirely: the CLI builds the manager via
`PtySessionManager.disabled(reason)`, which reports "unavailable" through the same plumbing as a
failed module resolution (availability broadcast, session route, launcher), so the browser shows
a disabled + Agent button with the reason and never opens a terminal socket. This is the intended
configuration for a watch-only dashboard, especially one bound off-loopback.

### The existing `/ws` does not authenticate in standalone

```ts
// httpServer.ts, registerWebSocketRoute
if (options.embedded) {   // <-- standalone skips auth entirely
  ...timingSafeEqual(Bearer token)...
}
```

The comment reasons "the server binds to 127.0.0.1, so only local clients can connect". That is
**not** a sufficient argument for the terminal route, for two reasons:

1. **WebSockets are not subject to CORS.** Any page on the internet the user visits can open
   `ws://127.0.0.1:<port>/terminal/1` and get a shell. The same-origin policy does not stop the
   _connection_, only (for HTTP) the _read_.
2. `@fastify/cors` is registered with `origin: true`, which **reflects any Origin** into
   `Access-Control-Allow-Origin`. So cross-origin `fetch()` reads of our HTTP routes succeed too.

Port scanning localhost from a web page is a well-known, practical attack. So the instruction to
match `/ws`'s scheme would mean _no auth_, which I've deliberately not done.

**The terminal route always requires the auth token, in both modes.** I did not change `/ws`'s
auth (out of scope, and six branches share this file), but this asymmetry should be revisited —
see open questions.

### How the token reaches the browser

The browser can't read `~/.pixel-agents/server.json`, and the `WebSocket` constructor can't set
an `Authorization` header. So:

1. **`GET /api/terminal/session`** returns `{ token, available, reason? }`, guarded by
   `isTrustedTerminalRequest`: (a) if an `Origin` header is present and its host doesn't match the
   request's `Host`, respond `403`; and (b) when the server is bound to loopback, the `Host` header
   must itself name a loopback host, else `403`. Browsers omit `Origin` on same-origin `GET`, and
   _always_ send it cross-origin — so our own SPA passes and a plain cross-origin `evil.com` fetch
   is rejected by (a). Clause (b) is the DNS-rebinding defence (see below). This guard is required
   precisely because `cors({origin:true})` would otherwise hand the token to any site.
   Non-browser callers (curl, a local script) that present a loopback `Host` are allowed — they can
   read `server.json` off disk anyway, so this grants nothing new.
2. **`GET /terminal/:agentId`** authenticates the token via the
   **`Sec-WebSocket-Protocol` header**: the client connects with
   `new WebSocket(url, ['pixel-agents.terminal.v1', <token>])`, and the server compares the
   second value with `crypto.timingSafeEqual`, then echoes the first back via `handleProtocols`.

   _Why the subprotocol and not `?token=`:_ standalone runs Fastify with `logger: true`
   (`logger: !options.embedded`), which logs `req.url` for every request. A query-param token
   would be written to stdout/log files on every terminal connection. The subprotocol header is
   not logged, and it's the standard way to authenticate a browser WebSocket.

The terminal WS applies the same `isTrustedTerminalRequest` guard **before** it attaches to any
PTY or replays scrollback. The DNS-rebinding defence is the loopback-`Host` clause, **not** the
`Origin`-vs-`Host` comparison: a rebound page sends `Host: evil.com` _and_ `Origin: http://evil.com`
(the `Host` header is the URL's hostname, which the browser derives from the rebound domain), so the
two match and an `Origin`-vs-`Host` check alone would pass. What actually stops it is that a
loopback-bound server refuses any non-loopback `Host` — a rebound request's `Host` is always the
attacker's domain, never a loopback literal. When the operator has deliberately bound off-loopback
(a warned, opt-in exposure), the loopback-`Host` clause is skipped and the auth token is the guard.

### Other properties

- Token is a per-server-process `crypto.randomUUID()`, already written to `server.json` with
  mode `0o600` in a `0o700` directory.
- Comparisons use `crypto.timingSafeEqual` with a length pre-check, matching `bearerAuth`.
- The PTY inherits the server's uid/gid — no privilege boundary is claimed or implied. This
  feature does not make a local shell _more_ reachable to a local user; it makes it reachable
  to a _browser page_, which is exactly what the token prevents.
- `/terminal/:agentId` only attaches to PTYs that this server spawned, keyed by agent id. It
  cannot spawn a process on its own and cannot attach to externally-detected (non-PTY) agents.

## Transport: why raw I/O is outside AsyncAPI

`core/asyncapi.yaml` models a **control plane**: discrete, discriminated, schema-validated
messages, with `additionalProperties: false` and a CI drift check against generated bindings.
Terminal I/O is a **data plane**: a high-frequency, unstructured byte stream (a `ls` of a big
directory is thousands of chunks/second).

Putting it in the AsyncAPI unions would mean every keystroke and every output chunk passes
through the `ServerMessage` discriminated union and the store's broadcast fan-out — which
broadcasts to _all_ connected clients, so agent A's output would be delivered to every browser
tab. It would also grow the generated `messages.ts` union with a variant no other client can do
anything meaningful with.

**Decision:** a dedicated WS endpoint per agent (`/terminal/:agentId`) carries the stream and is
documented here rather than in the contract. Only the control-plane facts go through AsyncAPI,
additively:

| Message                 | Direction       | Purpose                                         |
| ----------------------- | --------------- | ----------------------------------------------- |
| `terminalAvailability`  | server → client | `{ available, reason? }` — gates the whole UI   |
| `terminalSessionOpened` | server → client | `{ agentId }` — a PTY exists, open a drawer tab |
| `terminalSessionClosed` | server → client | `{ agentId, exitCode? }` — process exited       |

All three are new `ServerMessage` variants; **no existing message or client message changed**, so
the diff stays additive for the six sibling branches. Notably `launchAgent`, `focusAgent`, and
`closeAgent` already exist and needed no protocol change — standalone just stopped ignoring them.

### Frame format (the data plane)

JSON text frames both directions, `additionalProperties`-free by convention:

```
server → client   {"type":"output","data":"..."}      raw PTY output
                  {"type":"exit","exitCode":0}
client → server   {"type":"input","data":"a"}
                  {"type":"resize","cols":80,"rows":24}
```

JSON rather than binary frames because `node-pty` already decodes to UTF-8 strings and xterm.js
already accepts strings — binary framing would add two conversions and re-introduce the
multi-byte-boundary bug node-pty already solves. The overhead is JSON string escaping on a
loopback socket, which is not a bottleneck. Revisit if it ever is.

### Scrollback / reconnect

Each `PtySession` mirrors its PTY output into a headless xterm (`@xterm/headless`, scrollback
capped at `TERMINAL_MIRROR_SCROLLBACK_LINES`). A browser that connects late, reloads, or
reconnects after the WS drops receives a `{type:"replay"}` frame carrying a
`@xterm/addon-serialize` snapshot of the mirrored screen plus the PTY geometry; the client
resets, resizes to that geometry, writes the snapshot, and then re-fits to its container. This
replaces an earlier raw byte ring: a ring starts mid-stream and a full-screen TUI's cursor
movements assume screen state a fresh client doesn't have, so replaying it produced garbled
overlapping fragments — and since the PTY size usually hasn't changed across a reload, no
SIGWINCH ever arrived to trigger a repaint. The snapshot is valid on a fresh terminal at any
attach point by construction. Output racing the snapshot is queued server-side and flushed after
the replay frame, so no byte is dropped or doubled across the handoff.

Closing the WS does **not** kill the PTY — only `closeAgent` (or the process exiting) does. So a
reload reattaches to a still-running Claude session.

## In scope

- `PtySessionManager`: spawn/write/resize/dispose per agent id, headless-xterm screen mirror
  with serialized replay snapshots, exit propagation, availability probe, `disposeAll()` on
  shutdown.
- `launchStandaloneAgent()`: PTY-backed mirror of the VS Code launch path, reusing
  `buildLaunchCommand`, pre-registering the expected JSONL, polling for it, and wiring the
  existing file-watcher + session-router machinery.
- `standalone` `launchAgent` / `closeAgent` handling (close now kills the PTY).
- `GET /terminal/:agentId` WS + `GET /api/terminal/session`, both authenticated.
- Three additive AsyncAPI `ServerMessage` variants.
- xterm.js drawer in the SPA: one tab per PTY-backed agent, character-click focuses its tab,
  standalone-only, pixel-art chrome + mono terminal content, xterm assets bundled (no CDN).
- Distribution: esbuild externals, `package.json` `optionalDependencies` + `files`.
- Server unit tests: session manager lifecycle, WS auth, message framing.

## Deferred (with rationale)

- **Terminal persistence across server restarts.** PTYs die with the server. Restoring them would
  need a detachable session supervisor (tmux/abduco-style) or a daemon that outlives the CLI —
  a much larger design. Today a restart leaves the Claude _session_ intact (the JSONL is on
  disk), so `--resume` recovers the conversation, just not the live process.
- **Multiple terminals per agent.** The manager is keyed `agentId → session` (1:1). Going 1:N
  means a session id in the key, the drawer, and the WS path. No demand yet.
- **Windows beyond what node-pty handles.** Both candidates use ConPTY on Windows 10 1809+
  (`@lydell/node-pty` ships `win32-x64` + `win32-arm64` prebuilds, and drops the old winpty
  fallback). Untested on Windows in this branch — see risks.
- **Unifying the VS Code and standalone launch paths** behind one core seam (see "Why a separate
  launch path").
- **Heuristic (hooks-off) `/clear` detection for PTY agents.** `fileWatcher`'s per-agent `/clear`
  heuristic is gated on `agent.terminalRef` (a `vscode.Terminal`), so it never fires for
  standalone PTY agents. With hooks on (the default) `SessionEnd`/`SessionStart` handle `/clear`
  correctly, so this only affects hooks-off standalone.
- **Making `/ws` authenticate in standalone** (pre-existing gap, not introduced here).
- **Resizing the office canvas when the drawer opens.** The drawer is an absolute
  overlay along the bottom, so it covers the lower part of the office rather than
  shrinking the canvas. The BottomToolbar lifts clear of it (via
  `--terminal-drawer-h`), but the canvas itself doesn't reflow. Making the root a
  flex column would fix it properly and touches OfficeCanvas sizing — deliberately
  out of scope here.

## Suggested e2e coverage (not implemented on this branch)

Per instructions, no Playwright tests were added. Worth adding, in `e2e/tests/standalone/`:

1. `terminal.spec.ts` — `+ Agent` in standalone opens the drawer, a tab appears, mock-claude's
   output renders in xterm; typing sends input (assert via the mock's log, honoring the
   process-boundary rule in `e2e/README.md`).
2. Clicking a character focuses that agent's drawer tab (mirrors the VS Code focus test).
3. Closing an agent from the overlay X removes the tab and kills the process (assert the mock
   process exits).
4. Reload mid-session replays scrollback: prior output still visible, no blank terminal.
5. Degradation: force the PTY module to fail (e.g. `PIXEL_AGENTS_DISABLE_PTY=1`) and assert
   `+ Agent` is hidden and the reason is shown — this needs a test seam; today the probe has no
   override. Flagged as an open question.
6. Auth negative test: a WS to `/terminal/1` without the subprotocol token is rejected (4401),
   and `/api/terminal/session` with a foreign `Origin` gets 403.

Note (5) and (6) are the ones I'd prioritize — they're the security- and support-relevant paths.

## Risks

- **Beta dependency.** `@lydell/node-pty` is `1.2.0-beta.12`. Mitigated by optionality, the
  fallback candidate list, and graceful degradation, but it is a real supply-chain call that
  deserves a maintainer's sign-off.
- **Windows untested.** ConPTY is claimed by prebuilds but not exercised here. The e2e terminal
  spec (`e2e/tests/standalone/terminal.spec.ts`) covers launch → drawer → I/O → reload → close on
  macOS/Linux, but skips the PTY-launch path on Windows: it spawns `claude` directly (no shell
  hop), and running a `.cmd` shim that way is exactly the untested part.
- **`npx` install size.** Adds one prebuilt `.node` (~100–200 KB) for the host platform only.
- **Non-loopback `--host`.** A user who sets `--host 0.0.0.0` exposes a token-guarded shell.
  Warned at startup; not blocked (blocking would be a behavior change to an existing flag).
  `--no-terminal` is the sanctioned answer for network-exposed watch-only dashboards.
- **Probe cost.** The availability probe spawns and kills a real PTY once per process. It runs
  lazily on first use, not at boot, so a user who never opens a terminal never pays it.

## Open questions for Pablo

1. **`@lydell/node-pty` (beta fork, all 6 platforms prebuilt, no install scripts) vs `node-pty`
   (Microsoft, no Linux prebuilds, broken under npm ≥11.16's script gating)?** I chose the fork
   with the official package as a fallback candidate. This is the single biggest call in the
   branch and is easy to reverse.
2. **Should `/ws` also require its token in standalone?** It's currently unauthenticated on the
   argument that loopback is enough — an argument WebSocket's CORS exemption doesn't support.
   Any page can currently connect to `/ws` and drive `saveLayout`, `setHooksEnabled`, etc. I left
   it alone (out of scope, shared file), but I think it should change.
3. **Should `ITerminalAdapter` grow into a real terminal-lifecycle seam** (`launch/write/resize/
dispose`) that both surfaces implement, or stay the VS Code adoption helper it is today? I
   assumed the latter and put the lifecycle in `PtySessionManager`.
4. **Should `+ Agent` in standalone offer a folder picker?** VS Code uses `workspaceFolders`;
   standalone has none, so it always launches in the server's `process.cwd()`. A `--cwd` flag or
   a UI picker may be wanted.
5. **Do you want a test seam to force PTY-unavailable** (e.g. `PIXEL_AGENTS_DISABLE_PTY=1`)? It'd
   make the degradation path e2e-testable; I didn't add one unprompted.
