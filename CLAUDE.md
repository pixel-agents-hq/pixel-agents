# Pixel Agents — Compressed Reference

Pixel art office where AI agents (Claude Code terminals today, any tool tomorrow) become animated characters. Ships as a **VS Code extension** and an **`npx pixel-agents` standalone CLI** from the same source tree.

`CONTEXT.md` is the canonical glossary — read it for what terms like Agent, Sub-agent, Teammate, Lead, Adopt, or Headless agent mean here, and use its vocabulary in code, comments, and docs.

## Architecture

Strict layering: `core/` depends on nothing; `server/` depends only on `core/`; `webview-ui/` depends only on `core/`; `adapters/vscode/` depends on `core/` and `server/`. The standalone CLI never imports `adapters/vscode/` and vice versa.

```
core/                                Protocol + interface definitions (zero runtime side effects)
  asyncapi.yaml                      AsyncAPI 3.0 contract — single source of truth
  src/
    messages.ts                      AUTO-GENERATED discriminated unions (do not edit)
    schemas.ts                       AgentMeta, SpriteData, FurnitureCatalogEntry
    provider.ts                      HookProvider, AgentEvent (the integration boundary)
    teamProvider.ts                  Optional TeamProvider (semantic queries for Lead + Teammates)
    transport.ts                     MessageTransport interface, TransportState
    adapter.ts                       StateAdapter, AssetCache, PersistedAgent, AgentSeat
    terminalAdapter.ts               TerminalAdapter (editor-driven terminal management)
    normalizeProjectPath.ts
    constants.ts
    isRecord.ts, localId.ts          The one "is this a JSON object" guard; newLocalId (character, item and save ids)
    assets/characterSheet.ts         The ONE reading of the sheet layout: sheetToDirectionSprites, currentSheetPixels (widens a 112-wide sheet); used by decodeCharacterPng and the webview

server/                              Lifecycle runtime + Fastify HTTP/WS server
  src/
    providers/hook/claude/           Reference HookProvider — only place that knows Claude specifics
      claude.ts                      normalizeHookEvent for 11 Claude events, formatToolStatus, file fallback
      claudeTeamProvider.ts          TeamProvider: reads ~/.claude/teams/<name>/config.json
      claudeHookInstaller.ts         Consent-gated install/uninstall of our hook entries (abort on non-object hooks or non-array hooks.<Event>; `areHooksInstalled` = ANY of our commands on ANY event)
      claudeHookEntries.ts           Our hook entries as data, pure: makeHookEntry (the WRITER), hook identity (`/.pixel-agents/hooks/claude-hook.js` suffix anchored at both ends of the command's first token, case-insensitive), hooksHoldOnlyOurs (compared against makeHookEntry; only `command`/`timeout` may differ, they vary across installs)
      claudeSettingsFile.ts          ~/.claude/settings.json itself, for every writer (hooks, status line): mutateClaudeSettings, the one guarded read-modify-write (abort on unparseable file; one-time .pixel-agents.backup, exclusive-create, no backup ⇒ no write — but skipped when the replaced content is entirely our own output, since backing up our own file masquerades as the user's original: `settingsHoldOnlyOurOutput`, each key checked against its WRITER (`hooks` → hooksHoldOnlyOurs, `statusLine` → isBareOurStatusLine) so a field added to what we write can't silently revive the bug; every write failure THROWS; mode preserved, 0600 on create; re-read verify immediately before rename + retry)
      bundledScripts.ts              bundledScriptPath / copyBundledScript: the one spelling of ~/.pixel-agents/hooks/<name> and the copy from the package
      consentCopy.ts                 Claude's first-run consent disclosure text (scope/data/undo), served through consentDisclosure()
      commandIdentity.ts             firstCommandToken / commandRunsScript: the ONE "does this settings.json command run our script?" parser (hooks + status line)
      statusLineBridge.ts            The usage bridge's statusLine command: make / recognize / read back the wrapped user command (base64url after --wrap, so no shell metachar leaks); makeBareStatusLine (the WRITER) + isBareOurStatusLine (compared against it)
      statusLineInstaller.ts         Wrap/unwrap ~/.claude/settings.json statusLine through claudeSettingsFile's mutateClaudeSettings (refuses non-command shapes and hand-edited wraps; a replaced status line is the user's)
      claudeUsageBridge.ts           Claude's UsageBridge: disclosure, rate_limits → ReportedUsage, install/uninstall
      constants.ts                   Claude hook event names, script path
      hooks/claude-hook.ts           Hook script (CJS+shebang, bundled to dist/hooks/claude-hook.js)
      hooks/claude-statusline.ts     Status line bridge (dist/hooks/claude-statusline.js): runs the wrapped user status line untouched, POSTs ONLY rate_limits + session_id + context_window's used_percentage/context_window_size to /api/usage/claude
      hooks/serverRegistry.ts        Both scripts' route to the servers: live registry entries (else legacy server.json) + best-effort POST
    providers/hook/consentGate.ts    Provider-agnostic consent POLICY: when to ask (hooksConsentRequest per provider) and what an answer means (consentActionFor(choice, {installed, consent}) — see docs/adr/0001)
    providers/hook/consentExecutor.ts Provider-agnostic consent EXECUTION: applyConsentChoice(providerId, choice, ConsentEffects) runs the six actions in one order for both surfaces, and SERIALIZES answers per process across ALL providers
    providers/index.ts               Provider registry (claudeProvider + the hookProviders list the consent gate loops over)
    agentPersistence.ts              What of an agent survives a reload, and what a restored agent starts from (both surfaces)
    backgroundSpawns.ts              A lead's live background spawns: tool id → task id, their rules (launchSpawn, completionNotice, classifySpawn) and persisted form
    agentRuntime.ts                  Lifecycle core: timers, scanners, HookEventHandler, SessionRouter, DismissalTracker
    agentStateStore.ts               EventEmitter-backed single source of truth (typed mutations + events)
    sessionRouter.ts                 session_id → agent_id mapping, event buffering, pending external sessions
    dismissalTracker.ts              Unified dismissal state (replaces four legacy globals)
    hookEventHandler.ts              Dispatches normalized AgentEvent into runtime
    httpServer.ts                    Fastify: POST /api/hooks/:providerId, GET /api/health, GET /ws, SPA (standalone)
    clientMessageHandler.ts          Single dispatch point for ClientMessage from webview
    server.ts                        Top-level composition
    cli.ts                           npx pixel-agents entry (npm bin)
    fileStateAdapter.ts              Namespaced ~/.pixel-agents/ persistence
    configPersistence.ts             { vscode, standalone, externalAssetDirectories, hooksConsent: {providerId: granted|declined}, hooksEnabled: {providerId: boolean} }
    layoutPersistence.ts             ~/.pixel-agents/layout.json with atomic tmp+rename
    directories.ts                   Directories: host+user union, save/remove (incl. default characters), directoryAt(launchPath)
    terminal/                        Standalone terminals (TerminalSessions): in process (ptySessionManager.ts, the default) or, dev only, a PTY host that outlives the server (ptyHost.ts, remotePtySessions.ts, ptyHostProtocol.ts)
    usageLimits.ts                   Usage bars: last report per provider (~/.pixel-agents/usage-limits.json), merge + throttle, usageLimits/usageBridgeStatus messages (usageSnapshotMessages = both surfaces' handshake), applyUsageBridgeChoice; PRIVILEGED_BROADCAST_TYPES
    cardOrder.ts                     The agent cards' order, one per surface for every client (desktop and phone): parse, load, save (pruned to live agents)
    conversations.ts                 The sidebar's recent conversations: each Directory's newest transcripts (titles from the provider, cached per path while size + mtime match), the look + seat each session's agent had (~/.pixel-agents/conversations.json, recorded on saveAgentSeats), liveSessions + resumeRequest (a resume's checks)
    agentMessages.ts                 agentCreatedMessage: the one agentCreated builder for both surfaces
    recentCharacters.ts              The roster's recency: a launch wearing a roster pick moves it first (config.json `recentCharacters`), broadcast to every office
    characterRemap.ts                A save that inserts or deletes characters: renumbers agents, seats, Directory defaults, recency, conversation looks
    characterProfilesPersistence.ts  The ONE owner of ~/.pixel-agents/characters.json (and wardrobe-items.json beside it) for both surfaces: save, watch, saveCharacterProfiles handling (refusedSaveAnswer)
    characterProfilesStore.ts        The cached cast (cachedJsonFile per file): getCharacterProfiles / getWardrobeItems, read by getPaletteCount; depends on nothing that depends back on it
    jsonFileWatcher.ts               Generic hybrid fs.watch + polling watcher + writeJsonAtomic (layout.json, characters.json)
    fileWatcher.ts                   Hybrid fs.watch + 500ms polling, JSONL line buffering, /clear detection
    transcriptParser.ts              JSONL parsing for heuristic / file-fallback mode
    timerManager.ts                  Waiting / permission timers
    assetLoader.ts                   PNG → SpriteData via pngjs
    teamUtils.ts                     isInlineTeammateOf, getInlineTeammates, hasInlineTeammates
    types.ts                         ServerAgentState
    constants.ts                     All timing/scanning constants
  __tests__/                         28 Vitest files
  manual-hook-events.http            Manual hook testing helper (REST-Client format)

adapters/vscode/                     VS Code surface — composes core + server
  extension.ts                       activate() / deactivate()
  PixelAgentsViewProvider.ts         WebviewViewProvider, thin bridge to AgentRuntime
  agentManager.ts                    Terminal lifecycle (claude --session-id <uuid>), restore, persist
  vscodeTerminalAdapter.ts           TerminalAdapter implementation
  uninstall.ts                       vscode:uninstall hook — removes hook entries + factory-resets hooks config after extension removal
  migrateVsCodeState.ts              One-time legacy state migration (verify-before-clear)
  constants.ts                       VS Code IDs, command names, key names

webview-ui/                          React 19 + Canvas UI (depends only on core/)
  src/
    transport/
      index.ts                       createTransport() — single runtime branching point
      postMessageTransport.ts        VS Code mode (acquireVsCodeApi)
      webSocketTransport.ts          Standalone mode (exponential backoff, send queue)
      onReconnect.ts                 Every `connected` after the first (the reconnect resync's trigger)
      types.ts                       Re-exports MessageTransport from core
    runtime.ts                       isBrowserRuntime detection
    browserMock.ts                   Standalone-browser asset fetch + message injection
    testHooks.ts                     window globals exposed for e2e (officeState, helpers)
    main.tsx                         React entry (StrictMode + createRoot)
    App.tsx                          Composition root (hooks + components + EditActionBar)
    constants.ts                     Webview magic numbers/strings
    notificationSound.ts             Web Audio API chime
    changelogData.ts                 Changelog modal content
    components/                      React UI (toolbars, modals, settings)
      BottomToolbar.tsx, ZoomControls.tsx, SettingsModal.tsx, InfoModal.tsx,
      Tooltip.tsx, DebugView.tsx, ui/Button.tsx, ...
      LoadingScene.tsx               The loading screen: a lamp-lit corner of the office in a black room — Suit and Dress typing at a table of PCs, Aura circling it, the cat on it, a wood floor fading out (vignette + radial fade); one canvas, bundled art only (no server needed). Dev preview: /loading.html (`npm run dev`)
      loadingSceneLayout.ts          The scene (pure): tile layout, z order by the office's rules, the walker's loop, frames by time
      loadingSceneArt.ts             The furniture, floor and cat PNGs inlined (?inline) and decoded to sprites
      ui/pixelIcons.ts               The 8×8 pixel icon set (grids as strings; the canvas draws them too: the selected furniture's rotate/delete buttons)
      ui/pixelGrid.ts                gridRuns / litBox: a '#' grid as horizontal runs and its lit box, for the SVGs and the canvas alike (DOM-free)
      ui/PixelSvg.tsx                The one pixel-art SVG (runs as rects, crispEdges) behind PixelIcon and PixelText
      ui/PixelIcon.tsx               PixelIcon renderer (whole device pixels per icon pixel, pixelSnap.ts)
      AgentCard.tsx                  One agent card (mug shot + status dot + ×, its context left along the foot — office/contextGauge.ts + office/ContextBar.tsx, shared with the label's gauge)
      AgentCardList.tsx              The card bar's cards for BOTH shells: same agents, same server-owned order, same reorder + highlight rules, focused card kept in view; AgentCardBar (desktop/VS Code column) and MobileAgentBar (phone row) only wrap it
      useCardReorder.ts              Drag-to-reorder: touch long-press (phone) or mouse drag (desktop), along the bar's axis; previews, then commits
      cardBar.ts                     Pure card-bar rules: cardOrderOf (main agents only — Teammates get none — in the saved order, via mergeOrder), cardVariant, closeMode (the ×), reorderByPointer (Node-tested)
      TerminalDrawer.tsx             Desktop standalone: right-docked terminal panel (slides with useSlidePanel); App draws the card bar beside it and its cards are the tabs
      TerminalPaneStack.tsx          The agents' TerminalPanes, the shown one visible: desktop keeps every pane mounted, the phone only the shown one (memory; a pane that mounts gets its screen back from the server's replay)
      TerminalPane.tsx               One xterm bound to one agent's PTY
      MobileAgentBar.tsx             Mobile bottom bar: square + launch card with the roster's arrow beside it, the AgentCardList row
      CharacterPicker.tsx            Roster carousel (CharacterRow): pick = launch as that character, hold / hover pencil = edit, leading + New; PhoneCharacterPicker = the sliding phone strip
      MobileTerminalPage.tsx         Mobile terminal page (a TerminalPaneStack)
      MobileKeyBar.tsx               Accessory keys above the software keyboard (/, tab, shift+tab, the square arrow trackpad centred on the bar, esc, forward del, line break)
    usage/                           UsageBars (top-left, no panel: heart + weekly bar over an equal 5-hour bar, % inside each; hover/tap any of it = the heart beats and each bar's reset time shows right of it) + PixelHeart (multi-colour art through PixelSvg + pixelGrid `colorRuns`; the beat flashes a one-pixel-bigger frame) (numbers through PixelText) + usageBarView (pure: share left, colour band, reset-since-report = full, heartbeat period, freshness) + usageStore (each provider's usageBridgeStatus/usageLimits outside React; `seq` counts status arrivals) + useUsageBridge (status, limits, this caller's `pending` request — answered by the next ARRIVAL, since a failed install re-reports the same value — and `setEnabled`; read by the Intro, Settings and App)
    conversations/                   ConversationList (shared body) in ConversationSidebar (desktop, left, shown and hidden from the zoom stack, slides with useSlidePanel, Settings at its foot; open/shut in useConversationSidebar) and MobileConversations (phone, History panel); useConversations (requestConversations while open) + timeAgo
    music/                           The office radio (see "Office radio"): procedural 8-bit tunes, DOM-free composer, one Web Audio player
      composer.ts                    makeSong: one tune as steps for the four Game Boy channels (pure, seeded); the melody, harmony, bass and drum writers
      rng.ts, moods.ts               The seeded stream (Rng, newSeed); the moods and their theory tables (MOOD_KEYS, MOODS, scales, progressions, forms) + chooseMood (Auto)
      tuneNames.ts, songCode.ts      Tune names (word lists, drawn last from the tune's stream); song codes (songCode/parseSongCode, keyLabel, ROOT_MIN/ROOT_MAX)
      musicEngine.ts                 officeRadio: the player singleton (subscribe/getState, Web Audio scheduling, visualizer bands; volume, mood and hidden in localStorage); useOfficeRadio.ts reads it in React
      MusicPlayer.tsx                The player bar + VolumeControl.tsx + RadioSettingsPanel.tsx (mood, song code, hide); playerSheet.ts = the phone sheet gesture (pure reducer); radioLift.ts = the CSS variables the version label rides on
    mobile/                          The phone shell (standalone only, see "Mobile shell")
      MobileShell.tsx                Sliding office/terminal track + card bar + key bar
      MobileMenu.tsx                 Menu panel from the left: recent conversations + Settings at its foot (one menuPanel for both swipes); MobileMenuButton
      useMobileMenu.ts               The menu's open state + its swipe panel ref
      useMobileShell.ts              Page state and navigation rules (toggle, card tap, launch-then-slide, openAgent from the menu)
      edgeSwipe.ts                   Edge-swipe state machine (pure reducer, Node-runner tested)
      keyboardViewport.ts            Software-keyboard decision: open vs per-width baseline, clamp only when the visual viewport is shorter (pure)
      useEdgeSwipe.ts                DOM adapter for the reducer (capture listeners, detached-target rescue)
    touch/
      touchPrimitives.ts             findTouch (track one finger by id) + withinTapSlop (the one tap metric)
      trackpad.ts                    Key bar trackpad: arrows per step, locked to the first axis moved on (pure)
    terminal/                        Standalone terminal (xterm) support
      terminalClient.ts              /terminal/:agentId socket (reconnect, replay)
      terminalLinks.ts               Safe link opener + urlsOnLine/urlAtCell (one URL lookup for clicks and taps, across wraps)
      linkProvider.ts                The mouse side: an xterm link provider over urlsOnLine
      hardWrap.ts                    hardWrapIndent: a row Claude Code broke mid-token (filled to the last column, indented carry-on, a token too long to fit) — joined by links and every copy
      touchGesture.ts                Terminal touch state machine: scroll, flick, tap, long-press select (Paste in the input area), handles (pure reducer)
      touchInput.ts                  DOM adapter: listeners, flick rAF, long-press timer, detached-target rescue
      selectionMath.ts               Word expansion, range ordering, handle clamping (pure)
      selectionOverlay.ts            Copy pill (Copy | Copy as text), Paste pill + selection handles (DOM; styled in index.css)
      inputArea.ts                   The TUI's input area: cursor row out to the prompt box's rules (pure)
      clipboard.ts                   The one clipboard write/read: Clipboard API on secure origins; plain http falls back to a copy event (write) / a native prompt (paste)
      flowCopy.ts                    terminalCopyText: verbatim by default; opt-in re-flow of Claude Code's soft wraps (pure)
      clipboardKeys.ts               Clipboard chords (Ctrl+C/Ctrl+Shift+C copy, Alt+C copy as text, Ctrl+V paste) + OSC 52 decode (pure)
      terminalDom.ts                 xterm screen geometry + isTypingInTerminal
    hooks/
      useExtensionMessages.ts        Message handler — translates ServerMessage into OfficeState mutations
      useEditorActions.ts            Editor state + callbacks
      useFurnitureColorActions.ts    Furniture colour sliders + colour-only eyedropper
      useEditorKeyboard.ts           Keyboard shortcuts (R, T, Esc, Ctrl+Z/Y)
      introTourState.ts              Intro tour wire-state machine (pure reducer, Node-runner tested)
      useIntroTour.ts                Wires the reducer to React + transport (snapshot, verdict, choices)
      useTerminalDrawer.ts           Terminal-pane model for both shells: active/shown pane, socket status, card lookups, the launch latch (expectLaunch → lastLaunched)
      launchLatch.ts                 answersLaunch: a launch's latch expires after LAUNCH_ANSWER_TIMEOUT_MS (pure, Node-tested)
      useSlidePanel.ts               A side panel's open/close motion (bounce out, snap shut, reduced motion; SIDE_PANEL_* timings)
      slideTransitions.ts            Its two transitions (pure): the width only while opening/closing, the contents' delayed slide whenever motion is allowed (it outlasts the width)
      useLaunchActions.ts            Launch into a Directory / resume a conversation, both through the drawer's expectLaunch
      useLongPress.ts                Touch long-press (held still) that swallows the click it ends with
      useDismiss.ts                  Close a popover on a press outside it or on Escape
      useRosterLaunch.ts             The launch button's two menus (drawer | roster, never both) + the roster pick, shared by the phone bar and the desktop toolbar (state: pure `launchMenus.ts`); + always opens the plain drawer, dropping a pick; per-shell option: Escape closes the drawer (desktop only)
      useHoverPin.ts                 Desktop hover-opens / press-pins menu (the toolbar's drawer and roster)
      useIsMobile.ts                 Mobile breakpoint — always false in the VS Code webview
      useKeyboardViewport.ts         Samples the viewport: keyboard open (key bar) + iOS shell clamp height
    characters/                      Character profiles: the cast agents are drawn from (see "Characters")
      art/                           Wardrobe: one finished 128×96 PNG per part (<piece>/<id>.png, eyes/<shape>/), wardrobe.json (labels, colourways, palettes)
      slots.ts                       The slot table: LAYERS (one entry per piece), TABS, ACCESSORIES; everything else derived
      renderer.ts                    Profile → 128×96 sheet (pick files, edits, tint, stack) — DOM-free
      wardrobe.ts, sheet.ts          Art layout + manifest/PNG check (partInfo); sheet geometry (cellAt, FRAME_COUNT, isOpaque, decodeSheet over core's currentSheetPixels)
      cast.ts                        CastStore: the cast as one { profiles, items } value — saved, the view's draft (openDraft) and its base — projected onto CastState; explicit Save, server sync (saveIds) — DOM/transport-free
      items.ts                       Custom items + piece sheets: export a worn piece, import a PNG as edits, save as a new item, offeredParts
      history.ts                     Undo/redo with press/merge step grouping — DOM-free
      castStore.ts                   The app's CastStore over the transport (useCast); decodes custom items and rebuilds the renderer when they change
      castMessages.ts                handleCastMessage: characterProfilesLoaded (looks first, then the list) + characterSpritesLoaded, handed over by useExtensionMessages
      officeSprites.ts               Office sync: subscribes to the cast, sheets → office sprites (core's sheetToDirectionSprites; + external char_N.png)
      profiles.ts                    Profile edits: setPart, randomize, pixel edits, labels, config parsing
      ui/                            CharactersView (desktop modal / phone page), Stage, Wardrobe, ColorPanel, PixelEditor, Roster (ROSTER_ACTIONS), castActions (useCastActions), files; characters.css + characters.phone.css
    office/
      types.ts                       OfficeLayout, Character, etc. + re-exports constants
      toolUtils.ts                   STATUS_TO_TOOL mapping, extractToolName (DOM-free; defaultZoom lives in useEditorActions)
      projection.ts                  World→screen math shared by renderer + DOM overlays (mapOffset, overlayProjection)
      colorize.ts                    Colorize (grayscale→HSL) + Adjust (HSL shift)
      floorTiles.ts                  Floor sprite storage + colorized cache
      wallTiles.ts                   Wall auto-tile: 16 bitmask sprites
      sprites/
        spriteData.ts                Pixel data (characters, furniture, tiles, bubbles); every setCharacterTemplates is announced (subscribeCharacterTemplates), so a mounted CharacterMugShot redraws when the cast arrives or is edited
        spriteCache.ts               SpriteData → offscreen canvas, per-zoom WeakMap
      editor/
        editorActions.ts             Pure layout ops
        editorState.ts               Imperative state (tools, ghost, selection, undo/redo + undo session, drag, placing)
        editorRenderState.ts         buildEditorRenderState: ghosts + selection for the renderer (pure)
        EditorToolbar.tsx
      layout/
        furnitureCatalog.ts          Dynamic catalog from loaded assets
        layoutSerializer.ts          OfficeLayout ↔ runtime (tileMap, furniture, seats)
        tileMap.ts                   Walkability, BFS pathfinding
        workstations.ts              Seat ↔ PC pairing (one PC per seat, screen faces the seat)
      engine/
        characters.ts                Character FSM (idle/walk/type) + wander AI
        blink.ts                     Each character's blink clock (startBlink/tickBlink, skewed random gaps, some doubles, fewer while working)
        officeState.ts               Game world (layout, characters, seats, selection, subagents, consent greeter)
        gameLoop.ts                  rAF loop with delta-time cap (0.1 s)
        renderer.ts                  Canvas: tiles, z-sorted entities, overlays, edit UI
        selectionButtons.ts          The selected item's rotate/delete buttons: geometry, placement, hit test (DOM-free; renderer draws them)
        matrixEffect.ts              Spawn/despawn digital rain (drawing only)
        matrixEffectState.ts         Effect state: startMatrixEffect/advanceMatrixEffect (DOM-free)
      components/
        OfficeCanvas.tsx             Canvas, resize, DPR, mouse hit-testing, drag-to-move
        useCanvasTouchGestures.ts    Touch pan / pinch zoom / tap on the canvas
        ToolOverlay.tsx              Activity label + speech bubbles (DOM, above the labels) per character

e2e/                                 Playwright suite (real VS Code + mock-claude scenarios)
  playwright.config.ts
  global-setup.ts
  fixtures/
    pixel-agents.ts                  VS Code fixture: launch Electron, wait for panel
    standalone.ts                    Standalone CLI fixture: spawn server + browser page
    mock-claude, mock-claude.cmd     Bash + cmd wrapper invoked instead of real claude
    mock-claude-runner.cjs           Scenario runner: appendJsonl, emitHook, holdOpen
  helpers/
    launch.ts                        Electron app + isolated HOME/workspace
    mock-claude.ts                   claudeScenario() builder
    office.ts                        Overlay locators + assertions
    webview.ts                       Settings/modal helpers
    hooks.ts                         Hook server lifecycle helpers
    standalone.ts                    Standalone server + WebSocket browser helpers
    internal-agent.ts                spawnInternalAgentAndWait
    lifecycle.ts                     Reusable scenario fragments
    team.ts                          Team config seeding + teammate helpers
    allure-labels.ts                 @area:<tag> → Allure epic
  tests/
    claude/hooks-on/                 basic.spec.ts, lifecycle.spec.ts, teams.spec.ts
    claude/hooks-off/                lifecycle.spec.ts, matrix.spec.ts
    standalone/                      hooks.spec.ts
  README.md                          Auto-generated test inventory (regen via npm run e2e:inventory)

scripts/
  generate-messages.ts               AsyncAPI → core/src/messages.ts via Modelina (with CI drift check)
  run-e2e.mjs                        Playwright wrapper (run-id namespacing, video attach flags)
  generate-e2e-inventory.mjs         Splices test list into e2e/README.md (CI drift check)
  build-allure-report.mjs            Combine e2e+server+webview Allure results
  assemble-vercel-output.mjs         Stage /reports/allure/ for Vercel deploy
  asset-manager.html                 Unified furniture editor (positions + metadata)
  jsonl-viewer.html                  Standalone JSONL transcript inspector
  wall-tile-editor.html              Wall sprite editor

core/                                npm workspace (no separate package; root manages)
server/                              npm workspace
webview-ui/                          npm workspace
```

## Distribution

Two artifacts from one source tree:

- **VS Code extension** (`.vsix`) — `pablodelucca.pixel-agents` on VS Code Marketplace and Open VSX. Bundles VS Code adapter + webview SPA + assets + hook scripts.
- **npm package** (`pixel-agents`) — `npx pixel-agents [--port 3100]` runs the Fastify server and serves the SPA on the same port. Bundles CLI + webview SPA + assets + hook scripts + `core/asyncapi.yaml` (so third-party clients can regenerate from it).

`package.json:files` allowlist controls the npm tarball: `dist/cli.js{,.map}`, `dist/webview/`, `dist/assets/`, `dist/hooks/`, `core/asyncapi.yaml`, `icon.png`. `dist/extension.js` is intentionally excluded since the VS Code entry ships through the `.vsix`.

## Communication Flow

Hub-and-spoke. The server is the single aggregation point for all agent activity, regardless of source.

```
Hook scripts ─POST /api/hooks/:providerId─┐
                                          ├─→ HookProvider.normalizeHookEvent()
JSONL transcripts ─FileWatcher─→ TranscriptParser ┤
                                                   ↓
                                              AgentEvent (canonical)
                                                   ↓
                                              AgentRuntime (dispatch on .kind)
                                                   ↓
                                           AgentStateStore (mutate)
                                                   ↓
                                              StoreEvents → broadcast
                                                   ↓
                          PostMessageTransport ──┤├── WebSocketTransport
                                 (VS Code)      (standalone browser)
```

The VS Code adapter wires `PostMessageTransport` against `acquireVsCodeApi()`. The standalone CLI exposes the same protocol over WebSocket at `/ws` with the webview SPA served from the same Fastify instance. **The protocol shape is identical; only the wire differs.**

Adding a new CLI integration is one subdirectory under `server/src/providers/hook/<id>/`: provider, optional `TeamProvider`, installer, hook scripts. Zero changes to the runtime, the UI, or any existing provider.

## AsyncAPI Protocol Contract

`core/asyncapi.yaml` is the contract. Pinned to **3.0.0** because `@asyncapi/modelina@5.10.1` declares `supportedVersions: ['3.0.0']` only; bumping to 3.1.0 produces `export type Root = any`. Revisit when Modelina ships 3.1.0 support.

- **46 ServerMessage variants** (server → client): agent lifecycle, agent activity, sub-agent activity, team + context usage, character profiles (`characterProfilesLoaded`, `recentCharactersLoaded` — the roster's most-recently-launched order, server-kept and machine-wide so every office lists the roster alike), assets, access (`officeAccess` — sent first on `webviewReady`; `readOnly` hides every control a read-only office would only have refused), settings (`bypassPermissionsUpdated` — the skip-permissions posture, broadcast to every office on change because every launch reads it) + directories (`directoriesLoaded`, `directorySaved` — a save's ack to its sender, carrying the entry as stored, whose name keys the Area mapping; `directoryRejected`, `directorySuggestions`), terminal, card order (`cardOrderLoaded` — sent on `webviewReady` before `existingAgents`, broadcast after every save), usage bars (`usageBridgeStatus`, `usageLimits` — privileged sockets only), diagnostics.
- **33 ClientMessage variants** (client → server): lifecycle (`webviewReady`, `launchAgent`, `focusAgent`, `closeAgent`), layout (`saveAgentSeats`, `saveLayout`, `exportLayout`, `importLayout`), characters (`saveCharacterProfiles` — profiles plus, optionally, the custom wardrobe items, `exportFile` — VS Code save dialog for generated files), card order (`saveCardOrder`), settings (`setSoundEnabled`, `setHooksEnabled`, `setUsageBridgeEnabled`, `setWatchAllSessions`, `setAlwaysShowLabels`, `setHooksInfoShown`, `setLastSeenVersion`, `setBypassPermissions`, `setShowHostDirectories` — whether the host's own Directories are listed, off by default; only the list is gated, launches still name agents after them), directories (`saveDirectory`, `removeDirectory`, `requestDirectorySuggestions`), terminal, discovery + assets, diagnostics.

Both unions use `oneOf` with `discriminator: type`. Every concrete message sets `additionalProperties: false`.

`core/src/messages.ts` is generated by `scripts/generate-messages.ts` invoking `@asyncapi/modelina` with custom constraints (`propertyKey` preserves `type`/`status` field names; `constant` inlines `const` literals). The file has an auto-generation banner. **CI runs `asyncapi:generate` then `git diff --exit-code core/src/messages.ts` — any non-empty diff fails the build.**

## Transport Abstraction

```typescript
export interface MessageTransport {
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): () => void;
  readonly ready: Promise<void>;
  readonly state: TransportState;
  onStateChange(handler: (state: TransportState) => void): () => void;
  dispose(): void;
}
export type TransportState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
```

`PostMessageTransport` reports `connected` for its entire lifetime. `WebSocketTransport` reconnects with exponential backoff (250 ms, 500 ms, 1 s, 2 s, 4 s, capped) and queues sends while disconnected. **Broadcasts sent while a client is disconnected are lost, never replayed**, so every reconnect (`transport/onReconnect.ts`) re-sends `webviewReady` and the webview takes that snapshot as the whole truth (`resyncFromSnapshot` in `useExtensionMessages`): agents it doesn't list are closed, and tools, statuses and sub-agents are dropped for the replay to rebuild — a live sub-agent returns on its old spot with no spawn effect (`OfficeState.detachSubagentsForResync`). Without this, a `subagentClear` missed while a phone slept left its sub-agent in the office until a reload.

`createTransport()` in `webview-ui/src/transport/index.ts` is the **only branching point** in the UI codebase. Everything downstream uses the `MessageTransport` interface and never knows which transport is active.

## Provider Abstraction

`HookProvider` (`core/src/provider.ts`) is the integration boundary. Today only Claude Code is implemented; the Claude provider supports every transcript/hook format up to **Claude Code v2.1.309** (current as of 2026-10-25 — Task-era `agent_progress` records, explicit and implicit teams, background-by-default Agent spawns, sidecar-backed background agents, interim background-agent notices). Newer CLI releases may add formats that need provider updates. The interface:

- **Required**: `normalizeHookEvent(raw)` → `{ sessionId, event: AgentEvent } | null`; `installHooks` / `uninstallHooks` / `areHooksInstalled`; `formatToolStatus`; `permissionExemptTools`, `subagentToolNames`, `readingTools` sets.
- **Optional file fallback**: `getSessionDirs(workspace)`, `getAllSessionRoots()`, `sessionFilePattern`, `parseTranscriptLine(line)`, `buildLaunchCommand(sessionId, cwd, opts)`. Used when hooks aren't installed.
- **Optional team extension**: `team?: TeamProvider` for Lead + Teammates support.

`AgentEvent.kind` values: `toolStart`, `toolEnd`, `turnEnd`, `subagentStart`, `subagentEnd`, `subagentTurnEnd`, `progress`, `permissionRequest`, `sessionStart`, `sessionEnd`. The runtime dispatches on `kind`, never on CLI-specific tool names.

### TeamProvider (Lead + Teammates)

Optional extension for CLIs that support team workflows (Claude Agent Teams today). Semantic queries (`discoverTeammates`, `getTeamMembers`, `getTeamMetadataForSession`, `extractTeammateNameFromEvent`, `isTeammateSpawnCall`) — providers choose their own storage strategy.

Four teammate modes:

| Mode                            | Trigger                                          | Detection                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basic subagent (teams OFF)      | `Task(...)` or `Agent(run_in_background: false)` | `subagentStart` with team gate not matched, or JSONL `agent_progress`                                                                                                                                                                                                                                                                                                                   |
| Inline teammate (teams ON)      | `Agent(run_in_background: true)` in-process      | `onTeammateDetected` → `discoverTeammates(projectDir, leadSessionId)`                                                                                                                                                                                                                                                                                                                   |
| Session teammate (teams + tmux) | `Agent(run_in_background: true)` in tmux pane    | Own session, own hooks, routes through normal flow                                                                                                                                                                                                                                                                                                                                      |
| Implicit-team agent (Claude 5)  | `Agent(...)` — background by default, NO flag    | Lead-side: spawn tool_result `agent_id: <name>@<team>` → `extractTeammateSpawnFromToolResult` sets lead `teamName`; teammate = own top-level UUID session tagged `teamName`/`agentName` on every record, discovered by `discoverTeammates(projectDir, leadSessionId, teamName)` and fast-attached in `onExternalSessionDetected` (bypasses the Watch All gate when the lead is tracked) |

Newer harnesses (Claude 5) never tag the LEAD's records with team metadata and never write `agent_progress`/`queue-operation` records for these spawns — the spawn tool_result and the teammate's own session (own JSONL, own hooks) are the only signals. The implicit team writes `~/.claude/teams/session-<8hex>/config.json` (its `leadSessionId` matches no transcript on disk — don't link by it). Own-session teammates are registered with the SessionRouter (`setTeammateRegisterCallback`) so their hooks route directly to them.

**Team generations on resume (last-wins latch)**: every CLI run of a session mints a FRESH implicit team, so a resumed lead's transcript carries spawn tool_results from several `session-<8hex>` generations. A tag-less lead re-latches to the newest spawn's team (`setTeamSwitchCallback` removes the defunct team's teammates); tag-derived identity (`teamNameFromTags`, set by the record-tags branch) is authoritative and never overwritten by spawn results. `linkTeammates` never badges a named teammate as LEAD — if only teammates are tracked, linking waits until the real lead is detected (prevents a phantom LEAD character when a teammate session is adopted before/without its lead). Restore drops `isTeamLead` from persisted agents that carry an `agentName`.

**Background spawns without a CLI team (sidecar-backed)**: `Agent(...)` spawns that never register a team take the async path — result "Async agent launched successfully. agentId: \<hex>" (no team anywhere), transcript + sidecar under `<projectDir>/<leadSessionId>/subagents/` (sidecar carries `agentType`/`description`/`toolUseId`, plus `name` when the spawn was named), completion via `queue-operation`, matched by `<tool-use-id>` OR by `<task-id>` (the launch result's `agentId`, kept beside the tool id in the lead's `backgroundSpawns`, `server/src/backgroundSpawns.ts`): a post-crash notice lists only task ids (`status: stopped`), and an agent revived with SendMessage completes under the SendMessage call's tool id. An **interim notice** ends nothing: a background agent that stops to wait on background work of its own (a background Bash, a Monitor) gets a completion-shaped notice each time it pauses — same `status: completed`, the tool id on the first one and only the task id after — that only its summary ("… is waiting on its own background work") and note ("may be interim") tell apart from the final one; the provider recognizes it (`TeamProvider.isInterimSpawnNotice`), and both the live path (transcriptParser) and the restart check (`stillRunningSpawns`) leave the spawn live until a notice that isn't interim. A SendMessage result carrying `resumedAgentId` (a stopped agent revived, e.g. by a lead resumed after a crash) makes that call a live background spawn of its own: the provider's `extractBackgroundAgentFromToolResult` recognizes both kinds of result (launch and revival), and the runtime handles them as one, ignoring a result whose task id is already live. The scan ties the sidecar to the SendMessage spawn by the task id the provider reads off its transcript name (`agent-<taskId>.jsonl` → `discoverTeammates` entry `taskId`, `liveSpawnToolIdOf`), because the sidecar's `toolUseId` still names the original spawn the new process never saw. `scanForBackgroundAgentFiles` classifies them by the sidecar `name` (`classifySpawn`) — the domain model's sole Sub-agent vs Teammate distinction (see CONTEXT.md):

- **Named → Teammate**: its own seated character, `agentName` from the sidecar `name`; the spawner gets `isTeamLead` + an `agentTeamInfo` broadcast (derived team — NO `teamName`, so config polling stays away) and the transient Subtask is ghost-killed via `subagentClear`. The child has `leadAgentId` + `spawnToolUseId`; it's removed on the completion queue-operation or lead sessionEnd (`removeTeammate` must NOT unregister its session — it shares the lead's).
- **Unnamed → Sub-agent**: the Subtask sub-character stays; the spawn's transcript is watched in a **shadow `AgentStateStore`** (`server/src/subagentWatch.ts`, owned by `AgentRuntime`, ids from 1 000 000 up) whose broadcasts are translated onto the main store as `subagentToolStart/Done/Permission` keyed `(leadId, spawnToolUseId)` — live activity on the sub-character, no protocol change. `agentToolsClear` on the shadow agent synthesizes `subagentToolDone` for still-live tools so the sub idles between turns. Never persisted, never announced.

The gate for both: the sidecar must match a LIVE spawn of the lead, by `toolUseId` or task id (anti-spurious; no teamName involved). A spawn whose CALL carries a `name` (`teammateSpawnToolIds`, unless explicitly `run_in_background: false`) is never classified before its launch result lands: its sidecar can appear first, and deciding then watched it as a Sub-agent for good. `scanForTeammateFiles` skips sidecars of live spawns so it can't race the classification. The lead's `backgroundSpawns` (tool id + task id) are persisted through the shared `server/src/agentPersistence.ts` (children never are — they're derived state the 1 s scan re-materializes after a reload; restore skips stale entries with `leadAgentId` but no `teamName`). The turn-end background-tool re-sends (transcriptParser, hookEventHandler, timerManager's `clearAgentActivity`) must include `toolName` + `runInBackground` (or the webview can't recreate the Subtask after `agentToolsClear`) and must skip tools whose spawn became a teammate character (`hasPromotedBackgroundAgent`, or a ghost Subtask appears next to it).

Teammate dismissal is driven by team config polling (`getTeamMembers(teamName)` is authoritative; members with `isActive: false` are treated as departed), by the teammate's own `sessionEnd` (own-session teammates), and by `sessionEnd` on the lead.

**Subtle gate (the one that bit us recently)**: in `webview-ui/src/hooks/useExtensionMessages.ts`, `agentToolStart` with `runInBackground=true` only creates a Subtask sub-character when the **parent has no `teamName`**. With a team, `onTeammateDetected` creates the teammate instead (and the gate prevents a ghost sub-agent). Without a team, the teammate path never fires and the basic Subtask sub-character is the only visible representation. The gate's blind spot — a TEAMED lead's unnamed background spawn — is covered by `subagentToolStart` creating the sub-character lazily when it's missing (`addSubagent` is idempotent); the same lazy path recreates subs after a panel reload.

## Server Runtime

`AgentRuntime` (`server/src/agentRuntime.ts`) is the shared lifecycle core. Both surfaces (`adapters/vscode/PixelAgentsViewProvider.ts` and `server/src/cli.ts`) compose the same runtime; only the `StateAdapter` namespace, `MessageTransport`, and `TerminalAdapter` differ.

```typescript
export class AgentRuntime {
  constructor(opts: {
    store: AgentStateStore;
    providerRegistry: ProviderRegistry;
    layoutPersistence: LayoutPersistence;
    assetCache: AssetCache;
    config: Pick<AdapterSettings, 'hooksEnabled' | 'watchAllSessions'>;
    terminalAdapter?: TerminalAdapter;
    callbacks: RuntimeLifecycleCallbacks;
  });
  registerAgent / unregisterAgent / removeAgent / removeTeammate / removeTeammates
  restoreExternalAgents / handleHookEvent
  startProjectScan / startExternalScanning / startStaleCheck
  dispose();
}
```

Owns timer Maps (waiting, permission, text-idle, stale), scanners (project-dir 1 s, external 3 s, stale 30 s), `HookEventHandler`, `SessionRouter`, `DismissalTracker`. Scanners are skipped entirely while hooks are flowing (`hookDelivered` is set on every agent). `RuntimeLifecycleCallbacks` is the only seam between runtime and host.

### AgentStateStore

EventEmitter-backed container in `server/src/agentStateStore.ts`. Typed mutations, typed events (`agentAdded`, `agentRemoved`, `agentUpdated`, `broadcast`). The broadcast layer subscribes once at boot and translates `StoreEvents` into `ServerMessage` over the active transport. **No module under `server/` calls a transport method directly.**

### SessionRouter and DismissalTracker

Two extracted classes that replaced ad-hoc module state. `SessionRouter` owns `session_id → agent_id` mapping, pre-registration event buffering, and pending external sessions. `DismissalTracker` unifies four legacy globals (`dismissedJsonlFiles`, `clearDismissedFiles`, `seededMtimes`, `pendingClearFiles`) into one class with typed reasons.

### HTTP + WebSocket Server

Fastify v5 with `@fastify/cors`, `@fastify/websocket`, and (in standalone) `@fastify/static`:

| Method | Path                     | Purpose                                                |
| ------ | ------------------------ | ------------------------------------------------------ |
| POST   | `/api/hooks/:providerId` | Bearer-authenticated hook event ingress                |
| POST   | `/api/usage/:providerId` | Bearer-authenticated usage report (status line bridge) |
| GET    | `/api/health`            | Liveness: `{ ok, version, port, pid }`                 |
| GET    | `/ws`                    | Bidirectional protocol channel                         |
| GET    | `/*` (standalone only)   | Webview SPA via `@fastify/static`                      |

`/ws` is gated in **two tiers**, because messages over this socket launch shells, grant durable machine-wide hook consent, and rewrite persisted state.

1. **Connection** (`isAllowedWebSocketOrigin`): embedded requires the Bearer token; standalone requires a same-origin handshake. A missing Origin still connects (non-browser clients send none). This tier is weak by design — a DNS-rebound page sends `Origin` and `Host` as the same attacker-chosen name and IS accepted (`httpServerWs.test.ts` pins that).
2. **Privileged messages** (`standaloneTokenValid`, `ClientMessageContext.privileged`): proved by an out-of-band secret — embedded via its Bearer token, standalone via the server token in the `/ws` `?token=` query, which the CLI prints in the local URL and the SPA forwards (`webview-ui/src/transport/index.ts`). **Never a network position**: peer address, `Host` and `Origin` all ride the channel a proxy speaks, so a LAN-bound forwarder piping bytes to 127.0.0.1 satisfies all three. The token is a replayable bearer capability, not evidence of locality — it reaches browser history (Fastify's request log redacts it, `wsAuth.redactTokenQuery`), so the printed URL is documented to the user as a secret. Standalone persists it in `~/.pixel-agents/standalone-token` (0600) so a bookmarked URL survives restarts; `--rotate-token` replaces it (revoking every device at once; refused while another standalone server is running, since it would keep honouring the old one). The terminal socket (`/terminal/:agentId`) carries it the same way and both sockets decide privilege with ONE predicate, `wsAuth.standaloneHandshakeVerdict`: the token AND an allowed `Host` — loopback, a specific `--host`, or a name passed with `--allowed-host` (anti-DNS-rebinding defence in depth). The allowlist is explicit rather than "loopback when loopback-bound" because a reverse proxy (Tailscale Serve) forwards to 127.0.0.1 under its public name; a loopback-only rule forced `--host 0.0.0.0`, exposing the port and the token in transit to the LAN. **An unprivileged client is read-only**: it may load and watch the office (`webviewReady`) and NOTHING else — every other message is refused by one gate at the top of `handleClientMessage` (`refuseReadOnly`), so a new message type is privileged by default. Where the UI updates optimistically (settings toggles, hooks toggle, asset directories, area mappings), the refused client is re-sent the real state. A tokened connection under an unlisted Host is read-only too and logs the `--allowed-host` hint. A second standalone launch reuses a running server only when its access matches (`ServerConfig.standalone`: terminal on/off, bind host, allowed hosts) — otherwise `--no-terminal` would silently attach to a server with a shell.

The **hooks preference is persisted only after the install/uninstall settled and the on-disk result agrees** — writing it first strands the user when an uninstall fails: entries still firing, but a persisted hooks-off makes the next startup skip the consent/install path entirely.

Server discovery written to `~/.pixel-agents/server.json` with `{ port, pid, authToken }`. Multi-window safe: a second server detects an existing `server.json` and reuses or replaces it based on PID liveness.

### ClientMessageHandler

Single dispatch point for `ClientMessage`. Each variant calls into `AgentRuntime`, `AgentStateStore`, `LayoutPersistence`, or `FileStateAdapter`, or delegates to host-specific callbacks (`onLaunchAgent`, `onOpenSessionsFolder`, `onExportLayout`, `onImportLayout`, `onSetHooksEnabled`). Both surfaces wire the same handler.

### ServerAgentState (server/src/types.ts)

Per-agent runtime data: provider reference, session key, transcript-fallback fields (`jsonlFile`, `fileOffset`, `lineBuffer`), tool state Maps and Sets, team fields (`teamName`, `agentName`, `isTeamLead`, `leadAgentId`, `teamUsesTmux`), context usage (`contextTokens`, `maxContextTokens`, `sawMainChainUsage`), and the **`hookDelivered`** flag that suppresses heuristic timers when hooks are flowing.

## Persistence

```
~/.pixel-agents/
  config.json              { vscode, standalone, externalAssetDirectories, hooksConsent, hooksEnabled (both per-provider), directories, recentCharacters }
  vscode-state.json        { agents, seats, cardOrder }
  standalone-state.json    { agents, seats, cardOrder }
  layout.json              OfficeLayout (shared across surfaces)
  characters.json          CharacterProfile[] (shared across surfaces; absent = the six defaults)
  wardrobe-items.json      WardrobeItem[]: custom items saved from the pixel editor (absent = none)
  server.json              { port, pid, authToken }
  usage-limits.json        { [providerId]: { fiveHour?, sevenDay?, updatedAt } } — last plan-usage report (usage bars)
  hooks/claude-hook.js     Bundled hook script (CJS, shebang)
  hooks/claude-statusline.js  Status line bridge script (only while Usage Bars is on)
```

`FileStateAdapter({ namespace })` backs both runtimes. Per-namespace settings: `soundEnabled`, `lastSeenVersion`, `alwaysShowLabels`, `watchAllSessions`, `hooksInfoShown` (the hooks preference is per-provider and machine-global, at the config top level). Running both surfaces in parallel never clobbers either.

`migrateVsCodeState` (VS Code adapter only) walks each known legacy key once with **verify-before-clear** semantics: write to file, read back, only then clear the legacy key. While anything remains unmigrated, activation shows a non-blocking warning.

Layout and character-profile writes go through ONE `writeJsonAtomic` (tmp + rename) beside ONE generic watcher (`jsonFileWatcher.ts`: hybrid `fs.watch` + 2 s polling) used for both `layout.json` and `characters.json`; the write marks every live watcher of that path, after it succeeded (a failed write throws and marks nothing), so no watcher re-reads our own write and no caller has to remember to say so. An external `characters.json` change that validates updates the cached list and is broadcast as `characterProfilesLoaded` without a `saveId`; one that doesn't validate is ignored.

## Agent Status Tracking

JSONL transcripts at `~/.claude/projects/<project-hash>/<session-id>.jsonl`. Project hash = workspace path with `:`/`\`/`/` → `-`.

**JSONL record types**: `assistant` (tool_use or thinking), `user` (tool_result or text prompt), `system` with `subtype: "turn_duration"` (reliable turn-end signal), `progress` with `data.type`: `agent_progress` (sub-agent tool_use/tool_result, non-exempt tools trigger permission timers), `bash_progress` (Bash output — restarts permission timer), `mcp_progress` (MCP tool — same timer restart). Also observed but not tracked: `file-history-snapshot`, `queue-operation`.

**File watching**: 500 ms polling with partial-line buffering for mid-write reads. Tool-done messages delayed 300 ms to prevent React batching from hiding brief active states.

### Dual-mode detection

| Mode                     | Source                                                 | Detection                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hooks** (preferred)    | Claude Code Hooks API → HTTP POST → `HookEventHandler` | Instant, reliable. Installed events are `CLAUDE_HOOK_EVENTS`. `UserPromptSubmit`/`TaskCreated` are deliberately NOT installed — they normalize to null, so installing them only forwarded prompt text to be dropped; `normalizeHookEvent` still tolerates them for stale installs |
| **Heuristic** (fallback) | Polling JSONL files                                    | Per-agent 500 ms JSONL polling for /clear detection; 1 s main scanner for terminal adoption; 3 s external scanner; 30 s stale check. Content-based /clear detection (`/clear</command-name>` in first 8 KB)                                                                       |

The `hookDelivered` flag (per agent) and `hooksEnabled` (global) gate timer logic. JSONL polling always runs in both modes for tool content (status text, animations); only permission (7 s) and text-idle (5 s) timers are suppressed by `hookDelivered`.

### Sub-agent permission detection (heuristic)

When a sub-agent runs a non-exempt tool, `startPermissionTimer` fires on the parent agent. If `PERMISSION_TIMER_DELAY_MS` (7 s) elapses with no data, permission bubbles appear on both parent and sub-agent characters via `agentToolPermission` + `subagentToolPermission` broadcasts.

`activeSubagentToolNames: Map<parentToolId, Map<subToolId, toolName>>` tracks which sub-tools are active for the exempt check. Cleared when data resumes, Task completes, or `turn_duration` arrives.

**Timing budget for tests**: the test waits for the bubble AFTER waiting for the "Subtask:" overlay. But the Subtask overlay appears when the parent's **Task tool_use** is parsed (scenario time T), while the timer only starts when the **sub-tool tool_use** in the progress record is parsed (~1 s later). Plus 7 s timer + 300 ms IPC/render slop = a wait timeout less than ~10 s is unsafe.

### Context usage (server/src/contextUsage.ts)

Every agent's context gauge. Fed from `message.usage` on assistant records by `processTranscriptLine`, broadcast as `agentContextUsage` and rendered by `ToolOverlay`.

- **Snapshot, not a total.** Context = the newest turn's `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` — no output tokens, exactly as Claude Code's own `context_window.used_percentage` counts it. Summing turns measures spend, not occupancy, and misses the cached tokens that ARE the context (`input_tokens` is single digits once caching kicks in). Falls on compaction and `/clear` for free.
- **All-zero usage means "no news"** — synthetic records (API errors, interrupts) report zeros and must not blank the gauge.
- **/clear is a real 0.** The fresh transcript (`reassignAgentToFile`, read whole) resets the agent to 0 tokens and says so (`clearContextUsage`), and a reported 0 is re-sent on every connect (`contextReported`); since the server never forwards a meaningless zero, the office trusts any 0 it hears and draws it as a FULL bar, over the character and on its card alike (`contextUsedShare`, `Character.contextReported`). A resumed session keeps its gauge.
- **Sidechain rule**: a lead's sidechain records are its sub-agents' turns and must not move its gauge; a teammate's own transcript is sidechain top to bottom and would otherwise never report. Positional latch (`sawMainChainUsage`): once a file produces a main-chain turn, later sidechain records belong to someone else.
- **The window comes from the provider**, not from the runtime: `HookProvider.contextWindowForModel(model)` (Claude: 1M for the current line, 200k for Haiku and the older models, `undefined` for ids it can't place). Transcripts state usage but never the limit, and guessing 200k for a 1M model reads five times too full. `widenContextWindow` is the backstop for unrecognized models and unknown-larger windows — it only ever widens, since a context that doesn't fit disproves the assumption while a shrinking one proves nothing.
- **`seedContextUsage` runs once per agent in `startFileWatching`** — the single seam every watched agent passes through. Agents adopted or restored mid-session start at end-of-file, so without a tail read they'd have no gauge until their next turn.
- **The CLI's own number wins.** With Usage Bars on, the status line bridge also reports each session's `context_window` (`used_percentage` + `context_window_size`); `applyReportedContext` sets the agent running that session to it and keeps the reported window (`reportedContextWindow`) for its later transcript estimates, so the gauge reads what the status line reads.
- Sub-agents get no gauge: no session of their own, and the shadow store never forwards `agentContextUsage`.
- **Drawn as a health bar** (`office/ContextBar.tsx`, the card's and the label's alike): the fill is the context LEFT (full when empty, draining as it fills), the colour still warns by the share used, in the user's status line steps (green < 33% used, yellow — the usage bars' — to 66%, red past it); `data-context-pct` stays the share used (e2e reads it).

## Recent conversations

Standalone (tokened, terminal available) lists them in both shells — desktop: a left sidebar, open until the button above the zoom buttons shuts it (remembered per browser), with Settings pinned at its foot (the toolbar never has a Settings button where the sidebar exists, shown or shut); phone: the menu (`mobile/MobileMenu.tsx`, the top-left menu button, or a swipe from the office's left edge that pulls it in with the finger as the right edge pulls the terminal — `useEdgeSwipe` drives one `SwipePanel` per edge), a panel sliding in from the left over the office with Settings at its foot (mounted at App's top level; a resume closes it and slides to the terminal once it opens (`lastLaunched`), like a + launch). Both show one `ConversationList`: on top "Recent", the newest `RECENT_CONVERSATIONS_COUNT` (5) across every Directory with the Directory's name under each title (`recentAcross`, derived client-side: the newest overall are always among each Directory's newest), then one collapsible section per Directory (collapsed until opened, one open at a time — opening one shuts the other; the open one remembered per browser in localStorage). The list: for each Directory of the launch drawer, every conversation an agent in the office is running (`agentId` set, its current look, "New conversation" until titled; the row shows its agent card's status dot instead of the time, and a press goes to the agent as its card would: App's `openAgentFromSidebar`, the phone's `useMobileShell.openAgent`) plus its last `CONVERSATIONS_PER_DIRECTORY` (5) past ones, newest first, titled the way Claude Code titles them (`HookProvider.conversationTitle`: Claude's `custom-title` (a /rename) over the newest `ai-title`, else `last-prompt`; read from the transcript's tail, then its head unless the tail holds a rename; a title is cached per transcript while its size and mtime hold; untitled sessions are left out). Transcripts are looked for under the Directory's path AND its symlink-resolved path (the CLI files sessions under the resolved one). Each row shows a 1x mug shot of the character its agent wore (`CharacterMugShot` redraws whenever the character sprites are replaced — `subscribeCharacterTemplates` — so a row drawn before the cast arrived or before an edit catches up) — remembered per session in `conversations.json` whenever the office saves its seats (the seat is only known there), so it outlives the agent. Pressing a row sends `resumeConversation`: `claude --resume <id>` (`buildLaunchCommand` `resume`) in that Directory, the same session id and transcript (read from its end), wearing the remembered character as a pick (repeat recomputed) and asking for its old seat (`agentCreated.seatId`, taken when free). The id must be a UUID (it becomes a CLI argument) and the transcript must exist; a session already in the office is ignored. The list is pulled (`requestConversations` → `conversationsLoaded` to that client only) on open, after agents come or go, after an agent's turn starts or ends (`agentStatus`: its transcript now exists, or its title was written — the desktop sidebar never re-opens to ask), and every 30 s while open.

## Usage bars

Top-left of the office (right of the zoom buttons; on the phone, right of the menu button): how much of the Claude Code plan is left — a weekly bar over a 5-hour bar of the same size, told apart like a game's health and stamina all the way down: weekly green → yellow (≤50%) → red (≤20%), 5-hour blue → purple → red, the share left printed inside each (left-aligned, in the pixel number font), no panel behind. A pixel heart sits left of them (`usage/PixelHeart.tsx`: outlined, shaded, colours in `USAGE_HEART_COLORS`; the beat flashes a one-pixel-bigger frame over it, whole pixels, never a scale). Hovering any of it (on a phone: a tap, undone by a tap elsewhere — hover is off there, since a tap's emulated mouseenter would cancel its own toggle) makes the heart beat at a pace proportional to the WEEKLY share left (`USAGE_HEART_MAX_BPM` at full, slower as it runs down, still when empty) and shows each bar's name and reset time just right of it (on a phone, below the bars) ("Weekly · resets in 3d 11h", "5-hour · …") (the age of the numbers is the hover title). Claude Code hands out `rate_limits` ONLY to its status line (subscribers, after a session's first reply), so the data comes from a **usage bridge** (`HookProvider.usageBridge`): Settings → Usage Bars, after a confirm showing the provider's disclosure (the click is the consent — never installed silently, not tied to hooks consent), WRAPS the user's `statusLine` in `~/.claude/settings.json` (`statusLine` is one command, not a list): `node ~/.pixel-agents/hooks/claude-statusline.js --wrap <base64url of their command>`. The script runs their command with the same stdin/env/cwd and passes output + exit code through, and POSTs only `rate_limits` and the session's context share (`session_id`, `used_percentage`, `context_window_size`) to every live server. No status line → a bare bridge that prints nothing (which hides Claude Code's footer hints — disclosed). Off / VS Code uninstall restores their command byte for byte; a status line replaced after us is left alone; non-command shapes and hand-edited wraps are refused. A bare bridge counts as our own output in the backup predicate. With no session running the bars keep the last report (persisted), a window past `resetsAt` shows full, and "updated N ago" says how old the rest is. A project-scope `statusLine` overrides ours, so sessions there don't report. Usage is account data: `usageLimits`/`usageBridgeStatus` go to privileged sockets only.

## Office UI

**Rendering**: Game state in imperative `OfficeState` class (not React state). Pixel-perfect: zoom = integer device-pixels-per-sprite-pixel (1x–10x). No `ctx.scale(dpr)`. Default zoom = `Math.round(2 * devicePixelRatio)`. Z-sort all entities by Y. Pan via middle-mouse drag (`panRef`). **Camera follow**: `cameraFollowId` (separate from `selectedAgentId`) smoothly centers camera on the followed agent; set on agent click, cleared on deselection or manual pan.

**UI styling**: Pixel art aesthetic — sharp corners (`borderRadius: 0`), solid backgrounds (`#1e1e2e`), `2px solid` borders, hard offset shadows (`2px 2px 0px #0a0a14`, no blur). CSS variables in `index.css` `:root` (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, ...). Pixel font: FS Pixel Sans (`webview-ui/src/fonts/`), loaded via `@font-face`, applied globally.

**Pixel icons are 8×8.** Every UI icon is an 8×8 grid in `components/ui/pixelIcons.ts` (`#` = lit pixel, drawn in the text colour), rendered at `PIXEL_ICON_SCALE` whole screen pixels per icon pixel (2 → 16 px). Never scale an icon fractionally: blurred edges break the pixel look. `PixelIcon` also guards against the display doing it: at a browser zoom or scaled display (1.25x, 1.5x) it draws each icon pixel as the whole number of DEVICE pixels at or below `scale` (`components/ui/pixelSnap.ts`, ratio from `hooks/useDevicePixelRatio.ts`), else some rows come out a device pixel thicker than others. Position needs no help — the browser paints each box from a whole device pixel, so nudging one by its fractional offset shifts it a full pixel. To shrink one, step the whole-number scale down (`<PixelIcon name="close" scale={1} />`, 8 px — the roster cards' ×) or draw the shape smaller inside the 8×8 (`zoomIn`/`zoomOut`). Buttons take `icon="<name>"` and draw it left of the label, vertically centred.

**Numbers use the pixel number font.** A 3×5 font drawn as pixel art (`components/ui/pixelFont.ts` glyphs + `splitLabel`, `PixelText.tsx`): only number words ("73%", "-40", "3d 11h", "3x", "v1.5", "1 / 21", an upper-cased hex "#1E1E2E", a month "OCT 13" — `timeAgo` writes dates with `MONTHS`, never the locale's) become glyphs, everything else stays in FS Pixel Sans. Use `<PixelText text=… />` (`smaller` = one device pixel less per glyph pixel, a crisp in-between on 2x/3x screens — the sidebar's times) wherever the UI prints a number (history times, slider values, zoom level, version, usage bars); a text field shows it through `PixelInputText` (the field's own text is transparent until focused). A new character needs its glyph and the `NUMBER_WORD` pattern.

Custom ESLint rules (`eslint-rules/pixel-agents-rules.mjs`) enforce: `no-inline-colors` (hex/rgb/rgba/hsl/hsla literals only in `constants.ts`), `pixel-shadow` (must use `var(--pixel-shadow)` or `2px 2px 0px`), `pixel-font` (must reference FS Pixel Sans). All `error`-level — they block PRs.

**Characters**: FSM states — active (pathfind to seat, typing/reading animation by tool type), idle (wander randomly with BFS, return to seat after `wanderLimit` moves). 4-directional sprites, left = flipped right. Tool animations: typing (Write/Edit/Bash/Task) vs reading (Read/Grep/Glob/WebFetch). Sitting offset: characters shift down 6 px in TYPE state. A TYPE character that isn't active (resting in its chair after wandering, or held by `seatTimer` — a usual rest is `restInChair`) shows the **seated** frame instead of typing; helpers (sub-agents) never do — they keep typing through the gaps between tools and stand once idle. Z-sort uses `ch.y + TILE_SIZE/2 + 0.5` so characters render in front of same-row furniture but behind lower-row furniture. **Chair z-sorting**: non-back chairs use `zY = (row+1)*TILE_SIZE` (capped to first row); back-facing chairs use `zY = (row+1)*TILE_SIZE + 1` so the chair back renders in front of the character. Chair tiles are blocked for all characters except their own assigned seat (per-character pathfinding via `withOwnSeatUnblocked`).

**Palette assignment** — a launch's look is ONE pure choice, `core/src/paletteUtils.ts` `chooseLook` (server: `paletteAssigner.assignPaletteIfNeeded(agent, store, { picked, directory })` on both surfaces; the webview's fallback for an agent the server gave no look calls it too). First match wins: a roster pick (`launchAgent.palette`, worn even if taken), else the launch Directory's **default characters** (`Directory.characters`, highest priority first, set in the Directory modal; `characterOrder` `priority` = the first one no agent wears, `random` = a random unworn one; either way all worn → fall through, a default in the office is never repeated — `core/src/directoryCharacters.ts` `pickDirectoryCharacter`), else `pickRandomPalette()`: a random character no agent in the office wears — deliberately NOT least-used — preferring ones no Directory claims as a default (`directoryDefaults()`, so a Directory's characters stay free for its own launches); only when the whole cast is in the office a random repeat. **A look is `{ palette, repeat }`**: `repeat` says which copy of its character an agent is (`repeatFor`: the lowest no other copy holds, 0 when no one wears it; teammates and sub-agents copy their lead's). Core knows no colours: the webview draws the nth repeat with every piece of clothing colorized to the nth colour of `REPEAT_CLOTHES_HUES` (red, blue, green, yellow, purple, cyan, pink, then more, cycling; `characters/repeatClothes.ts` `withRepeatClothes`: underwear, pants, top, outfit, jacket, shoes, hat; skin, hair, eyes and accessories stay), rendered from the profile on demand (`officeSprites` hands `setCharacterTemplates` the sheets and their repeat source together); an external `char_N.png` has no clothes to tell apart, so its repeat is hue-turned whole (`repeatHueTurn`, `adjustSprite`). Palettes = the character profiles, then any external `char_N.png` (server: `getPaletteCount()`). The launch drawer shows a Directory's defaults as 1x mug shots side by side: up to 4 all show; from 5, the first 3 (random order: 3 random ones) plus a dark blank-character silhouette with "..." (`DirectoryCharacterStrip`, `directoryStrip.ts`); pressing a mug shot launches as that character (`launchAgent.palette`), pressing the "..." shows every default (6 to a line, until the drawer closes); a drawer opened by a roster pick (`LaunchDrawer` `pick`, from `useRosterLaunch`) shows only the Directory names and launches as the pick, the rest of the row launches in the Directory's order, and a user row's pencil is drawn outside the drawer, hanging off its right border level with the hovered row (re-measured by a `ResizeObserver`). Character stores `palette` (profile index) + `repeat`; older saves' looks in degrees (`clothesHue`, and `hueShift` up to v1.5) are read as "a repeat" (non-zero = 1). **A palette is an index, so the list keeps them on their character**: every profile has a permanent `id` (`char-<index>` for a list saved before ids, a fresh one for every character the cast adds, copies and loaded configs included), and a save (or a `characters.json` rewrite) that inserts or deletes characters is matched old to new by id (`core` `characterRemap`). `server/src/characterRemap.ts` renumbers this process's agents and their saved seats (an agent whose character was deleted gets a new look; a follower copies its lead's) and sends them as `characterProfilesLoaded.agentLooks`, applied with the list (`officeState.setAgentLook`); the process that saved also renumbers the machine-wide references (Directory defaults, the roster's recency, past conversations' looks) and re-sends Directories and recency. Sprite cache keyed by `"palette:repeat:blink"` (a palette that can't blink shares its open-eyed set under the blink key). **The server owns each agent's look** (picked at creation; a teammate copies its lead's): `saveAgentSeats` only fills a look an agent doesn't have yet, and a reconnect's `existingAgents` re-applies look and seat to characters the office already shows (`syncAgent`) — a stale browser saving back its old ones used to reshuffle the office for every viewer.

**Spawn/despawn effect**: Matrix-style digital rain animation (0.3 s). 16 vertical columns sweep top-to-bottom with staggered timing. Spawn: green rain reveals character pixels. Despawn: character pixels consumed by green rain trails. `matrixEffect` field on Character (`'spawn'`/`'despawn'`/`null`). Normal FSM is paused during effect. Restored agents (`existingAgents`) use `skipSpawnEffect: true` to appear instantly.

**Sub-agents**: Negative IDs (from -1 down). Created on `agentToolStart` with "Subtask:" prefix, or lazily by `subagentToolStart` when missing (watched background spawns, post-reload recreation). Same palette + repeat as parent. Click focuses parent terminal. Not persisted. Spawn at the closest free walkable tile to the parent's seat (the parent itself when it has none, `anchorTile`) — around it, never in a seat. They never wander and never trail a wandering lead: `updateHelper` keeps them within `HELPER_FOLLOW_RADIUS_TILES` of that home tile, walking back when it moves (a reseated lead), facing it, sitting in place (no chair under them) while working and standing while idle. Idle (stop typing) when every tracked sub-tool row is done; overlay shows the latest non-done sub-tool status, falling back to the Subtask label.

**Speech bubbles**: Permission ("..." amber dots) stays until clicked/cleared. Waiting (green checkmark) auto-fades 2 s. Sprites in `spriteData.ts`.

**Sound notifications**: Ascending two-note chime (E5 → E6) via Web Audio API plays when waiting bubble appears (`agentStatus: 'waiting'`). `notificationSound.ts` manages AudioContext lifecycle; `unlockAudio()` on canvas mousedown resumes the context (webviews start suspended). Toggled via Settings modal. Persisted per-namespace in `~/.pixel-agents/config.json`.

**Office radio** (`music/`): procedural 8-bit background music in the office's bottom-right corner (phone: centred, tucked below the office's foot behind a "Swipe up for music" hint, dragged up and down as a sheet, `playerSheet.ts`). Play/pause, skip, volume, a mood (Auto or one of `MOOD_KEYS`) and a **song code** (`TOWN-5-8F3A21C0`: mood, root, seed) to share a tune or play one. A tune is fully determined by its seed, mood and root (`makeSong`), so **the order of every random draw in the composer is part of the song-code format** — `musicComposer.test.ts` pins tunes and codes; a change that moves a draw changes every shared tune. Never plays on its own (browsers start audio only from a click). Hidden or shown from Settings → Music Player (per browser). The version label rides above the player through `radioLift.ts` (`setRadioLift` / `aboveRadio`).

**Mobile shell** (standalone only): below `MOBILE_MEDIA_QUERY` the browser renders `mobile/MobileShell` instead of the desktop layout — office and terminal as two full-screen pages in a 200%-wide sliding track (both always laid out, never `display:none`, so the canvas and xterm keep dimensions); the track's transform makes it the containing block of `position: fixed`, so modals and other viewport overlays mount at App's top level, never inside the office region), the agent cards in a bottom scroller (the same `AgentCardList` as the desktop column: same cards, same server-owned order — `cardOrderLoaded`/`saveCardOrder` — so a reorder on one device moves the cards on every open office), and `MobileKeyBar` above the software keyboard. "Keyboard open" and "clamp the shell" are separate answers (`mobile/keyboardViewport.ts`, sampled by `useKeyboardViewport`) because the two resize policies differ: iOS shrinks only the visual viewport (open, and the shell is clamped to it so the PTY resizes instead of hiding its input line), Android `interactive-widget=resizes-content` shrinks both (open, nothing to clamp). Open = an editable focused AND the visual viewport `KEYBOARD_MIN_HEIGHT_PX` below the tallest height seen at the current width (per-orientation baseline). `useIsMobile` is gated on `isBrowserRuntime`: a narrow VS Code panel must never get it (it broke every VS Code e2e shard once). Navigation rules live in `useMobileShell`: the >_ / Office toggle and the edge swipe share one handler; a card tap in the office is two-step (focus the character, then open its terminal), in the terminal it switches panes; + slides over only for launches made from it (a reload re-announcing sessions stays on the office): App reacts to `useTerminalDrawer`'s `lastLaunched`, set only for the first terminal to open after `expectLaunch`, and only within `LAUNCH_ANSWER_TIMEOUT_MS` (`hooks/launchLatch.ts`): a spawn that fails opens no terminal and no message says so, and an armed latch would otherwise claim the next terminal any device opens. an arrow right of the + card (a narrow `ROSTER_ARROW_WIDTH_PX` tab beside the square +, both as tall as `AGENT_CARD_HEIGHT_PX`; accessible name "Roster", `aria-expanded`; on both pages; it points up while shut and turns down while open, and a tap toggles) opens the roster (`CharacterPicker`, a full-width strip that slides up from behind the card bar; the arrow stays to close it), not the Characters view: a tap picks the character and opens the + card's Directory drawer, whose launch carries it as `launchAgent.palette` (worn even if taken, then in the next clothes colour); a long press (`useLongPress`, like a Directory row's) and the leading `+ New` slot open the Characters view on it. Desktop (both surfaces) runs the same flow (`useRosterLaunch`, hover and pin by `useHoverPin`) from the toolbar's + card, drawn like the phone's (a square `+` — accessible name "New agent" — with the roster arrow beside it, then Layout, and Settings only where no conversation sidebar holds it): the carousel shows above the toolbar without animation, and a hovered card's pencil edits; VS Code's `launchNewTerminal` honours `palette` too (`applyPickedPalette`). The terminal-pane model (active vs shown pane, socket status, `statusFor`) is `useTerminalDrawer`, shared with the desktop drawer. Touch rules: every gesture tracks ONE finger by identifier (`findTouch`) and uses one tap slop (`withinTapSlop`); gesture decisions are pure reducers with thin DOM adapters (`edgeSwipe.ts`/`useEdgeSwipe.ts`, `terminal/touchGesture.ts`/`touchInput.ts`, the radio's `music/playerSheet.ts`/`usePlayerSheet`; the key bar's trackpad sends left/right twice as fast as up/down, accelerating so a drag from the press point to a screen edge sweeps the terminal's full line (`TerminalInputHandle.cols`), and holds one axis per slide, re-deciding only after the finger rests, `touch/trackpad.ts`), because WebKit keeps addressing a gesture's events to its touchstart node — when terminal rows repaint, that node detaches and events stop bubbling, so each adapter binds "rescue" listeners on the touch target. **Terminal copy is verbatim by default**, except that a token Claude Code broke across rows (a URL, a path: `hardWrap.ts`) always comes back whole — that break's signature is one an intended newline doesn't have, and links (tap or click) follow it the same way (Cmd/Ctrl+C, the browser's Copy, the pill's Copy; paste is a long press on the input area — the cursor's row out to the prompt box's rules (`terminal/inputArea.ts`) — not a key): re-flowing (`terminalCopyText`'s `'text'` mode) is a heuristic that joins a long row with a two-space-indented next line, which is also what YAML under a long key or a method body under a long signature look like, so re-flowing is opt-in only — Alt+C (Option+C) on desktop, "Copy as text" on the pill. Every write goes through `terminal/clipboard.ts`. PWA: `manifest.webmanifest` (icon paths relative — the file is served verbatim), conventional-path icons in `public/`, `?v=N` cache-busters on icon links.

**Seats**: Derived from chair furniture. `layoutToSeats()` creates a seat at every footprint tile of every chair. Multi-tile chairs produce multiple seats keyed `uid` / `uid:1` / `uid:2`. Facing direction priority: 1) chair `orientation` from catalog (front→DOWN, back→UP, left→LEFT, right→RIGHT), 2) adjacent desk direction, 3) forward (DOWN). Click character → select (white outline) → click available seat → reassign.

## Characters

The Characters view (bottom toolbar button; phone: next to Settings) designs the cast. Desktop: a modal of three panes (roster | animated preview + export sheet | wardrobe tabs). Phones: a full-screen page (pinned preview, carousels, bottom dock). `characterRenderer.test.ts` pins the six default sheets to their reference renders pixel for pixel.

- **Profile** (`core/src/characterProfiles.ts`): a permanent `id` (unique in the list, see Palette assignment), one wardrobe part id per slot (`CHARACTER_SLOTS`), `colors[key]` (`CharacterColor` = HSBC + optional exact `palette` swap), `edits[pixId(piece, part)]` (uncoloured pixel edits per frame, `{ cells }` — no revision; the renderer caches by content), `eyeShape`, `eyeRows`. Pixel set ids are `'<set>:<part>'`, built and split only by `pixId` / `parsePixId`. Format `v: 35`; `migrateCharacterProfile` brings any older one (v30 = the artifact's) up in one pass wherever profiles are read (server file, Load config) — every rename leaves ids it doesn't name alone, so no per-version gates: bodies (`flat`/`bust`) and eye shapes (`plain`/`lashes`), the eye whites piece `eyefix` → `whites` in edit keys, `rev` dropped, part renames (`PART_IDS`: the PSD layer ids `layer_9` → `business_suit`, … and parts named after people `helly_top` → `turtleneck`, …; per slot, in slots and edit keys), and the deleted retired parts replaced (bowling shirt → red `tshirt` under the `vest` in its Original colourway, uniforms → `business_suit`; their edits are dropped), and edits moved from the 7-frame sheet (every format before v35; v34 was taken by unmerged work, still 7 frames) to the 8-frame one (`widenLegacyCells`: frames rekeyed, the seated frame's cells derived like its art). The profile types are the wire contract's (generated `messages.ts`, `eyeRows` narrowed to `EYE_ROWS`); a compile-time check pins `CHARACTER_SLOTS` to the contract's part-id fields. The server only validates shape; part ids mean something only to the webview.
- **Wardrobe art** is finished pixels, one 128×96 office-layout PNG per asset, uncoloured: `<piece>/<part id>.png` (`hair/bob.png`), per body `body/<body>.png` (the doll body, its eye holes filled with lid skin so it never shows holes; the eyes cover it) + `under/`, `utop/<body>.png`, the eyes `eyes/<shape>/` (one copy for every body) = `whites` (whites and pupils, never recoloured), `iris.<rows>` (rows `top`/`bottom`/`both`: which pupil pixels take the eye colour, drawn over them) plus `lashes` — a shape has only the files it draws, a missing file draws nothing; `closed-stern/lashes.png` is the blink over Stern (it keeps Stern's brows), and `props/reading-glasses.png`, `props/paper.png` (drawn over everything in the reading frames; nothing of them lives in the eye files). An outfit may come with its tie as a sheet of its own, `tie/<outfit id>.png` (optional art; its own `tie` colour key and Outfit-tab picker, shown only when the outfit has one; uncoloured it wears the outfit's colour, so looks saved before the split are unchanged). `wardrobe.json` holds only parts (label, `neutral`, colourway `swaps`) and category palettes. Adding a part = its PNG + its line in wardrobe.json; `decodeWardrobe` fails loudly on a part without a PNG, a PNG without a part, or a wrong size. All PNGs are inlined into the bundle (`import.meta.glob` + `?inline`) because VS Code serves webview resources cross-origin, which would taint the decoding canvas. The pose map, head pass, touch-ups and drawn eye shapes that once produced them are gone (baked once from the old MetroCity strips).
- **Slot table** (`slots.ts`): a piece is defined once, in `LAYERS` (draw order; its slot, colour key, editor label and chip order, `when` underwear, `behind`, `neutral`; a `kind: 'part'` layer names the slot that picks it (`sel`), a `kind: 'eye'` layer draws from the eye folder, `rows` its eye-row variants, `filedBy` its edits' key); `shownArt` maps a profile + piece to its `Art` (path, layer, wardrobe part — never parsed back from the path), the colour → art map (`colorArt`; the first piece with a colour owns its colourways), the editor's pieces (`EDIT_PIECES`, `wornPieces` = shown and with art), `DRESS_SLOTS` (randomize) and `SlotKey` (core's `CHARACTER_SLOTS`) are derived. `TABS` carries each tab's pickers, editor piece, the underwear it offers (`underOf`, `tabPiece`) and the slot that lives inside it (`inner`: Hair's beard). The rest of the character model lives here too, as tables: `EYE_SHAPES` (label, tooltip, `drawn`/`bare`/`blinkLashes`; `eyeShape(p)` resolves the body default), `BODIES` (default eyes and underwear top, `startingUtop`), `UNDERWEAR`; a blink is `{ ...p, blink: true }` (`canBlink` decides when; the shape stays, so its rules hold). Mutations live in `profiles.ts` and touch only top-level fields, so the wardrobe's option thumbnails preview each card's own `wear` on a shallow copy. Underwear only shows where nothing covers it (`wornUnder` — the one definition, the editor's too), drawn over the doll body. Edit keys (`editKey`): lashes by eye shape, whites and iris by body except under a drawn shape (Lidded, Stern, Closed: by shape).
- **Renderer** (`renderer.ts`, DOM-free): per piece its art file + the profile's edits, tinted (`color.ts`, the artifact's rounding — not office/colorize.ts) and stacked in `LAYERS` order (earrings `behind` hair in the back view), then the reading glasses (not for `bare` eye shapes) and the paper. Layer and sheet caches key edits by content. Sheet geometry and the alpha threshold come from core (`sheet.ts`); the manifest is checked at load (`parseWardrobeManifest`).
- **Cast** (`cast.ts` `CastStore`, the app's instance in `castStore.ts`): one store for office and view; it knows neither the DOM nor the office — `officeSprites.ts` `startOfficeSync` subscribes (wired in useExtensionMessages, which hands the cast's messages to `castMessages.ts`), and CharactersView reports presses (`beginStep`/`endStep`). **The view edits a draft**: `profiles` is the saved list (the office, the toolbar roster and every other reader wear it); the first select/edit/add opens `draft`, a working copy the view shows, and nothing reaches the server until Save (the header's / phone bar's Save button, ⌘S): `save()` makes the draft the saved list and sends it. `dirty` = the draft is not the list it started from or was last saved as (by reference, so undoing back to it is clean). Closing with `dirty` asks (Keep editing / Discard / Save); `discard()` drops the draft. So the toolbar roster's `+ New` adds the character to the draft only — it joins the roster on Save. A foreign list replaces a clean draft and leaves a dirty one alone (saving it then wins). Undo history is `history.ts` (pure). Server owns the list (`characterProfilesLoaded`; `server/src/characterProfilesPersistence.ts` on both surfaces, like Directories); Save sends the whole list (`saveCharacterProfiles` with a client-chosen `saveId`). Every save is answered with `characterProfilesLoaded` carrying that `saveId`: broadcast to every client when it persisted (exactly the persisted list — a valid v35 list comes back byte-identical), sent to the sender alone with the list still on disk when it was refused (invalid, failed write, or a read-only client). No `saveId` = initial load or an external file change. The client keeps its in-flight saveIds: an answer acks its save and every older one; while a save is in flight, other lists are ignored (stale, or about to be overwritten: last writer wins); when idle, a list that differs replaces the local one and clears the undo history (a refused save's answer does exactly that), an equal one is its own echo and changes nothing. A reconnect re-sends unanswered saves. Adds stop at `MAX_CHARACTER_PROFILES` (status line says so). Validation is ONE deep validator, `core/src/characterProfiles.ts` `parseCharacterProfiles` (colours: finite h/s/b/c; edits: `cells[frame 0-23][pixel 0-511]` = `#rrggbb` or null), also behind Load config (`parseConfigFile`), run by the server before persisting and by the webview before drawing. Undo/redo: a press starts a step and everything until release joins it; otherwise 500 ms merges; card switches aren't steps; entries remember the editor frame.
- **Custom items** (`core/src/wardrobeItems.ts`, `characters/items.ts`, the pixel editor's Item section `ui/ItemTools.tsx`): a worn piece exports as a piece sheet (the piece alone, art + this character's edits, uncoloured, 128×96 PNG — the wardrobe art's own form; a 112×96 one from before the seated frame still imports, and older custom items decode the same way, `decodeSheet`); Import PNG turns a piece sheet back into this character's edits on the piece (`editsFromSheet`: the pixels that differ from the art); "Save as new item" bakes the piece's art + edits into a `WardrobeItem` (`{ id: 'custom_…', piece, label, base, png }`, base64 PNG), and the character wears it with those edits dropped. Items are worn like built-in parts (`profile.hair = 'custom_…'`) and take the colours of their `base` built-in part (gray-ness, colourways, palette row: `wardrobe.ts` `withItems`). Only hair, clothes and accessories (`ITEM_PIECES`), not bodies or underwear. Items live in the cast draft (added and deleted with undo, sent on Save with `saveCharacterProfiles.items`, answered and broadcast in `characterProfilesLoaded.items`, persisted to `wardrobe-items.json`; one validator, `parseWardrobeItems`). An item never changes once made, so the renderer holds the saved items and the draft's together (the office may still wear one the draft deleted); the view offers only the draft's (`offeredParts`). Deleting an item takes it off every character. Character configs and roster zips don't carry the items they wear.
- **Exports**: Save PNG / config / roster zip / piece sheet download in the browser; in VS Code they go through `exportFile` (host save dialog).

## Layout Editor

Toggle via "Layout" button. Tools: SELECT (default), Floor paint, Wall paint, Erase (set tiles to VOID), Furniture place, Furniture Copy (`FURNITURE_PICK`: type + colour off a placed item), colour Copy (`COLOR_PICK`: colour only), Eyedropper (floor/wall). `handleEditorTileAction` is a per-tool switch; the layout maths lives in pure `editorActions.ts` functions. Clicks on placed items (select, drag) never reach it — the canvas resolves them.

**Floor**: 7 patterns from `floors.png` (grayscale 16×16), colorizable via HSBC sliders (Photoshop Colorize). Color baked per-tile on paint. Eyedropper picks pattern+color.

**Walls**: Separate Wall paint tool. Click/drag to add walls; click/drag existing walls to remove (toggle direction set by first tile of drag, tracked by `wallDragAdding`). HSBC color sliders (Colorize mode) apply to all wall tiles at once. Eyedropper on a wall tile picks its color and switches to Wall tool. Furniture cannot be placed on wall tiles, but background rows may overlap walls.

**Furniture**: Ghost preview (green/red validity); `buildEditorRenderState` (`office/editor/`) builds the frame's `ghosts[]` + one `ghostValid`. R key rotates, T key toggles on/off state — a selected placed item wins over the catalog type. Drag-to-move in SELECT; **Alt-drag drops a copy** (cursor `copy`, Alt sampled live so it can flip mid-drag; the copy is left selected). The canvas only reports the gesture (`onDrop(uid, col, row, { duplicate })`); `handleDrop` → pure `dropFurniture` validates, commits and sets selection. **Desks carry their riders**: surface items standing on an `isDesk` item (`getSurfaceRiders`) move, rotate (spot swung round the desk top) and get copied with it; the whole group must fit or nothing happens. Delete button (red X) + rotate button (blue arrow) on selected items. **Selecting a placed item closes the open tool tab and opens its HSBC colour sliders** (Reset + Copy buttons); color stored per-item in `PlacedFurniture.color?`. Hit-testing is ONE `furnitureAt` (surface items win over the desk under them) — select, drag, cursor and both Copy tools agree. Placement state is `editorState.placing: { type, color? }`: the Copy tool's lifted colour styles that copy only — `color: null` is a copied ABSENCE of colour, so an uncoloured item's copy stays uncoloured under a palette colour; `undefined` (a plain catalog pick) takes `pickedFurnitureColor` (`placementColor()`); palette sliders override either. Colour Copy takes the clicked item's colour into whichever sliders armed it, then returns to that tool.

**Undo/Redo**: 50-level, Ctrl+Z/Y. EditActionBar (top-center when dirty): Undo, Redo, Save, Reset. **Stroke-scoped undo**: every edit goes through `commitLayout(layout, session)`; edits sharing `editorState.undoSession` collapse into one entry — `'stroke'` (one floor / wall / erase / carpet click-drag), `'wallColor'`, `` `color:<uid>` `` (a slider run on one item). `null` = discrete edit (its own entry; a colour eyedrop is one). Mouse up / leave, tool change, Esc, selection changes and undo/redo end the session (`endStroke`). Area paint stays per-tile.

**Multi-stage Esc**: exit furniture pick → deselect catalog → close tool tab → deselect furniture → close editor.

**Erase tool**: Sets tiles to `TileType.VOID` (transparent, non-walkable, no furniture) **and deletes any furniture whose footprint the stroke passes through** (`removeFurnitureAt`). Right-click in floor/wall/erase tools also erases to VOID + furniture (drag-erasing supported). Context menu suppressed in edit mode.

**Grid expansion**: In floor/wall/erase tools, a ghost border (dashed outline) appears 1 tile outside the grid. Clicking a ghost tile calls `expandLayout()` to grow the grid by 1 tile in that direction. New tiles are VOID. Furniture positions and character positions shift when expanding left/up. Max: `MAX_COLS`×`MAX_ROWS` (64×64). Default: `DEFAULT_COLS`×`DEFAULT_ROWS` (20×11). Characters outside bounds after resize relocated to random walkable tiles.

**Layout model**: `{ version: 1, cols, rows, tiles: TileType[], furniture: PlacedFurniture[], tileColors?: ColorValue[] }`. Grid dimensions are dynamic. Persisted via debounced saveLayout message → `writeLayoutToFile()` → `~/.pixel-agents/layout.json`.

## Asset System

**Loading**: `esbuild.js` copies `webview-ui/public/assets/` → `dist/assets/`. Loader checks bundled path first, falls back to workspace root. PNG → pngjs → SpriteData (2D hex array, alpha≥2 = visible, `#RRGGBBAA` for semi-transparent). `loadDefaultLayout()` reads `assets/default-layout.json` as fallback for new workspaces.

**Catalog**: `furniture-catalog.json` with `id, name, label, category, footprint, isDesk, canPlaceOnWalls, groupId?, orientation?, state?, canPlaceOnSurfaces?, backgroundTiles?`. String-based type system. Categories: desks, chairs, storage, electronics, decor, wall, misc. Wall-placeable items use the `wall` category and appear in a dedicated "Wall" tab. Asset naming convention: `{BASE}[_{ORIENTATION}][_{STATE}]` (e.g., `MONITOR_FRONT_OFF`).

**Per-furniture manifests**: Each furniture item lives in its own folder under `assets/furniture/` with a `manifest.json` that declares its sprites, rotation groups, state groups (on/off), and animation frames. Floor tiles are individual PNGs in `assets/floors/`; wall tile sets in `assets/walls/`.

**Rotation groups**: `buildDynamicCatalog()` builds `rotationGroups` Map from assets sharing a `groupId`. Supports 2+ orientations (e.g., front/back only). Editor palette shows 1 item per group (front orientation preferred). `getRotatedType()` cycles through available orientations.

**State groups**: Items with `state: "on"` / `"off"` sharing the same `groupId` + `orientation` form toggle pairs. `stateGroups` Map enables `getToggledType()` lookup. Editor palette hides on-state variants. State groups are mirrored across orientations.

**Auto-state**: `office/layout/workstations.ts` `pairWorkstations` pairs each seat with at most one electronics item and each item with at most one seat: the tile in front of the seat must be a desk, the item must stand on that desk within reach (3 tiles ahead, 1 to the side up to 2 deep) with its screen facing the seat (front PC ↔ back chair, back PC ↔ front chair, side ↔ side, left ↔ left), closest pair wins. The seat picker prefers paired seats (so sofas near a desk never count); `officeState.rebuildFurnitureInstances()` swaps a PC to its ON sprite only while its seat's agent is active, sitting there and typing (re-checked every frame in `update`). Render-time only, the saved layout is untouched. Only front PCs have ON art today.

**Background tiles**: `backgroundTiles?: number` — top N footprint rows allow other furniture to be placed on them AND characters to walk through. Z-sort places bg-row items behind the host furniture.

**Surface placement**: `canPlaceOnSurfaces?: boolean` — items like laptops, monitors, mugs can overlap with all tiles of `isDesk` furniture. `canPlaceFurniture()` builds a desk-tile set and excludes it from collision checks. Z-sort: surface items get `zY = max(spriteBottom, deskZY + 0.5)`.

**Wall placement**: `canPlaceOnWalls?: boolean` — items like paintings, windows, clocks can only be placed on wall tiles. `canPlaceFurniture()` requires the bottom row of the footprint to be on wall tiles; upper rows may extend above the map. `getWallPlacementRow()` offsets placement so the bottom row aligns with the hovered tile.

**Colorize module**: `colorize.ts` with two modes selected by `ColorValue.colorize?` flag. **Colorize mode** (Photoshop-style): grayscale → luminance → contrast → brightness → fixed HSL; always used for floor tiles. **Adjust mode** (default for furniture, and an external `char_N.png`'s repeats): shifts original pixel HSL. Cache keyed by arbitrary string (includes colorize flag).

**Floor tiles**: `floors.png` (112×16, 7 patterns). Cached by (pattern, h, s, b, c).

**Wall tiles**: `walls.png` (64×128, 4×4 grid of 16×32 pieces). 4-bit auto-tile bitmask (N=1, E=2, S=4, W=8). Sprites extend 16 px above tile (3D face). `wallTiles.ts` computes bitmask at render time. Colorizable via HSBC sliders. Wall sprites z-sorted with furniture/characters (`getWallInstances()` builds `FurnitureInstance[]`).

**Character sprites**: composed in the webview from the character profiles (see "Characters"), followed by `char_N.png` from external asset directories (`characterSpritesLoaded`; there are no bundled character PNGs). Each sheet 128×96: 8 frames × 16 px wide, 3 direction rows × 32 px tall. Row 0 = down, Row 1 = up, Row 2 = right. Frame order: walk1, walk2, walk3, type1, type2, read1, read2, seated (each animation's columns: `SHEET_FRAMES` in `core/src/assets/seatedFrame.ts`). The seated frame is derived from the typing frames by ONE recipe (`core/src/assets/seatedFrame.ts`), baked into every wardrobe PNG: front and back take the left half from type2 and the right half from type1 (each side's forward arm, the hand drawn in over the body; the typing frames mirror each other, so the pose is symmetric), the side view is type1 (its arm sits lower). A 112×96 `char_N.png` from before it gets the column derived on decode. Both the server's `char_N.png` decoding and the webview's composed sheets slice frames through ONE function, `core/src/assets/characterSheet.ts` `sheetToDirectionSprites`. Left = flipped right at runtime. A non-zero `repeat` swaps in the profile's sheet with its clothes recoloured (see Palette assignment).

**Load order**: `characterProfilesLoaded` → `characterSpritesLoaded` → `floorTilesLoaded` → `wallTilesLoaded` → `furnitureAssetsLoaded` → `layoutLoaded`.

## Testing

Three tiers, each with its own framework.

### Server unit/integration (Vitest)

`server/__tests__/` covers the shared runtime, persistence, providers, HTTP/WebSocket server, CLI, diagnostics, asset reloads, and the e2e scenario runner. Representative suites include:

| File                           | Coverage                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentStateStore.test.ts`      | Mutations, EventEmitter events, snapshot                                                                                                       |
| `hookEventHandler.test.ts`     | Routing, buffering, normalized dispatch, team gating                                                                                           |
| `sessionRouter.test.ts`        | session_id mapping, pending sessions, buffer flush                                                                                             |
| `fileWatcherDismissal.test.ts` | DismissalTracker integration                                                                                                                   |
| `fileStateAdapter.test.ts`     | Namespaced persistence, allowlist, settings round-trip                                                                                         |
| `migrateVsCodeState.test.ts`   | Verify-before-clear, partial migration                                                                                                         |
| `teamUtils.test.ts`            | Inline-teammate helpers                                                                                                                        |
| `claudeTeamProvider.test.ts`   | Discovery, membership, metadata extraction                                                                                                     |
| `claude.test.ts`               | `normalizeHookEvent` per Claude event, file fallback                                                                                           |
| `claudeHookInstaller.test.ts`  | Atomic install/uninstall, unparseable-file + non-array abort, throwing writes, mode preservation, backup, hook identity, event-scope migration |
| `consentFlow.test.ts`          | In-app consent over the wire: who is asked, what each answer writes, Back-and-revise semantics, answer serialization                           |
| `claude-hook.test.ts`          | Spawned hook script integration (needs `dist/hooks/claude-hook.js`)                                                                            |
| `server.test.ts`               | HTTP lifecycle, auth, `/ws`, broadcast                                                                                                         |
| `httpServerWs.test.ts`         | `/ws` gate: standalone same-origin, embedded Bearer                                                                                            |
| `mockClaudeRunner.test.ts`     | E2E scenario runner sanity                                                                                                                     |

Every server test file starts with `$HOME` pointed at a fresh temp dir (`__tests__/isolateHome.setup.ts`), so no test can read or write the real `~/.pixel-agents` or `~/.claude`.

Run: `npm run test:server` (or `npm test` for all).

### Webview unit (Vitest, Node runner)

`webview-ui/test/` covers office state, layout editing and migration, assets, changelog behavior, and Vite/browser wiring.

Run: `npm run test:webview`.

### End-to-end (Playwright)

`e2e/` contains Playwright tests against a real VS Code Electron instance and a standalone Fastify server. CI runs the suite on Linux, macOS, and Windows in three shards at `--workers=1`. The generated [e2e inventory](e2e/README.md) is the source of truth for current specs, scenarios, and `@area:` coverage.

**Running VS Code e2e locally needs explicit approval.** The VS Code specs (`e2e/tests/claude/**`) launch real VS Code windows one after another, which cover the screen and steal keyboard focus from whatever the user is typing in. Ask the user before running any of them, and when approved:

- Run them **once, at the end of an implementation** — never as an intermediate check.
- **Never from a subagent**: delegated work verifies with typecheck, lint, unit tests, and the standalone specs (`e2e/tests/standalone/**`, headless browser, no windows).

**Mock claude**: Tests never invoke real `claude`. A bash script (`e2e/fixtures/mock-claude`) is copied into an isolated `bin/` and prepended to `PATH`. The scenario runner (`mock-claude-runner.cjs`) honors `claudeScenario(...).at(ms).appendJsonl(record).emitHook(event).holdOpenFor(ms).build()` to drive timed JSONL writes and hook events.

**Authoring rules (normative)**: before writing a new spec, read `e2e/README.md` → "Mocking model & rules". It is the single source of truth for the process-boundary principle, the append-only transcript rule, the assert-on-visible-outcomes discipline, and the one standalone-server exception. New tests must follow that model.

**Isolation**: each test gets its own `tmpHome`, workspace directory, VS Code `--user-data-dir`, and mock-log file. No state leaks between tests.

**Auto-fixtures**: `_allureLabels` (auto: true) reads `@area:<tag>` from `testInfo.tags` and applies the corresponding Allure epic.

**Single source of truth for test inventory**: `e2e/README.md` contains an auto-generated section spliced between `<!-- BEGIN:E2E-INVENTORY -->` and `<!-- END:E2E-INVENTORY -->` markers. CI regenerates via `npm run e2e:inventory` and fails on `git diff --exit-code e2e/README.md`.

Run:

```bash
npm run e2e                                    # all tests
npm run e2e -- --workers=1                     # single worker (matches CI sharding)
npm run e2e -- --grep "lifecycle"              # filter by name
npm run e2e:debug                              # step-through
npm run e2e -- --attach-videos-on-success      # keep videos for passes too
npm run e2e:inventory                          # regen e2e/README.md inventory
npm run test:report                            # build combined Allure report
npm run test:report:open                       # serve Allure locally (file:// can't fetch)
```

**Reproducing CI failures locally**: CI uses `--workers=1` because the runners can't handle more. Reproduce locally with `npm run e2e -- --workers=1 --grep "<test>"`. For full Linux fidelity, `act -j linux-e2e --matrix shard:1 -P ubuntu-latest=catthehacker/ubuntu:full-22.04 --container-architecture linux/amd64` or run inside `mcr.microsoft.com/playwright:v1.58.2-noble` Docker with `--cpus=2 --memory=4g` to simulate runner throttling.

## Build & Dev

**npm workspaces monorepo** (`server`, `webview-ui`). A single `npm install` at the root installs deps for all workspaces; `cd webview-ui && npm install` is redundant.

```bash
npm install                # installs root + workspaces in one shot
npm run compile            # asyncapi:generate, check-types, lint, esbuild, vite
npm run build              # alias for compile
npm run package            # production build (esbuild --production)
npm test                   # webview + server vitest
npm run e2e                # Playwright
```

`esbuild.js` runs three bundles:

1. **Extension** (`dist/extension.js`) from `adapters/vscode/extension.ts`. External: `vscode`.
2. **CLI** (`dist/cli.js`) from `server/src/cli.ts`. Externals pulled at install time (`fastify`, `@fastify/*`).
3. **Hook scripts** (`dist/hooks/claude-hook.js`) from `server/src/providers/hook/claude/hooks/claude-hook.ts`. CJS, shebang.

`define: { 'process.env.PIXEL_AGENTS_VERSION': JSON.stringify(version) }` stamps the package version into all bundles.

**Watch mode**:

```bash
npm run watch                       # parallel esbuild watch + tsc --noEmit watch
cd webview-ui && npm run dev        # Vite dev server (separate terminal)
```

The webview Vite dev server is **not** included in `npm run watch` — it has to be run separately.

`/loading.html` on the Vite dev server shows the loading screen alone (`loading.html` + `src/loadingPreview.tsx`, dev only, not part of the build), for editing it with hot reload.

**Updating a running office without ending its agents (development only)**: `pixel-agents --pty-host` keeps the agents' terminals in a separate long-lived process (`dist/pty-host.js`, socket `~/.pixel-agents/pty-host/host.sock`, override with `--pty-host-socket`), so a server restart leaves them running and the next server reattaches them (same id, look, screen). The shipped default keeps them in process and ends them with the server. Details: `docs/design/standalone-terminal.md` → "PTY host".

**F5 in VS Code** launches the Extension Development Host with the local extension loaded.

### CI

Single workflow runs (in order): install, lint, `asyncapi:validate`, `asyncapi:generate` + drift check, `e2e:inventory` + drift check, `check-types`, `test:server`, `test:webview`, `e2e` (3-OS x 3-shard matrix: Linux, macOS, Windows), `package`, then a PR-only Vercel preview deploy of the combined Allure report (gated on secrets; gracefully skips on forks, non-blocking on failure). Pushes to `main` run the checks but never deploy to Vercel.

The drift checks are the central guarantees: `core/asyncapi.yaml` ↔ `core/src/messages.ts` stay in lockstep; `e2e/README.md` stays in sync with the spec list.

## TypeScript Constraints

- **No `enum`** (`erasableSyntaxOnly` in webview) — use `as const` objects (`TileType`, `CharacterState`, `Direction`, `EditTool`).
- **`import type`** required for type-only imports (`verbatimModuleSyntax` in webview; convention in extension).
- **`noUnusedLocals` / `noUnusedParameters`** — strict everywhere.
- **`.js` extensions** on all relative imports in extension + server (Node16 module resolution).
- **Module Node16, target ES2022** in the extension/server. **`erasableSyntaxOnly`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`** in the webview.

## Constants Policy

All magic numbers and strings are centralized — never inline:

| Where                              | What lives there                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/constants.ts`          | All timing/scanning constants (`PERMISSION_TIMER_DELAY_MS`, `TEXT_IDLE_DELAY_MS`, scanner intervals) shared by extension and standalone |
| `adapters/vscode/constants.ts`     | VS Code-only IDs, command names, workspace state keys                                                                                   |
| `core/src/constants.ts`            | Protocol-level constants (e.g., transport state names)                                                                                  |
| `webview-ui/src/constants.ts`      | Webview magic numbers (grid, animation, rendering, camera, zoom, editor, game logic) + canvas overlay rgba strings                      |
| `webview-ui/src/index.css` `:root` | CSS custom properties (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, ...) for React inline styles and CSS                           |
| `webview-ui/src/office/types.ts`   | Re-exports grid constants from `constants.ts` for convenience                                                                           |

## Error Handling

- **Try-catch with graceful degradation** — errors logged but never crash the extension.
- **Malformed JSONL lines** silently ignored (catch block in `processTranscriptLine`).
- **Missing assets** logged with warning, operation continues with null/fallback.
- No centralized error reporting or telemetry.

## Logging

Use `console.log`/`error`/`warn` with prefixed context:

- Extension: `[Pixel Agents]`, `[Extension]`
- Asset loading: `[AssetLoader]`
- Webview: `[Webview]`

## Condensed Lessons

- `fs.watch` unreliable on Windows — always pair with polling backup.
- Partial line buffering essential for append-only file reads (carry unterminated lines).
- Delay `agentToolDone` 300 ms to prevent React batching from hiding brief active states.
- **Idle detection** has two signals: (1) `system` + `subtype: "turn_duration"` — reliable for tool-using turns (~98%), emitted once per completed turn. (2) Text-idle timer (`TEXT_IDLE_DELAY_MS = 5 s`) — for text-only turns. Only starts when `hadToolsInTurn` is false; suppressed once `hadToolsInTurn` becomes true. Reset on new user prompt or `turn_duration`. Cancelled by ANY new JSONL data.
- User prompt `content` can be string (text) or array (tool_results) — handle both.
- `/clear` creates a NEW JSONL file (old file just stops).
- **Resume reopens the OLD transcript.** Attaching an agent to a transcript starts at its end unless the file was born within the scan window (`fileWatcher.initialReadOffset`, shared by adoption and `reassignAgentToFile`): reading a resumed session from byte 0 replayed its history and resurrected background spawns that died with the previous process as Sub-agents that never left.
- `--output-format stream-json` needs non-TTY stdin — can't use with VS Code terminals.
- Hook-based IPC failed in early prototypes (hooks captured at startup, env vars don't propagate). HTTP `/api/hooks/:providerId` with `~/.pixel-agents/server.json` discovery works.
- PNG→SpriteData: pngjs for RGBA buffer, alpha threshold 2 (`PNG_ALPHA_THRESHOLD`), supports `#RRGGBBAA` semi-transparent pixels.
- OfficeCanvas selection changes are imperative (`editorState.selectedFurnitureUid`); must call `onEditorSelectionChange()` to trigger React re-render for toolbar.
- **External-session adoption**: scanner runs every 3 s. In hooks-OFF mode external scenarios, the test setup can race the first scanner tick. Mock-claude scenarios should give a few seconds of margin before assertions.
- **Heuristic sub-agent permission bubble timing**: the bubble lands 7 s after the SUB-TOOL is registered, not 7 s after the parent Task tool appears. Tests waiting on it from the "Subtask:" overlay need at least `1 s (Task→Bash gap) + 7 s timer + ~300 ms IPC/render = 9–10 s` budget.
- **runInBackground sub-character gate**: in webview `agentToolStart`, `runInBackground=true` Agent tools are gated out of sub-character creation when the parent has a `teamName` (teammate path handles it). With no `teamName`, the gate must be bypassed so the basic Subtask sub-character still renders. `addSubagent` dedups via `subagentIdMap`, so the bypass is safe even if a teammate is detected later. `subagentToolStart` creates the sub lazily when it's missing — covering teamed leads' unnamed background spawns and post-reload recreation.
- **Allure HTML report**: viewing via `file://` fails (browsers block `fetch()` from local files). Use `npx allure open allure-report/allure` or `npm run test:report:open`.
- **Context usage is a snapshot against a provider-declared window**, and both halves are easy to get wrong: cumulative sums measure spend rather than occupancy, `input_tokens` without the cache counters measures almost nothing, and a 200k window assumed for a 1M model reads five times too full (the number to check it against is Claude Code's own statusline `context_window.used_percentage`).

## Manual Hook Testing

`server/manual-hook-events.http` (REST-Client format) drives the local hook server while the extension is running. Copy `port` and `token` from `~/.pixel-agents/server.json`, set `cwd` to a workspace folder opened in the Extension Development Host. Covers `SessionStart` → `PreToolUse` → `PermissionRequest`/`Notification`/`Stop` → `SessionEnd`.

If `cwd` is outside the current workspace, enable **Watch All Sessions** first.

## Asset Pipeline (legacy tileset import)

7-stage pipeline in `scripts/` for importing third-party tilesets (the bundled assets don't need this):

1. `0-import-tileset.ts` — Interactive CLI wrapper
2. `1-detect-assets.ts` — Flood-fill asset detection
3. `2-asset-editor.html` — Browser UI for position/bounds editing
4. `3-vision-inspect.ts` — Claude vision auto-metadata
5. `4-review-metadata.html` — Browser UI for metadata review
6. `5-export-assets.ts` — Export PNGs + `furniture-catalog.json`
7. `asset-manager.html` — Unified editor (stages 2+4 combined), Save/Save As via File System Access API

Supporting: `wall-tile-editor.html` (wall sprite editing), `jsonl-viewer.html` (transcript inspector).

## Key Decisions

- **Layered codebase** (core → server → adapters; core → webview-ui). Standalone CLI never imports `adapters/vscode/` and vice versa.
- **AsyncAPI 3.0 contract**, generated TS bindings, CI drift check. Single source of truth for the wire protocol.
- **AgentRuntime** shared lifecycle core, composed by both surfaces.
- **AgentStateStore** as single source of truth with typed mutations and typed events. No transport calls outside the broadcast layer.
- **Transport abstraction**: `MessageTransport` interface, `PostMessageTransport` + `WebSocketTransport`. One branching point in the entire UI.
- **HookProvider** as the integration boundary, with optional file fallback. New CLIs are a single subdirectory under `server/src/providers/hook/<id>/`.
- **TeamProvider** as optional extension. Claude Agent Teams is the only implementation.
- **Per-adapter namespaced persistence** under `~/.pixel-agents/`. VS Code and standalone never clobber each other.
- **Verify-before-clear migration** for legacy VS Code state.
- **Single `WebviewViewProvider`** (panel area, not editor area).
- **Inline esbuild problem matcher** (no extra extension needed).
- **`erasableSyntaxOnly`** in webview forbids `enum` — use `as const` objects.
- **Server always starts** regardless of hooks toggle. Only hook installation is gated by the setting.
- **Consent before any FIRST settings-file write**, per provider (`hooksConsent: {providerId: 'granted'|'declined'}`, absent = unanswered; the `hooksEnabled` preference beside it is per-provider and machine-global). **Exactly one population is asked: the one with nothing of ours installed** — hooks already on disk are granted silently at startup, since that install only ever removes events. The ask is one step of the Intro, the four-step first-run tour a greeter character speaks in-app on both surfaces (`IntroBubble.tsx`); the server sends `hooksConsentRequest` during the `webviewReady` handshake, one per provider, privileged connections only, carrying the provider's own `consentDisclosure()` so no client-side copy can drift. The ask-or-not predicate, the choice→action rule, and the execution live ONCE in `server/src/providers/hook/` (`consentGate.ts` decides, `consentExecutor.ts` performs); surfaces supply only their effects. **A choice is an absolute state command, not an event** — Back re-opens the ask, so a revision undoes whatever the earlier answer left: hooks on disk, a grant a failed install recorded, or a decline's own persisted hooks-off. That is why the consent record is a tri-state and each answer commits in ONE config write; the full rule and its rejected alternatives are `docs/adr/0001`. An abort (close x, Escape) sends nothing and the whole Intro returns next open; the closing step reports the install OUTCOME, not the click.
- **`hooksStatus` is install state, `hooksEnabled` is preference.** The Settings checkbox binds to `hooksInstalled` and toggles the _displayed_ state with no optimistic local update, so it can't read "on" over an untouched settings.json and lands correct rather than flickering when an install fails. Every failure path re-derives and broadcasts the truth (standalone via `clientMessageHandler`, VS Code via `reportHooksStatus`). The hook script is copied BEFORE the entries are written; a failed copy aborts the install (entries pointing at a missing script spawn a dead `node` per event). **Hooks-off is persisted only AFTER a successful uninstall** — flipping it first strands the user: the entries keep firing while the persisted preference makes the next start skip the gate entirely.
- **Never rewrite a shape we did not author.** The unparseable-file abort generalizes: a non-object `hooks`, a non-array `hooks.<Event>`, and junk entries inside an event array are all refused or passed through, never replaced. An array `hooks` was the sharp case — string keys assigned onto it vanish from `JSON.stringify`, so the write committed and reported `installed: true` over a file with no hooks in it. Emptied event keys are deleted only when _our_ removal emptied them. **Internal sentinels must not be values user JSON can hold**: `null` marked "this entry is now empty", so a user-authored `null` inside a hooks array was silently deleted (a file with no Pixel Agents command anywhere came back rewritten and logged as "Hooks removed") — it is a `Symbol` now.
- **Hook identity is anchored at both ends, not a substring.** `includes('claude-hook.js') && includes('.pixel-agents')` claimed — and `uninstallHooks` then DELETED — a `.backup` copy of our script, a shell comment naming our path, a wrapper passing it as an argument, `/opt/evil.pixel-agents/hooks/claude-hook.js`, and `my-pixel-agents-hook.js`. Ours = the `/.pixel-agents/hooks/claude-hook.js` suffix, ending the command's FIRST token, matched **case-insensitively** (the token is normalized to lower case). Case-sensitive matching is what shipped, and on the case-insensitive volumes this runs on (macOS, Windows) a differently-cased path is the SAME INODE as our script and genuinely firing: reinstall appended a duplicate and uninstall left the cased entry as an orphan our own `areHooksInstalled` could no longer see — a live hook with no removal route. The folding is unconditional (no filesystem case-sensitivity probe), so the accepted trade is a Linux-only false positive that is **not** a mere dedup: on a case-sensitive volume `~/.Pixel-Agents/hooks/claude-hook.js` is a genuinely DIFFERENT file, we classify it as ours, and uninstall **deletes** it (`claudeHookInstaller.test.ts` pins that removal). Nothing creates that path, and the trade is deliberate — the alternative is a guaranteed unremovable live hook on the two platforms this actually ships to. A symlink alias to our script is deliberately _not_ recognized — the cost is one duplicate entry, versus deleting a stranger's hook if we resolved paths.
- **E2E over webview unit tests** for OSS friction. Community PRs change webview internals constantly; unit tests would force contributors to update internals tests on top of feature work. E2E pins user-facing behavior, which is stable across internal refactors.

## Project Identity

- Extension ID: `pablodelucca.pixel-agents` (VS Code Marketplace + Open VSX)
- npm package: `pixel-agents` (CLI bin: `pixel-agents`)
- GitHub: `https://github.com/pixel-agents-hq/pixel-agents`
- License: MIT
