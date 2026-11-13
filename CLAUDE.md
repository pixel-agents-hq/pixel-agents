# Pixel Agents — Compressed Reference

Pixel art office where AI agents (Claude Code terminals today, any tool tomorrow) become animated characters. Ships as a **VS Code extension** and an **`npx pixel-agents` standalone CLI** from the same source tree.

`CONTEXT.md` is the canonical glossary — read it for what terms like Agent, Sub-agent, Teammate, Lead, Adopt, or Headless agent mean here, and use its vocabulary in code, comments, and docs.

## Architecture

Strict layering: `core/` depends on nothing; `server/` depends only on `core/`; `webview-ui/` depends only on `core/`; `adapters/vscode/` depends on `core/` and `server/`. The standalone CLI never imports `adapters/vscode/` and vice versa.

The tree below is one line per file. The full version, saying what each file owns and its rules, is `docs/design/file-map.md` — read a file's entry there before changing it, and update both when files are added or moved.

```
core/                                Protocol + interface definitions (zero runtime side effects)
  asyncapi.yaml                      AsyncAPI 3.0 contract — single source of truth
  src/
    messages.ts                      AUTO-GENERATED discriminated unions (do not edit)
    schemas.ts                       AgentMeta, SpriteData, FurnitureCatalogEntry
    provider.ts                      HookProvider, AgentEvent (the integration boundary)
    teamProvider.ts                  Optional TeamProvider (Lead + Teammates)
    transport.ts                     MessageTransport interface, TransportState
    adapter.ts                       StateAdapter, AssetCache, PersistedAgent, AgentSeat
    terminalAdapter.ts               TerminalAdapter (editor-driven terminal management)
    normalizeProjectPath.ts
    constants.ts
    agentLabel.ts                    agentLabelOf: Nickname, else character name, else Directory
    pcShells.ts                      PC shells, pure: isPcShellId, pcShellName, the saved list
    isRecord.ts, localId.ts          The JSON-object guard; newLocalId
    layout/                          The layout, pure, shared by editor and server (index.ts = barrel)
      types.ts, constants.ts         OfficeLayout, TileType, Direction, Seat; grid limits
      catalog.ts                     createFurnitureCatalog: entries, rotation/state/animation groups
      editOps.ts + editOps/          Every pure layout edit: tiles, furniture, areas, grid, pets
      sections.ts                    Touching tiles of one material (sectionAt, restyleSection)
      layoutSerializer.ts            Tile map, walkGrid, layoutToSeats, (de)serialize + migrate
      tileMap.ts                     Walkability, BFS
      workstations.ts                Seat ↔ workstation pairing
      visitSpot.ts                   A Visit's tile check and the spot beside furniture or a seat
    furniture/                       The furniture contract (docs/adr/0005), pure
      interactive.ts                 The manifest's `interactive` block + the ONE validator, withInteractive
      pieceRules.ts                  The ONE rule set: pieceState, pieceLabel, pieceClick, pieceView, opensPanel
      piecePlaces.ts                 The Directories of the Area a piece stands in
    tutorial/quests.ts               TUTORIAL_QUESTS, TUTORIAL_NICKNAME
    greeterCharacter.ts              The greeter's (and Guide's) character
    assets/characterSheet.ts         The ONE reading of the sheet layout (sheetToDirectionSprites)
    characters/                      The character model, pure, shared by webview and server
      art/                           Wardrobe PNGs (one per part), wardrobe.json, artColors.ts
      slots.ts                       The slot table: LAYERS, TABS, ACCESSORIES
      renderer.ts                    CharacterRenderer: profile → 128×96 sheet
      wardrobe.ts, sheet.ts          Art layout + manifest check; sheet geometry
      color.ts                       The renderer's colour maths
      repeatClothes.ts               A repeat's clothes colour
      profiles.ts                    Profile edits (newProfile, setPart, setColor, randomize)
      preview.ts                     previewPixels: standing frames side by side

server/                              Lifecycle runtime + Fastify HTTP/WS server
  src/
    providers/hook/claude/           Reference HookProvider — only place that knows Claude specifics
      claude.ts                      normalizeHookEvent, formatToolStatus, file fallback
      claudeTeamProvider.ts          TeamProvider over ~/.claude/teams/<name>/config.json
      claudeHookInstaller.ts         Consent-gated install/uninstall of our hook entries
      claudeHookEntries.ts           Our hook entries as data: makeHookEntry, hook identity
      claudeSettingsFile.ts          mutateClaudeSettings: the one guarded write of ~/.claude/settings.json
      bundledScripts.ts              Path of, and copy to, ~/.pixel-agents/hooks/<name>
      consentCopy.ts                 First-run consent disclosure text
      commandIdentity.ts             The ONE "does this command run our script?" parser
      statusLineBridge.ts            The usage bridge's statusLine command: make / recognize / unwrap
      statusLineInstaller.ts         Wrap/unwrap the user's statusLine
      claudeUsageBridge.ts           Claude's UsageBridge
      sessionEnv.ts                  The CLI session markers an agent must not inherit
      worktreeConvention.ts          Claude's WorktreeConvention: `.claude/worktrees`, session-dir naming, the process its lock names, symlinkDirectories
      worktreeSettings.ts            `worktree.symlinkDirectories`, read from the user's and the project's Claude settings
      skillPackaging.ts              A skill as Claude Code loads it: plugin manifest, SKILL.md, its slash command
      claudeSignIn.ts                Claude's sign-in: `claude auth status` / `auth login` driven for the office
      trustPrompt.ts                 Reading Claude's "trust this folder?" question off a screen
      constants.ts                   Hook event names, script path
      hooks/claude-hook.ts           Hook script (bundled to dist/hooks/claude-hook.js)
      hooks/claude-statusline.ts     Status line bridge script
      hooks/serverRegistry.ts        Both scripts' route to the live servers
    providers/hook/consentExecutor.ts  applyConsentChoice: consent execution for both surfaces
    providers/index.ts               Provider registry
    mcp/                             The Pixel Office MCP (docs/design/pixel-office-mcp.md)
    tutorial/                        The tutorial: owner, sightings, progress, copy, onboarding plugin, feature guide
    agentRuntime.ts                  Lifecycle core: timers, scanners, HookEventHandler, SessionRouter
    agentStateStore.ts               EventEmitter-backed single source of truth
    sessionRouter.ts                 session_id → agent_id mapping, event buffering
    dismissalTracker.ts              Unified dismissal state
    hookEventHandler.ts              Dispatches normalized AgentEvent into runtime
    httpServer.ts                    Fastify: hooks, health, /ws, SPA (standalone)
    clientMessageHandler.ts          Single dispatch point for ClientMessage
    server.ts                        Top-level composition
    cli.ts                           npx pixel-agents entry
    agentPersistence.ts              What of an agent survives a reload
    agentMoves.ts                    Following an agent that moves mid-session (AgentMoves.relocate)
    backgroundSpawns.ts              A lead's live background spawns and their rules
    subagentWatch.ts                 Shadow store watching unnamed background spawns
    fileStateAdapter.ts              Namespaced ~/.pixel-agents/ persistence
    configPersistence.ts             config.json
    layoutPersistence.ts             layout.json, atomic tmp+rename
    worktreeGit.ts                   The ONLY code that runs git
    worktreeRegistry.ts              worktrees.json: the only proof of ownership, per-repo queue, holder
    worktreeCreate.ts                create + fitOut (lock, .worktreeinclude copies, symlinks)
    worktreeInspect.ts               What a Worktree holds: uncommitted files, own commits, size
    worktreeRetire.ts                The leave rules: retire, retireWith, decide, deleteParkedBranch
    worktreeRestore.ts               A resume's restore of a kept or removed Worktree
    worktreeSweep.ts                 The startup sweep
    cliWorktrees.ts                  The CLI's own worktrees (Claude Code's): read, never retired; the list's Remove
    worktreeListing.ts               worktreesOf: the ONE listing of a Directory's Worktrees
    worktreeOptions.ts               The new-worktree modal's offer and a launch's choices
    worktreeOccupancy.ts             Who still runs in a Worktree (holdsWorktree)
    worktreeLeave.ts                 The office's side of a Worktree's end: handleCloseAgent, sweepWorktrees
    worktreeLaunch.ts                A launch into a new Worktree
    worktreeResume.ts                Worktrees in the conversations; resumeConversation
    worktreeAttribution.ts           Worktree attribution for scanners and moved agents
    worktreeLocation.ts              The ONE owner of the worktree path shape, as the provider's `worktrees` convention gives it
    directories.ts                   Directories: host+user union, save/remove, directoryAt
    terminal/                        Standalone terminals (docs/design/standalone-terminal.md)
      ptySessionManager.ts           In-process sessions (default); ptyHost.ts etc. = the dev PTY host
      standaloneLaunches.ts          The office's launches as operations
      launchAsks.ts                  LaunchAsks + checkLaunchAsks
      terminalScreen.ts              readScreen: a session's visible rows + token
      agentTerminals.ts              AgentTerminals (has / screen / write), typeInto
      terminalEnv.ts                 terminalEnv, inheritedEnv
      pcShells.ts                    StandalonePcShells: the registry over standalone's backend
      fileUploads.ts                 Files sent to a terminal: upload directory, sweep, naming
      localFile.ts                   Finding a sent file already on this machine
      trustPrompt.ts                 --trust-directories: answering the CLI's trust question for launched agents
    usageLimits.ts                   Usage bars: last report per provider, PRIVILEGED_BROADCAST_TYPES
    cardOrder.ts                     The agent cards' order
    cliSignIn.ts                     CliSignIns: the Intro's sign-in messages, one sign-in per provider, both surfaces
    conversations.ts                 The sidebar's recent conversations
    officeFacts.ts                   OfficePlaceFacts, built once per surface
    pcShells.ts                      PcShellRegistry: the ONE owner of live PC shells; handlePcShellMessage
    pcShellPlace.ts                  Where a PC shell opens
    visits.ts                        Visits: start/end, snapshot, ending on the next turn
    agentMessages.ts                 agentCreatedMessage
    recentCharacters.ts              The roster's recency
    characterRemap.ts                Renumbering after a save that inserts or deletes characters
    characterProfilesPersistence.ts  The ONE owner of characters.json + wardrobe-items.json
    characterProfilesStore.ts        The cached cast
    characterArt.ts                  The server draws characters (pngjs)
    paletteAssigner.ts               assignPaletteIfNeeded
    contextUsage.ts                  The context gauge
    jsonFileWatcher.ts               Generic watcher + writeJsonAtomic
    fileWatcher.ts                   Hybrid fs.watch + polling, JSONL line buffering, /clear detection
    transcriptParser.ts              JSONL parsing for heuristic / file-fallback mode
    timerManager.ts                  Waiting / permission timers
    assetLoader.ts                   PNG → SpriteData via pngjs
    teamUtils.ts                     Inline-teammate helpers
    wsAuth.ts                        standaloneHandshakeVerdict, token redaction
    types.ts                         ServerAgentState
    constants.ts                     All timing/scanning constants
  __tests__/                         Vitest suites
  manual-hook-events.http            Manual hook testing helper

adapters/vscode/                     VS Code surface — composes core + server
  extension.ts                       activate() / deactivate()
  PixelAgentsViewProvider.ts         WebviewViewProvider, thin bridge to AgentRuntime
  vscodeWorktrees.ts                 The window's side of Worktrees
  agentManager.ts                    Terminal lifecycle, restore, persist
  vscodeTerminalAdapter.ts           TerminalAdapter implementation
  vscodePcShells.ts                  PC shells as integrated terminals
  vscodeOfficeMcp.ts                 The Pixel Office MCP as VS Code composes it
  uninstall.ts                       vscode:uninstall hook
  migrateVsCodeState.ts              One-time legacy state migration (verify-before-clear)
  constants.ts                       VS Code IDs, command names, key names

webview-ui/                          React 19 + Canvas UI (depends only on core/)
  src/
    transport/                       createTransport() (the one runtime branch), postMessage + WebSocket, onReconnect
    runtime.ts                       isBrowserRuntime detection
    browserMock.ts                   Standalone-browser asset fetch + message injection
    testHooks.ts                     window globals exposed for e2e
    main.tsx, App.tsx                React entry; composition root
    constants.ts                     Webview magic numbers/strings
    notificationSound.ts             Web Audio API chime
    changelogData.ts                 Changelog modal content
    components/                      React UI (toolbars, modals, settings)
      IntroDialog.tsx, IntroChoices.tsx, IntroSignIn.tsx  The Intro (the greeter's dialog box), its choices step and its sign-in step
      IntroOptions.tsx, introOptionsSlot.ts  The Intro's menu pieces: the options (stacked, or inline in the dialog box), a panel
      introDialogRules.ts, introSpeech.ts  The dialog's messages and camera target (pure); a menu's lines for the greeter (`useSay`)
      LoadingScene.tsx + loadingScene*.ts  The loading screen (dev preview: /loading.html)
      ui/                            Button, pixelIcons (8×8), pixelGrid, PixelSvg, PixelIcon, PixelText, pixelFont
      AgentCard.tsx, PcShellCard.tsx One card per agent / PC shell
      AgentCardList.tsx              The card bar's cards for BOTH shells
      cardBar.ts                     Pure card-bar rules (order, variant, close mode)
      useCardReorder.ts              Drag-to-reorder
      drawerRowButtons.ts            The launch drawer's row buttons (pure)
      TerminalDrawer.tsx             Desktop standalone terminal panel
      TerminalPaneStack.tsx, TerminalPane.tsx  The agents' xterm panes
      MobileAgentBar.tsx             Mobile bottom bar
      CharacterPicker.tsx            Roster carousel
      MobileTerminalPage.tsx, MobileKeyBar.tsx  Phone terminal page + accessory keys
    officeMcp/                       The MCP in the office: agent edit status + undo bars, consent store
    pcShells/                        PC shells in the office: store, panels, Directory selector, close dialog
    tutorial/                        The tutorial in the office: store, ask, checklist panel
    usage/                           UsageBars, PixelHeart, usageBarView (pure), usageStore
    signIn/                          The CLI sign-in in the office: signInStore, useCliSignIn
    conversations/                   ConversationList, sidebar, phone panel, search
    music/                           The office radio: composer (pure, seeded), moods, song codes, musicEngine, player UI
    mobile/                          The phone shell: MobileShell, MobileMenu, useMobileShell, edgeSwipe, keyboardViewport
    touch/                           touchPrimitives (findTouch, withinTapSlop), trackpad
    terminal/                        Standalone xterm support
      terminalClient.ts              /terminal/:agentId socket (reconnect, replay)
      terminalLinks.ts, linkProvider.ts, hardWrap.ts  URL lookup, links, tokens broken across rows
      touchGesture.ts, touchInput.ts Terminal touch state machine + DOM adapter
      selectionMath.ts, selectionOverlay.ts  Selection, Copy / Paste pills, handles
      inputArea.ts                   The TUI's input area
      fileSending.ts, fileUpload.ts  Files to the terminal
      clipboard.ts, clipboardKeys.ts, flowCopy.ts  Clipboard write/read, chords, copy text
      terminalDom.ts                 xterm screen geometry
    hooks/
      useExtensionMessages.ts        ServerMessage → OfficeState mutations
      useEditorActions.ts, useFurnitureColorActions.ts, useEditorKeyboard.ts  Layout editor state + input
      introTourState.ts, useIntroTour.ts  Intro tour reducer + wiring
      useTerminalDrawer.ts, terminalPanes.ts  Terminal-pane model for both shells
      launchLatch.ts, useLaunchActions.ts, useRosterLaunch.ts  Launching and its latch
      drawerWidth.ts, useSlidePanel.ts, slideTransitions.ts  Drawer width and side-panel motion
      useFrameTick.ts, useLongPress.ts, useDismiss.ts, useHoverPin.ts  Small UI hooks
      useIsMobile.ts, useKeyboardViewport.ts  Mobile breakpoint (never in VS Code), keyboard viewport
    characters/                      The cast (docs/design/characters.md)
      loadWardrobe.ts                The browser's wardrobe loader
      cast.ts, castStore.ts, castMessages.ts  CastStore (draft, save, sync) and its wiring
      items.ts, history.ts           Custom items; undo/redo
      officeSprites.ts               Cast → office sprites
      profiles.ts                    Labels, export names, parseConfigFile
      ui/                            CharactersView and its panes
    office/
      types.ts                       OfficeLayout, Character, etc.
      toolUtils.ts                   STATUS_TO_TOOL, extractToolName
      projection.ts                  World→screen math for renderer + DOM overlays
      colorize.ts                    Colorize + Adjust
      floorTiles.ts, wallTiles.ts    Floor sprites; wall auto-tile
      contextGauge.ts, ContextBar.tsx  The context gauge
      sprites/                       spriteData.ts (pixel data), spriteCache.ts
      editor/                        editorActions, editorState, tileSections, editorRenderState, EditorToolbar
      layout/                        furnitureCatalog, layoutSerializer, tileMap, workstations (bound to the webview's catalogue)
      engine/
        officeState.ts               Game world
        characters.ts                Character FSM + wander AI, updateVisit
        visitsController.ts, agentVisit.ts  Errand stacks; agentVisit / agentMessageShow
        piecesController.ts          Interactive furniture in the office (os.pieces)
        buildout.ts, buildoutPlayer.ts  The Buildout: plan (pure) + player
        greeterHandoff.ts            The greeter's walk to the Guide's seat
        blink.ts                     Blink clocks
        gameLoop.ts, renderer.ts     rAF loop; canvas rendering
        selectionButtons.ts          The selected item's rotate/delete buttons
        matrixEffect.ts, matrixEffectState.ts  Spawn/despawn rain
      components/
        OfficeCanvas.tsx             Canvas, resize, DPR, hit-testing, drag-to-move
        useCanvasTouchGestures.ts    Touch pan / pinch / tap
        ToolOverlay.tsx              Activity label + speech bubbles
        FurnitureLabel.tsx           The Furniture labels (the piece's line; a clicked piece also takes the camera: `cameraPieceUid`)

e2e/                                 Playwright suite (real VS Code + mock-claude scenarios)
  fixtures/                          VS Code + standalone fixtures, mock-claude and its scenario runner
  helpers/                           Launch, scenario builder, office locators, hooks, teams
  tests/claude/                      hooks-on/, hooks-off/ (VS Code)
  tests/standalone/                  Standalone specs (headless browser)
  README.md                          Auto-generated test inventory

scripts/
  generate-messages.ts               AsyncAPI → core/src/messages.ts
  run-e2e.mjs                        Playwright wrapper
  generate-e2e-inventory.mjs         Splices the test list into e2e/README.md
  build-allure-report.mjs, assemble-vercel-output.mjs  Allure report
  asset-manager.html, wall-tile-editor.html, jsonl-viewer.html  Browser tools
  generate-wall-sets.mjs             Generates wall_1…wall_8.png
```

## Keeping the docs in step

`CLAUDE.md` holds summaries; the detail lives in `docs/design/`. **When a change alters how one of these areas works, update its doc in the same change**, and the summary here when the change touches something the summary states. A doc that disagrees with the code is a bug.

| Area                                     | Doc                                            |
| ---------------------------------------- | ---------------------------------------------- |
| Any file added / moved / given a new job | `docs/design/file-map.md` (and the tree above) |
| Pixel Office MCP                         | `docs/design/pixel-office-mcp.md`              |
| Characters                               | `docs/design/characters.md`                    |
| PC shells                                | `docs/design/pc-shells.md`                     |
| Office UI                                | `docs/design/office-ui.md`                     |
| Standalone terminal                      | `docs/design/standalone-terminal.md`           |

New detail goes in the doc, not here: add to `CLAUDE.md` only what a newcomer must know before opening the doc.

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

- **66 ServerMessage variants** (server → client): agent lifecycle, agent activity, sub-agent activity, team + context usage, visits (`agentVisit` — `{ id, to, facing, stay }` or `{ id, cleared: true }`, every office and the connect snapshot; `agentMessageShow` — `{ fromId, toIds, gist }`, the offices open at the time only, no snapshot replay), character profiles (`characterProfilesLoaded`, `recentCharactersLoaded` — the roster's most-recently-launched order, server-kept and machine-wide so every office lists the roster alike), assets, access (`officeAccess` — sent first on `webviewReady`; `readOnly` hides every control a read-only office would only have refused), settings (`bypassPermissionsUpdated` — the skip-permissions posture, broadcast to every office on change because every launch reads it) + directories (`directoriesLoaded`, `directorySaved` — a save's ack to its sender, carrying the entry as stored, whose name keys the Area mapping; `directoryRejected`, `directorySuggestions`), worktrees (`worktreeRejected` — a Worktree launch or resume that could not be done, `worktreeDecisionRejected` — a `decideWorktree` that could not be, each to its sender alone; `agentCloseQuestion` — a `closeAgent` on an agent that would leave a Worktree of ours with uncommitted files, answered to its sender INSTEAD of closing (the agent keeps running until a `closeAgent` carrying `worktreeChoice` comes back); `agentCreated.worktree` and `existingAgents.worktrees` (by id) carry an agent's `{ name, branch }`, `agentWorktreeChanged` its new one (or none) when it moves itself into or out of a worktree mid-session; `worktreeOptions` — the new-worktree modal's name, prefix and branches, to its asker alone; `worktreesLoaded` — one Directory's Worktrees with state, size, uncommitted files and commits of their own, and `cliName` (the provider's display name for the CLI whose own worktrees, `owner: cli`, are listed: their badge reads `<cliName>'s`, `CLI's` without it), privileged sockets only: on request, on connect, after every change), terminal, card order (`cardOrderLoaded` — sent on `webviewReady` before `existingAgents`, broadcast after every save), CLI sign-in (`cliSignInStatus` — `{ signedIn, cliMissing?, signInUrl?, openedOnHost?, error? }`, to its asker alone: the answer to the three sign-in messages, and a sign-in's end to the office that started it), usage bars (`usageBridgeStatus`, `usageLimits` — privileged sockets only), Pixel Office MCP (`officeMcpConsentRequest` — the Intro's fifth step, after the hooks asks, privileged only; `officeMcpStatus` — consent + read-only, privileged only; `agentLayoutEditStatus` — the agent whose layout edit the editor's undo button would revert, or none; with `refused` to the office whose press was refused; `agentCharacterEditStatus` — the same for the Characters view's undo, plus `summary` (what the edit did) and `landed` on the broadcast as an edit lands, which the view's status line names), conversations (`conversationsLoaded` — each Directory's `more` says older ones exist; `conversationSearchResults` — to its asker, echoing the request), tutorial (`tutorialStatus` — whether the Intro may offer it, its copy and the run under way, privileged connections of an office that offers the Pixel Office MCP; `tutorialRejected` — a `startTutorial` that started nothing, to its sender alone), PC shells (`pcShellsLoaded` — every live PC shell `{ id, uid, furnitureType, directoryName? }`, the whole list, privileged sockets only (a view-only office sees agents, never shells), on each change and in the connect snapshot; `panelsInUse` — `{ uids }`, the pieces whose panel is in use and nothing else, to EVERY office beside it: a view-only office lights those PCs and labels them "Busy"; `pcShellReady` — the shell that answers an `openPcShell`, to its sender; `pcShellCloseQuestion` — a `closePcShell` on a shell with a command still running, answered to its sender INSTEAD of closing (`command` when `ps` could tell); `pcShellRejected` — an open that could not be done, to its sender), diagnostics.
- **52 ClientMessage variants** (client → server): lifecycle (`webviewReady`, `launchAgent` — `worktree: true` launches into a new Worktree (`worktreeName`, `worktreeFrom` from the new-worktree modal), `focusAgent`, `closeAgent` — `worktreeChoice` (+ `confirmedFiles` for a discard) answers an `agentCloseQuestion`), layout (`saveAgentSeats`, `saveLayout`, `exportLayout`, `importLayout`), characters (`saveCharacterProfiles` — profiles plus, optionally, the custom wardrobe items, `exportFile` — VS Code save dialog for generated files), card order (`saveCardOrder`), Pixel Office MCP (`officeMcpConsentResponse` — `allow` | `decline`, an absolute state; `setOfficeMcpEnabled`, `setOfficeMcpReadOnly` — Settings, both effective at once for running agents; `layoutEditing {dirty}` — the editor holds unsaved changes, agents' layout edits wait; `undoAgentLayoutEdit` — the editor's "Undo <agent>'s edit"; `charactersEditing {dirty}` — the Characters view holds an unsaved draft, agents' Character edits and their undo wait; `undoAgentCharacterEdit` — the Characters view's "Undo <agent>'s edit"), CLI sign-in (`requestCliSignInStatus`, `startCliSignIn { onHost, account? }` — runs the provider's login, replacing one under way; `onHost` lets the CLI open a browser on the host, `submitCliSignInCode { code }` — the code its page ended on, taken only from the office that started it), settings (`setSoundEnabled`, `setHooksEnabled`, `setUsageBridgeEnabled`, `setWatchAllSessions`, `setAlwaysShowLabels`, `setLastSeenVersion`, `setBypassPermissions`, `setShowHostDirectories` — whether the host's own Directories are listed, off by default; only the list is gated, launches still name agents after them, `setUploadDirectory` — where files sent to a terminal are saved, answered with `settingsLoaded.uploadDirectory`), directories (`saveDirectory`, `removeDirectory`, `requestDirectorySuggestions`), conversations (`requestConversations` — optional per-Directory `limits` for "Show 5 more", `searchConversations` — title search, `limit` paged, optionally one Directory, `resumeConversation`), tutorial (`startTutorial` — the greeter sat down: launch the Guide; `skipTutorialQuest`, `quitTutorial`), PC shells (`openPcShell { uid, directory? }` — a piece's live shell, else a new login shell in the named Directory (the office's Directory selector; refused unless it is one of the Area's), else the single Directory of its Area, else home; `closePcShell { id, confirmed? }` — idle closes at once, a running command asks first; both privileged and refused where the office runs no terminal), worktrees (`requestWorktreeOptions` — the row's worktree button opens `NewWorktreeModal` (name + branch to start from) and asks this first, `requestWorktrees`, `decideWorktree` — `save` | `keep` | `discard` (a discard carrying the file count the user confirmed) from the decision dialog, `remove` | `deleteBranch` (with `confirmedCommits`) from the Worktrees list), terminal, discovery + assets, diagnostics.

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

`HookProvider` (`core/src/provider.ts`) is the integration boundary. Today only Claude Code is implemented; the Claude provider supports every transcript/hook format up to **Claude Code v2.1.310** (current as of 2026-10-26 — Task-era `agent_progress` records, explicit and implicit teams, background-by-default Agent spawns, sidecar-backed background agents, interim background-agent notices, mid-session worktree moves: `relocated` / `worktree-state` records, an interactive session's transcript moved into the new folder's project dir). Newer CLI releases may add formats that need provider updates. The interface:

- **Optional sign-in**: `cliSignIn` (`status()`, `begin({ openBrowser, account })` → the page, `submitCode`, `done`): the Intro's sign-in step; `trustPromptKeys(screen)`: the keys that accept the CLI's trust question, read only under `--trust-directories`.
- **Required**: `normalizeHookEvent(raw)` → `{ sessionId, event: AgentEvent, where?: { cwd, transcriptPath } } | null` (`where` on every event: how a session that moved is noticed); `installHooks` / `uninstallHooks` / `areHooksInstalled`; `formatToolStatus`; `permissionExemptTools`, `subagentToolNames`, `readingTools` sets.
- **Optional file fallback**: `getSessionDirs(workspace)`, `getAllSessionRoots()`, `sessionFilePattern`, `parseTranscriptLine(line)`, `sessionMoveFromRecord(record)` (a transcript record saying the session moved: Claude's `relocated` / `worktree-state`), `buildLaunchCommand(sessionId, cwd, opts)`. Used when hooks aren't installed.
- **Optional MCP config**: `mcpConfigFile({ name, url, token })` — how an MCP server is handed to a launched session: the contents of the file a launch's `mcpConfig` names, in the CLI's own format (Claude: the `--mcp-config` JSON). Without it, the CLI's agents are offered no Pixel Office MCP.
- **Optional terminal input modes**: `terminalInputModes` — the input modes (bracketed paste, application cursor keys) the CLI's terminal UI is assumed to be in when its screen cannot be read (VS Code types a Message blind, `turnGuard`); absent = plain modes (`PLAIN_INPUT_MODES`).
- **Optional worktrees**: `worktrees?: WorktreeConvention` — the CLI's worktrees folder (path segments), `sessionDirName(folder)` / `worktreeOfSessionDir(dirName, repoDirName)` (how it files a worktree's sessions), optional `lockHolder(lockReason)` (the process a lock of its own names) and `symlinkDirectories(repoPath)` (folders its settings link rather than copy). One member, so one provider supplies all of it; `server/src/worktreeLocation.ts` `worktreesCli` picks it. Without any, our Worktrees live in `.pixel-agents/worktrees` and the CLI has no worktrees of its own.
- **Optional tutorial facts**: `skills` (a `SkillPackaging`: how the CLI loads a skill for one session, how it names and invokes it; absent = the Guide reads its brief from the `tutorial` tool), `autoPermissionMode` (safe actions without a prompt, risky ones still asked; Claude: `auto`; absent = the CLI's default mode — the Guide never launches with prompts skipped) and `mostCapableModel` (Claude: `opus`; absent = the user's default model): what the tutorial's Guide is launched with.
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

**Background spawns without a CLI team (sidecar-backed)**: `Agent(...)` spawns that never register a team take the async path — result "Async agent launched successfully. agentId: \<hex>" (no team anywhere), transcript + sidecar under `<projectDir>/<leadSessionId>/subagents/` (sidecar carries `agentType`/`description`/`toolUseId`, plus `name` when the spawn was named), completion via `queue-operation`, matched by `<tool-use-id>` OR by `<task-id>` (the launch result's `agentId`, kept beside the tool id in the lead's `backgroundSpawns`, `server/src/backgroundSpawns.ts`): a post-crash notice lists only task ids (`status: stopped`), and an agent revived with SendMessage completes under the SendMessage call's tool id. An **interim notice** ends nothing: a background agent that stops to wait on background work of its own (a background Bash, a Monitor) gets a completion-shaped notice each time it pauses — same `status: completed`, the tool id on the first one and only the task id after — that only its summary ("… is waiting on its own background work") and note ("may be interim") tell apart from the final one; the provider reads every notice, interim or not (`TeamProvider.readSpawnNotices`; the shared code never sees the notice format), and both the live path (transcriptParser) and the restart check (`stillRunningSpawns`) leave the spawn live until a notice that isn't interim. A SendMessage result carrying `resumedAgentId` (a stopped agent revived, e.g. by a lead resumed after a crash) makes that call a live background spawn of its own: the provider's `extractBackgroundAgentFromToolResult` recognizes both kinds of result (launch and revival), and the runtime handles them as one, ignoring a result whose task id is already live. The scan ties the sidecar to the SendMessage spawn by the task id the provider reads off its transcript name (`agent-<taskId>.jsonl` → `discoverTeammates` entry `taskId`, `liveSpawnToolIdOf`), because the sidecar's `toolUseId` still names the original spawn the new process never saw. `scanForBackgroundAgentFiles` classifies them by the sidecar `name` (`classifySpawn`) — the domain model's sole Sub-agent vs Teammate distinction (see CONTEXT.md):

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

EventEmitter-backed container in `server/src/agentStateStore.ts`. Typed mutations, typed events (`agentAdded`, `agentRemoved`, `agentUpdated`, `broadcast`, `agentStatus`). **An agent's turn status is a store fact**: `setAgentStatus(id, { active } | { active: false, awaitingInput })` is the ONE way it changes — it sets `AgentState.turnStatus` ('active' | 'done' | 'waiting for input'), broadcasts `agentStatus`, and emits the `agentStatus` event (every report, repeats included); the hook handler, the transcript parser and the timers all call it, and nothing re-parses broadcasts to learn it. The broadcast layer subscribes once at boot and translates `StoreEvents` into `ServerMessage` over the active transport. **No module under `server/` calls a transport method directly.**

### SessionRouter and DismissalTracker

Two extracted classes that replaced ad-hoc module state. `SessionRouter` owns `session_id → agent_id` mapping, pre-registration event buffering, and pending external sessions. `DismissalTracker` unifies four legacy globals (`dismissedJsonlFiles`, `clearDismissedFiles`, `seededMtimes`, `pendingClearFiles`) into one class with typed reasons.

### HTTP + WebSocket Server

Fastify v5 with `@fastify/cors`, `@fastify/websocket`, and (in standalone) `@fastify/static`:

| Method | Path                           | Purpose                                                                                                                                                  |
| ------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/hooks/:providerId`       | Bearer-authenticated hook event ingress                                                                                                                  |
| POST   | `/api/usage/:providerId`       | Bearer-authenticated usage report (status line bridge)                                                                                                   |
| POST   | `/api/terminal/:agentId/files` | A file sent to an agent's terminal or a PC shell's (standalone, `?token=` + allowed Host like the terminal socket): saved on the host, its path answered |
| GET    | `/api/health`                  | Liveness: `{ ok, version, port, pid }`                                                                                                                   |
| GET    | `/ws`                          | Bidirectional protocol channel                                                                                                                           |
| GET    | `/*` (standalone only)         | Webview SPA via `@fastify/static`                                                                                                                        |

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
  config.json              { vscode, standalone, externalAssetDirectories, hooksConsent, hooksEnabled (both per-provider), directories, recentCharacters, officeMcpConsent (granted|declined, absent = unanswered), officeMcpReadOnly }
  vscode-state.json        { agents, seats, cardOrder }
  standalone-state.json    { agents, seats, cardOrder, pcShells }  (`pcShells`: the live PC shells `{ id, uid, furnitureType, directoryName?, cwd }`, reattached under their ids after a restart where the PTY host kept their terminals, dropped at restore where none did; an agent in a Worktree keeps `worktree: { name, path, branch }`, one launched with a Nickname `nickname`; an older save's `homeWorktree` is ignored — the registry's `sessionIds` say which Worktrees a session holds)
  layout.json              OfficeLayout (shared across surfaces)
  characters.json          CharacterProfile[] (shared across surfaces; absent = the six defaults)
  wardrobe-items.json      WardrobeItem[]: custom items saved from the pixel editor (absent = none)
  server.json              { port, pid, authToken }
  usage-limits.json        { [providerId]: { fiveHour?, sevenDay?, updatedAt } } — last plan-usage report (usage bars)
  worktrees.json           WorktreeEntry[]: { directoryPath, name, path, branch, base: { mode, ref?, commit }, createdAt, lastUsedAt (last touched), activatedAt? (last made active by create/restore: the sweep's "its agent is on its way" marker), state: active|kept|parked|needsDecision, sessionIds (every session created/resumed in it, moved out of it, or carried over a /clear: who holds it), holder?: { pid, host } } — the Worktrees we created; `holder` = the Pixel Agents process with an agent in an `active` one (set on create/restore, claimed by `holdWorktreesOf` when an agent whose terminal this process owns joins its store — a standalone PTY or a VS Code terminal in this window, never an adopted/external agent, Teammate or Sub-agent, since every server hears every session's hooks and an adopter's claim would block the owner's retire on leave — dropped when it leaves `active`): every retire and the sweep skip an entry a live other process on this host holds, and one held on another host (`heldElsewhere`), since each process sees only its own agents
  mcp/<pid>-<rand>/agent-<id>.json  A running agent's `--mcp-config` (0600: the `/mcp` URL + its own token); the folder goes with its server
  uploads/                 Files sent to terminals while no other folder is set (swept: 7 days, 2 GB)
  hooks/claude-hook.js     Bundled hook script (CJS, shebang)
  hooks/claude-statusline.js  Status line bridge script (only while Usage Bars is on)
```

`FileStateAdapter({ namespace })` backs both runtimes. Per-namespace settings: `soundEnabled`, `lastSeenVersion`, `alwaysShowLabels`, `watchAllSessions` (the hooks preference is per-provider and machine-global, at the config top level). Running both surfaces in parallel never clobbers either.

`migrateVsCodeState` (VS Code adapter only) walks each known legacy key once with **verify-before-clear** semantics: write to file, read back, only then clear the legacy key. While anything remains unmigrated, activation shows a non-blocking warning.

Layout and character-profile writes go through ONE `writeJsonAtomic` (tmp + rename) beside ONE generic watcher (`jsonFileWatcher.ts`: hybrid `fs.watch` + 2 s polling) used for both `layout.json` and `characters.json`; the write marks every live watcher of that path, after it succeeded (a failed write throws and marks nothing), so no watcher re-reads our own write and no caller has to remember to say so — except a `/ws` client's `saveLayout`, written with `reportToWatchers` so the VS Code panel's layout watcher still hears of it. An external `characters.json` change that validates updates the cached list and is broadcast as `characterProfilesLoaded` without a `saveId`; one that doesn't validate is ignored.

## Agent Status Tracking

JSONL transcripts at `~/.claude/projects/<project-hash>/<session-id>.jsonl`. Project hash = the workspace path with every character that isn't a letter, digit or `-` replaced by `-` (`core/src/normalizeProjectPath.ts`, Claude Code's own rule), so a Worktree at `<repo>/.claude/worktrees/x` hashes to `<repo hash>--claude-worktrees-x`.

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

Standalone (tokened, terminal available) lists them in both shells — desktop: a left sidebar, open until the button above the zoom buttons shuts it (remembered per browser), with Settings pinned at its foot (the toolbar never has a Settings button where the sidebar exists, shown or shut); phone: the menu (`mobile/MobileMenu.tsx`, the top-left menu button, or a swipe from the office's left edge that pulls it in with the finger as the right edge pulls the terminal — `useEdgeSwipe` drives one `SwipePanel` per edge), a panel sliding in from the left over the office with Settings at its foot (mounted at App's top level; a resume closes it and slides to the terminal once it opens (`lastLaunched`), like a + launch). Both show one `ConversationList`: on top "Recent", the newest `RECENT_CONVERSATIONS_COUNT` (5) across every Directory with the Directory's name under each title (`recentAcross`, derived client-side: the newest overall are always among each Directory's newest), then one collapsible section per Directory (collapsed until opened, one open at a time — opening one shuts the other; the open one remembered per browser in localStorage). The list: for each Directory of the launch drawer, every conversation an agent in the office is running (`agentId` set, its current look, "New conversation" until titled; the row shows its agent card's status dot instead of the time, and a press goes to the agent as its card would: App's `openAgentFromSidebar`, the phone's `useMobileShell.openAgent`) plus its past ones, `CONVERSATIONS_PER_DIRECTORY` (5) in all, running ones included (a "Show 5 more" under them while older ones exist — `requestConversations.limits`, forgotten when a section opens or shuts and on reload), newest first, titled the way Claude Code titles them (`HookProvider.conversationTitle`: Claude's `custom-title` (a /rename) over the newest `ai-title`, else `last-prompt`; read from the transcript's tail, then its head unless the tail holds a rename; a title is cached per transcript while its size and mtime hold; untitled sessions are left out). Transcripts are looked for under the Directory's path AND its symlink-resolved path (the CLI files sessions under the resolved one). Each row shows a 1x mug shot of the character its agent wore (`CharacterMugShot` redraws whenever the character sprites are replaced — `subscribeCharacterTemplates` — so a row drawn before the cast arrived or before an edit catches up) — remembered per session in `conversations.json` whenever the office saves its seats (the seat is only known there), so it outlives the agent. Pressing a row sends `resumeConversation`: `claude --resume <id>` (`buildLaunchCommand` `resume`) in that Directory, the same session id and transcript (read from its end), wearing the remembered character as a pick (repeat recomputed) and asking for its old seat (`agentCreated.seatId`, taken when free). The id must be a UUID (it becomes a CLI argument) and the transcript must exist; a session already in the office is ignored. The list is pulled (`requestConversations` → `conversationsLoaded` to that client only) on open, after agents come or go, after an agent's turn starts or ends (`agentStatus`: its transcript now exists, or its title was written — the desktop sidebar never re-opens to ask), and every 30 s while open.

## PC shells

**Full reference: `docs/design/pc-shells.md` — read it before touching `server/src/pcShells.ts`, `pcShellPlace.ts`, `terminal/pcShells.ts`, `adapters/vscode/vscodePcShells.ts` or `webview-ui/src/pcShells/`.**

A PC opens a plain terminal on the host for the user (glossary: **PC shell**). It is built on the furniture contract (Asset System → **Interactive furniture**, `docs/adr/0005`): nothing names the PC, any furniture declaring the `terminal` panel does the same.

- **One registry** for both surfaces, `server/src/pcShells.ts` `PcShellRegistry`, over a small backend each (standalone: the user's login shell on the agents' terminal sessions; VS Code: a transient integrated terminal), with ONE message handler, `handlePcShellMessage`.
- **A shell is NOT an agent**: never in the store, so no provider, session, transcript, hooks, look, seat or gauge. It has its own id space (`isPcShellId`, read only at the wire and socket boundaries); the agents' terminal seam refuses shell ids. Agents reach shells only through the MCP's own shell tools (standalone only).
- **Messages** (all privileged): `openPcShell { uid, directory? }` → `pcShellReady` or `pcShellRejected`; `closePcShell { id, confirmed? }` → closed, or `pcShellCloseQuestion` while a command runs (standalone; VS Code and Windows close at once). `pcShellsLoaded` is the whole list, to privileged offices only; a view-only office is told only `panelsInUse { uids }` (the PC lit, labelled "Busy").
- **Folder** (`pcShellPlace.ts`): the named Directory (must be one of the piece's Area's), else the Area's single Directory, else the surface's default.
- **A click** resolves through core's `pieceView`: the piece's live shell › the agent working at it › the Directory selector › a new shell. "Panel in use" is computed from the announced list, never stored in the layout.
- **Lifetime**: a shell outlives its piece and its Directory (it stays as a card). Standalone saves live shells and reattaches them only under `--pty-host`; VS Code's end with the window. Deleting a PC in the layout editor closes its shell first; any other way a piece leaves the layout leaves the shell running.

## Sign-in

A Claude Code with no login used to leave a new user with a mute Guide over a login screen in its terminal. Now the Intro asks the server (`requestCliSignInStatus` → `cliSignInStatus`, Claude: `claude auth status`) as it opens, and **the choices step cannot be reached while the CLI is installed and reports no login**: the tour gets a "Sign in to Claude Code" step (`IntroSignIn.tsx`) before it. A missing CLI is not a signed-out one (`cliMissing`): the install step covers it and asks again on Continue.

- **One button.** `startCliSignIn` runs the provider's own login as a plain child process (`claudeSignIn.ts`: `claude auth login`, which needs no terminal) and answers with the page to sign in on. The login belongs to the office that started it (`server/src/cliSignIn.ts` `CliSignIns`, one per provider, replaced by a newer start, ended after `CLI_SIGN_IN_TIMEOUT_MS`).
- **Office on the host** (VS Code, or a browser on a loopback name — `useCliSignIn`'s `onHost`, a choice of flow, never of access): the CLI opens the browser itself at an address that returns to a port it listens on, so pressing Authorize finishes it with no code.
- **Office elsewhere** (a cloud office, a phone): the host opens nothing (`BROWSER` is pointed at a no-op), the office opens the page in a new tab on the click, and the user pastes the code the page ends on (`submitCliSignInCode` → the CLI's stdin). Anthropic's page cannot return to the office, so the paste cannot be avoided there. The paste field (a bar the dialog's width) is shown on the host flow too, as the way out when no browser opened (VS Code Remote).
- **Signed in is the CLI's word**: after a login ends, `status()` is asked again and only its answer counts. The code is never stored; the CLI keeps its own login.
- **The CLI's own first-run screens are not ours.** A login does not clear them: a first-ever launch still shows the theme picker and security notes until the CLI sets `hasCompletedOnboarding` in `~/.claude.json`, then "do you trust this folder?" per folder. The office writes neither. A cloud office's setup script seeds the first, and `pixel-agents --trust-directories` (off by default; `terminal/trustPrompt.ts`) answers the second for every agent the office launches: for a short while after a launch it reads the new session's screen, and when the provider recognizes the question (`trustPromptKeys`: both rows and the pointer on one of them) it presses them one key per read, confirming only once the pointer is on yes (the CLI drops keys for a moment after the question appears).
- **Tests**: `cliSignIn.test.ts`, `claudeSignIn.test.ts` (a stand-in CLI), `trustPrompt.test.ts`; e2e `standalone/sign-in.spec.ts` (the mock CLI speaks `auth status` / `auth login`, signed in unless `PIXEL_AGENTS_MOCK_SIGNED_OUT=1`).

## Usage bars

Top-left of the office (right of the zoom buttons; on the phone, right of the menu button): how much of the Claude Code plan is left — a weekly bar over a 5-hour bar of the same size, told apart like a game's health and stamina all the way down: weekly green → yellow (≤50%) → red (≤20%), 5-hour blue → purple → red, the share left printed inside each (left-aligned, in the pixel number font), no panel behind. A pixel heart sits left of them (`usage/PixelHeart.tsx`: outlined, shaded, colours in `USAGE_HEART_COLORS`; the beat flashes a one-pixel-bigger frame over it, whole pixels, never a scale). Hovering any of it (on a phone: a tap, undone by a tap elsewhere — hover is off there, since a tap's emulated mouseenter would cancel its own toggle) makes the heart beat at a pace proportional to the WEEKLY share left (`USAGE_HEART_MAX_BPM` at full, slower as it runs down, still when empty) and shows each bar's name and reset time just right of it (on a phone, below the bars) ("Weekly · resets in 3d 11h", "5-hour · …") (the age of the numbers is the hover title). Claude Code hands out `rate_limits` ONLY to its status line (subscribers, after a session's first reply), so the data comes from a **usage bridge** (`HookProvider.usageBridge`): Settings → Usage Bars, after a confirm showing the provider's disclosure (the click is the consent — never installed silently, not tied to hooks consent), WRAPS the user's `statusLine` in `~/.claude/settings.json` (`statusLine` is one command, not a list): `node ~/.pixel-agents/hooks/claude-statusline.js --wrap <base64url of their command>`. The script runs their command with the same stdin/env/cwd and passes output + exit code through, and POSTs only `rate_limits` and the session's context share (`session_id`, `used_percentage`, `context_window_size`) to every live server. No status line → a bare bridge that prints nothing (which hides Claude Code's footer hints — disclosed). Off / VS Code uninstall restores their command byte for byte; a status line replaced after us is left alone; non-command shapes and hand-edited wraps are refused, and so, on Windows, is a status line of the user's own (the wrap runs it through Node's shell, cmd.exe there, not Claude Code's Git Bash or PowerShell; only a bare bridge installs). A bare bridge counts as our own output in the backup predicate. With no session running the bars keep the last report (persisted), a window past `resetsAt` shows full, and "updated N ago" says how old the rest is. A project-scope `statusLine` overrides ours, so sessions there don't report. Usage is account data: `usageLimits`/`usageBridgeStatus` go to privileged sockets only.

## Pixel Office MCP

**Full reference: `docs/design/pixel-office-mcp.md` — read it before touching `server/src/mcp/`, a tool, consent, launch/close, messages, or the layout / Character undo.** Why it is shaped this way: `docs/adr/0003`.

The office's MCP server (glossary: **Pixel Office MCP**, never "Office MCP"), id `pixel-office` (tools `mcp__pixel-office__…`), offered to the agents the office launches once the user consents.

- **Shape**: a stateless Streamable-HTTP route, `POST /mcp`, on the office's own Fastify server (both surfaces). Tools call the runtime, store, layout persistence, launcher and terminals directly; no second copy of office state.
- **One composition** for both surfaces, `composeOfficeMcp(surface)` → the `officeMcp` feature object. `officeMcp.ts` owns the route, tool table and token registry; `tools/` has one file per tool (a new tool = its file + one line in `tools/index.ts`), each naming the capabilities it `uses`; `officeOperations.ts` is the seam, one module per capability (`agents`, `layout`, `messaging`, `visits`, `characters`, `directories`, `launch`, `close`, `shells`, `tutorial`).
- **Injected at launch, never installed**: `--mcp-config <0600 file under ~/.pixel-agents/mcp/>` on every launch and resume through the office, in the provider's `mcpConfigFile` format (a CLI without it is offered no MCP), carrying a per-agent token (memory only; it IS the caller's identity). Nothing is written to `~/.claude`; adopted agents never get it; the server token never reaches an agent.
- **Consent** (`docs/adr/0001`): config `officeMcpConsent` granted | declined, asked on the Intro's choices step, switched in Settings beside a read-only switch (`officeMcpReadOnly`: tools with `changes` are refused at call time). Both take effect at once for running agents.
- **Tools**: list_agents, get_layout, list_catalog, list_wardrobe, list_characters, edit_characters, list_directories, edit_directories, edit_layout, undo_layout_edit, undo_character_edit, visit, launch_agent, close_agent, read_agent_terminal, send_message, list_pc_shells, open_pc_shell, read_pc_shell, type_in_pc_shell, close_pc_shell, get_feature_guide, tutorial.
- **VS Code** has no `launch` / `close` / `shells` capability (no launch_agent, close_agent or PC shell tools), no screen to read (`read_agent_terminal` = status only) and text-only `send_message` (`turnGuard`). A second window reusing another's server gets no MCP and is not offered it (the feature's `offered()`: no ask, no Settings switches, no tutorial).
- **Edits wait for the user**: an office with unsaved editor changes (`layoutEditing {dirty}`) or an unsaved Characters draft (`charactersEditing {dirty}`) refuses agents' edits and undo. Undo restores the newest edit only while the office still holds what it wrote.
- **Tests**: `officeMcp*.test.ts` over a real composed server (`server/__tests__/helpers/officeMcpHarness.ts`); e2e `office-mcp.spec.ts`, `office-mcp-characters.spec.ts`.

## Tutorial

An optional hands-on tour on top of the Pixel Office MCP (glossary: **Tutorial**, **Quest**; why it is shaped this way: `docs/adr/0004`).

- **Offered at the Intro's end.** Where `tutorialStatus.available` (the MCP granted and offered by this office — the MCP feature's `offered()`; a second VS Code window on another window's server is told, in `unavailableReason`, to start the tour from that one — and a `TutorialSurface` that can launch now) and no run is under way, the all-set step carries the ask (`tutorial/TutorialAsk.tsx`, reducer `tutorialOffer.ts`) in the server's headline (`tutorialCopy.ts`, the greeter speaking for itself: "Want me to show you around?"; the server still sends its `disclosure` — a real Claude Code session in <Directory>, the plan, auto mode, quit closes it — but the ask no longer says it), Show Me Around over Let's Go. Settings → Play the Tutorial opens the ask alone. Let's Go / Not Now end the Intro as before; nothing launches before `startTutorial`.
- **The greeter sits, then the Guide goes live.** On the yes, `OfficeState.handoff` (`office/engine/greeterHandoff.ts`) walks the greeter to the nearest free seat it can reach, by steps (held while it walks) and sits it; only then does the office send `startTutorial { palette, seatId }` (the greeter's look and seat) and arm `expectLaunch`. → `Tutorial.start` → the surface's `TutorialSurface.launch` (standalone `terminal/standaloneTutorial.ts`: `launchIntoDirectory` into the start Directory — the folder `pixel-agents` ran in — asking for that seat; VS Code: `launchNewTerminal` into the first workspace folder) with the MCP, Nickname `Guide` (core's `TUTORIAL_NICKNAME`), the **onboarding skill** (`tutorial/onboardingPlugin.ts` has the provider's `skills` packaging write it under `~/.pixel-agents/tutorial-plugin/` on every start, from `tutorialCopy.ts`'s words — Claude's: `.claude-plugin/plugin.json` + `skills/onboarding/SKILL.md`; the provider's `pluginDirs` → `--plugin-dir`, that session only), the first message `/pixel-agents:onboarding` (`tutorialFirstMessage`: the skill's command as the provider's `skills.command` gives it; the MCP server's `instructions` carry the fallback, `tutorial` with `brief: true`), the provider's `autoPermissionMode` (Claude: `auto`) whatever Skip Permissions says, the provider's `mostCapableModel` (Claude: `opus`, the CLI's alias for its newest Opus) whatever the user's default, and `preapprovedMcpTools` = the read-only tools (`--allowedTools mcp__pixel-office__… …`, one value per tool, last before `--`). The office that sat its greeter gives the Guide's `agentCreated` (claimed by its Nickname) the greeter's seat and place with no spawn effect (`replaceGreeterWith`; the Intro's camera stays on it, `greeterAnchor`, until the run arrives); other offices see an ordinary join. A run is memory only and ends with the Guide (`agentRemoved`) or Quit (`quitTutorial` → the surface's close, the card's ×).
- **The Guide** goes by the greeter's character's name (`greeterPalette`, core: Byte unless renamed), in the copy, the skill and its own words, and talks as a resident of the office: it opens with what Pixel Agents is, asks whether the user wants something in particular or a look around, and suggests what fits next; the untracked follow-ups (an Area or default characters for a Directory, resuming conversations, what agents can do over the MCP) it offers as they fit. It stays once the tutorial is done, an ordinary agent closed with its card's ×.
- **Quests** (`core/src/tutorial/quests.ts`, four, in any order: create your first character, add a project (a Directory), put an agent to work, make the office yours): only the server completes one (`tutorialSightings.ts` `questsSeen`: the office's facts — cast ids, the user's Directories' paths, the agents (the Guide excluded), `layoutSignature` — compared with the ones the run started from, checked on `characterProfilesLoaded` / `directoriesLoaded` broadcasts, every agent that joins (`agentAdded`), every `layoutSaved` and every `tutorial` call of the Guide's; the layout re-baselined on every `layoutLoaded`, so an agent's edit is never the user's). Anyone privileged may `skipTutorialQuest`; the Guide skips for the user with `tutorial` `skip`. Progress is the pure `tutorialProgress.ts`.
- **The checklist** (`tutorial/TutorialPanel.tsx`, top-right of the office while `run`, clear of the desktop card bar; collapsed until opened, when it is exactly as tall as an agent card and level with the first one (`CARD_BAR_TOP_PX`), since the tour is the Guide's conversation): each quest's state (`data-testid="tutorial-quest-<id>"`, `data-state`), pressing an open one shows its goal + Skip, Quit asked once; once all are closed it reads "Tutorial complete!" for `TUTORIAL_COMPLETE_LINGER_MS`, fades and goes (never offering to close the Guide; an office opened after the finish shows none).
- **The Guide is never typed into**: its skill has it read `tutorial` status every turn; the checklist shows progress at once.

## Office UI

**Full reference: `docs/design/office-ui.md` — read it before touching `webview-ui/src/office/`, the card bar, the mobile shell, the terminal's touch / copy / file sending, the radio, or how a launch picks its look.** It covers rendering, UI styling, pixel icons and the number font, the character FSM, palette assignment, Visits, the Buildout, sub-agents, speech bubbles, sound, the office radio, the mobile shell and seats.

- **Rendering**: game state lives in the imperative `OfficeState` class, not React state. Pixel-perfect: zoom is a whole number of device pixels per sprite pixel, no `ctx.scale(dpr)`; entities z-sorted by Y.
- **Styling**: pixel art — sharp corners, solid backgrounds, `2px solid` borders, hard offset shadows; colours as CSS variables in `index.css` `:root`; font FS Pixel Sans. ESLint rules (`eslint-rules/pixel-agents-rules.mjs`, all `error`): `no-inline-colors` (colour literals only in `constants.ts`), `pixel-shadow`, `pixel-font`.
- **Icons are 8×8 grids** (`components/ui/pixelIcons.ts`) drawn at a whole-number scale by `PixelIcon`; never scale one fractionally. **Numbers** go through `<PixelText>` (the 3×5 pixel number font).
- **A look is `{ palette, repeat }`**, chosen once by core's `chooseLook` and owned by the server; a palette is an index into the character profiles, kept on its character across saves by profile `id`.
- **Sub-agents** have negative ids, copy their parent's look, are never persisted and never wander.
- **Visits, Message shows and Buildouts** take a character out of its usual FSM through its errand stack (`engine/visitsController.ts`); the server's Visit wins over local errands.
- **Mobile shell** (standalone only, `mobile/`): `useIsMobile` is gated on `isBrowserRuntime` — a narrow VS Code panel must never get it. Gestures are pure reducers with thin DOM adapters, tracking ONE finger by identifier. Viewport overlays mount at App's top level, never inside the sliding track.
- **Terminal copy is verbatim by default**; re-flow is opt-in (Alt+C, "Copy as text").
- **The office radio**: the order of every random draw in the composer is part of the song-code format (`musicComposer.test.ts` pins it).

## Characters

**Full reference: `docs/design/characters.md` — read it before touching `core/src/characters/`, `core/src/characterProfiles.ts`, the wardrobe art, the cast store or the Characters view.**

The Characters view (bottom toolbar button; phone: next to Settings) designs the cast. The character model (art, slot table, renderer, colour maths, sheet geometry, profile edits) is pure core (`core/src/characters/`), so the server draws characters too (`server/src/characterArt.ts`); the webview keeps only its loader and the UI. `characterRenderer.test.ts` pins the six default sheets pixel for pixel.

- **Profile**: a permanent `id`, one wardrobe part id per slot, colours, pixel edits, eyes. Format `v: 35`; `migrateCharacterProfile` brings any older one up in one pass. ONE deep validator, `parseCharacterProfiles`, on server and webview.
- **Wardrobe art**: one finished, uncoloured 128×96 PNG per part in `core/src/characters/art/`. Adding a part = its PNG + its line in `wardrobe.json`; `decodeWardrobe` fails loudly on a mismatch. Inlined into the webview bundle, copied to `dist/assets/wardrobe/` for the server.
- **Slot table** (`slots.ts`): a piece is defined once, in `LAYERS`; everything else is derived.
- **Cast** (`cast.ts` `CastStore`): the view edits a **draft**; nothing reaches the server until Save (`saveCharacterProfiles` with a `saveId`, answered by `characterProfilesLoaded`). The server owns the list.
- **Custom items**: a worn piece saved as a `WardrobeItem` (`wardrobe-items.json`), worn like a built-in part.
- **Agents' edits** go through the same commit as Save and wait while a draft is dirty.

## Layout Editor

Toggle via "Layout" button. Tools: SELECT (default), Floor paint, Wall paint, Erase (set tiles to VOID), Furniture place, Furniture Copy (`FURNITURE_PICK`: type + colour off a placed item), colour Copy (`COLOR_PICK`: colour only), Eyedropper (floor/wall), wall Copy (`WALL_PICK`: set + colour off a wall), section Select (`FLOOR_SECTION` / `WALL_SECTION`). `handleEditorTileAction` is a per-tool switch; the layout maths lives in pure `editorActions.ts` functions. Clicks on placed items (select, drag) never reach it — the canvas resolves them.

**Floor**: 7 patterns from `floors.png` (grayscale 16×16), colorizable via HSBC sliders (Photoshop Colorize). Color baked per-tile on paint. Eyedropper picks pattern+color.

**Walls**: painted like floors — pick a wall set (Plain, Brick, Wood planks, Stone, Wainscot, Office panel, Glass partition, Half panel, Cubicle: `WALL_SET_LABELS`) and an HSBC colour (Colorize mode); both are baked per tile (`tileColors` + `wallSets`), so any number of kinds and colours stand side by side, and the sliders only set the brush (walls already standing keep theirs). A stroke's first tile decides its direction (`wallDragAdding`, `wallStrokeAdds`): starting on the very wall it would paint (same set and colour) removes walls back to floor, anywhere else it paints — restyling any wall it crosses (`paintWall`). Copy (`WALL_PICK`) and the floor eyedropper on a wall take its set + colour. Furniture cannot be placed on wall tiles, but background rows may overlap walls.

**Sections** (`tileSections.ts`): the Floor and Walls panels' **Select** picks a section — every tile reachable edge to edge through tiles of the same material (floor: pattern + colour; wall: set + colour). The section under the cursor previews with a faint outline, picked ones get a solid one (both hidden for `EDIT_OUTLINE_HIDE_MS` after each restyle, so the colour being edited reads clean); Shift+click adds a section (or drops a picked one). A pick seeds the panel's brush with its look and keeps the colour sliders open; while sections are picked, the sliders and pattern / set thumbnails restyle all of them live (`restyleSection`, undo session `` `section:<n>` `` — one entry per pick). Picked tiles are fixed at the pick (a section restyled into its neighbour's look doesn't swallow it); undo / redo re-find them from the clicked tiles (`anchors`). Esc drops the pick, then closes the tool; a tool change drops it too.

**Furniture**: Ghost preview (green/red validity); `buildEditorRenderState` (`office/editor/`) builds the frame's `ghosts[]` + one `ghostValid`. R key rotates, T key toggles on/off state — a selected placed item wins over the catalog type. Drag-to-move in SELECT; **Alt-drag drops a copy** (cursor `copy`, Alt sampled live so it can flip mid-drag; the copy is left selected). The canvas only reports the gesture (`onDrop(uid, col, row, { duplicate })`); `handleDrop` → pure `dropFurniture` validates, commits and sets selection. **Desks carry their riders**: surface items standing on an `isDesk` item (`getSurfaceRiders`) move, rotate (spot swung round the desk top) and get copied with it; the whole group must fit or nothing happens. Delete button (red X) + rotate button (blue arrow) on selected items. **Dragging on empty floor draws a box** that selects every item whose footprint touches it (`furnitureInBox`, `editorState.marquee`; Shift adds to the selection; a click without a drag deselects). **Shift+click selects several items** (`selectedFurnitureUid` leads — its colour fills the sliders — plus `extraSelectedUids`; the buttons centre above the box round them all, `selectionBox`): the colour sliders and colour Copy, R, T, Delete and the buttons act on all of them (`setFurnitureColors`, `rotateFurnitureGroup` — the selection turns as one arrangement: each item turns and its spot swings round the centre of the box round their solid footprints, riders going with their desk, nothing turning unless all fit; a desk with one orientation only (`TABLE_FRONT`) keeps its shape but still turns what rides on it, alone or in a selection; electronics step the orientation cycle the other way (`turnedType`: a screen's orientation is the way its user looks, so front → right → back → left turns it clockwise on screen, a chair counter-clockwise) — `toggleFurnitureStates`, `removeFurnitureGroup`); dragging a selected item carries the selection and their riders as one group (`planFurnitureMove` `with`, `dragCompanions`), Alt-drag copies it and selects the copies, a moved selection stays selected; a plain click narrows it to the clicked item. The selection highlights hide for `EDIT_OUTLINE_HIDE_MS` after each colour change, so the colour reads clean. **Selecting a placed item closes the open tool tab and opens its HSBC colour sliders** (Reset + Copy buttons); color stored per-item in `PlacedFurniture.color?`. Hit-testing is ONE `furnitureAt` (surface items win over the desk under them) — select, drag, cursor and both Copy tools agree. Placement state is `editorState.placing: { type, color? }`: the Copy tool's lifted colour styles that copy only — `color: null` is a copied ABSENCE of colour, so an uncoloured item's copy stays uncoloured under a palette colour; `undefined` (a plain catalog pick) takes `pickedFurnitureColor` (`placementColor()`); palette sliders override either. Colour Copy takes the clicked item's colour into whichever sliders armed it, then returns to that tool.

**Undo/Redo**: 50-level, Ctrl+Z/Y. EditActionBar (top-center when dirty): Undo, Redo, Save, Reset. **Stroke-scoped undo**: every edit goes through `commitLayout(layout, session)`; edits sharing `editorState.undoSession` collapse into one entry — `'stroke'` (one floor / wall / erase / carpet click-drag), `` `color:<uid>` `` (a slider run on one item), `` `section:<n>` `` (restyles of one section pick). `null` = discrete edit (its own entry; a colour eyedrop is one). Mouse up / leave, tool change, Esc, selection changes and undo/redo end the session (`endStroke`). Area paint stays per-tile.

**Multi-stage Esc**: exit furniture pick → deselect catalog → close tool tab → deselect furniture → close editor.

**Erase tool**: Sets tiles to `TileType.VOID` (transparent, non-walkable, no furniture) **and deletes any furniture whose footprint the stroke passes through** (`removeFurnitureAt`). Right-click in floor/wall/erase tools also erases to VOID + furniture (drag-erasing supported). Context menu suppressed in edit mode.

**Grid expansion**: In floor/wall/erase tools, a ghost border (dashed outline) appears 1 tile outside the grid. Clicking a ghost tile calls `expandLayout()` to grow the grid by 1 tile in that direction. New tiles are VOID. Furniture positions and character positions shift when expanding left/up. Max: `MAX_COLS`×`MAX_ROWS` (64×64). Default: `DEFAULT_COLS`×`DEFAULT_ROWS` (20×11). Characters outside bounds after resize relocated to random walkable tiles.

**Layout model**: `{ version: 1, cols, rows, tiles: TileType[], furniture: PlacedFurniture[], tileColors?: ColorValue[], wallSets?: (number | null)[] }` (`wallSets`: each wall tile's set, parallel to `tiles`; null/absent = set 0, so older layouts keep their walls; cleared when a tile stops being a wall, shifted by `expandLayout`). Grid dimensions are dynamic. Persisted via debounced saveLayout message → `writeLayoutToFile()` → `~/.pixel-agents/layout.json`.

## Asset System

**Loading**: `esbuild.js` copies `webview-ui/public/assets/` → `dist/assets/`. Loader checks bundled path first, falls back to workspace root. PNG → pngjs → SpriteData (2D hex array, alpha≥2 = visible, `#RRGGBBAA` for semi-transparent). `loadDefaultLayout()` reads `assets/default-layout.json` as fallback for new workspaces.

**Catalog**: `furniture-catalog.json` with `id, name, label, category, footprint, isDesk, canPlaceOnWalls, groupId?, orientation?, state?, canPlaceOnSurfaces?, backgroundTiles?, interactive?` (the manifest's validated `interactive` block, carried on every asset of its furniture: `furnitureAssetsLoaded`'s catalogue is how the office and the server read the same declaration). String-based type system. Categories: desks, chairs, storage, electronics, decor, wall, misc. Wall-placeable items use the `wall` category and appear in a dedicated "Wall" tab. Asset naming convention: `{BASE}[_{ORIENTATION}][_{STATE}]` (e.g., `MONITOR_FRONT_OFF`).

**Per-furniture manifests**: Each furniture item lives in its own folder under `assets/furniture/` with a `manifest.json` that declares its sprites, rotation groups, state groups (on/off), and animation frames. Floor tiles are individual PNGs in `assets/floors/`; wall tile sets in `assets/walls/`.

**Rotation groups**: `buildDynamicCatalog()` builds `rotationGroups` Map from assets sharing a `groupId`. Supports 2+ orientations (e.g., front/back only). Editor palette shows 1 item per group (front orientation preferred). `getRotatedType()` cycles through available orientations.

**State groups**: Items with `state: "on"` / `"off"` sharing the same `groupId` + `orientation` form toggle pairs. `stateGroups` Map enables `getToggledType()` lookup. Editor palette hides on-state variants. State groups are mirrored across orientations.

**Interactive furniture** (`core/src/furniture/`, glossary "Interactive Furniture", `docs/adr/0005`; for furniture authors: `docs/external-assets.md` → "Interactive furniture"): a manifest may carry one optional `interactive` block whose parts are independent and each optional — `agentUse: "workstation"` (agents work here: the seat pairing below), `label: { name, lines?: [{ when, text }] }` (the Furniture label: the FIRST line whose `when` holds, shown alone — the name shows only where no line holds; `{agent}` only on an `agentWorking`-only line, `{panel}` only on a `panelInUse`-only line), `panel: "terminal"` (what a click opens: see "PC shells"), `states: [{ state, when }]` (the first rule that holds picks a declared state). Conditions, a closed vocabulary that grows by decision: `agentWorking`, `panelInUse`, `free`; `when` is one or a list (any holds). ONE validator, `withInteractive`, runs wherever manifests are read (server `assetLoader.ts` for bundled and external asset directories alike, `core/src/assets/build.ts` for the dev server): an unknown key / agent use / panel / condition / placeholder or an undeclared state drops the whole block with a `[Furniture] <id>: interactive block dropped (…)` warning, and the furniture loads plain. ONE set of rules (`pieceRules.ts`; facts = the agent at work, the panel in use, the places a new panel may open, read-only): `pieceState` (the renderer, every frame), `pieceLabel`, `pieceClick`, composed by `pieceView` for the hover and the click; the server asks only `opensPanel` (does this piece open a terminal?); it knows no furniture by name. **Electronics no longer pair by category**: a piece is a workstation only by `agentUse`; an `electronics` piece with states and no block loads plain with a warning (`withInteractive`), and `docs/external-assets.md` says what to add. The PC (`assets/furniture/PC/manifest.json`) declares all four parts.

**Auto-state**: furniture says how it reacts in its manifest's `interactive` block (core `furniture/`), and the office evaluates it with core's rules (`pieceState` every frame, `pieceView` for hover and click); nothing in the office names the PC. `core/src/layout/workstations.ts` `pairWorkstations` pairs each seat with at most one piece whose furniture declares the `workstation` agent use (the PC) and each such piece with at most one seat: the tile in front of the seat must be a desk, the piece must stand on that desk within reach (3 tiles ahead, 1 to the side up to 2 deep) with its screen facing the seat (front PC ↔ back chair, back PC ↔ front chair, side ↔ side, left ↔ left), closest pair wins. The seat picker prefers paired seats (so sofas near a desk never count). `officeState.pieces.facts(uid, readOnly)` is what the office knows of a piece (the agent working at it — active, sitting in its seat and typing; its live PC shell as the panel in use; the Directories of its Area as the places), and `rebuildFurnitureInstances()` shows each piece in the state its rules pick (`stateVariantOf`: the same furniture and orientation in that state, animated by frame), or its usual sprite where it has no art for it (re-checked every frame in `update`). The PC declares "on" while an agent works at it or its panel is in use. Render-time only, the saved layout is untouched. Only front PCs have ON art today.

**Background tiles**: `backgroundTiles?: number` — top N footprint rows allow other furniture to be placed on them AND characters to walk through. Z-sort places bg-row items behind the host furniture.

**Surface placement**: `canPlaceOnSurfaces?: boolean` — items like laptops, monitors, mugs can overlap with all tiles of `isDesk` furniture. `canPlaceFurniture()` builds a desk-tile set and excludes it from collision checks. Z-sort: surface items get `zY = max(spriteBottom, deskZY + 0.5)`.

**Wall placement**: `canPlaceOnWalls?: boolean` — items like paintings, windows, clocks can only be placed on wall tiles. `canPlaceFurniture()` requires the bottom row of the footprint to be on wall tiles; upper rows may extend above the map. `getWallPlacementRow()` offsets placement so the bottom row aligns with the hovered tile.

**Colorize module**: `colorize.ts` with two modes selected by `ColorValue.colorize?` flag. **Colorize mode** (Photoshop-style): grayscale → luminance → contrast → brightness → fixed HSL; always used for floor tiles. **Adjust mode** (default for furniture, and an external `char_N.png`'s repeats): shifts original pixel HSL. Cache keyed by arbitrary string (includes colorize flag).

**Floor tiles**: `floors.png` (112×16, 7 patterns). Cached by (pattern, h, s, b, c).

**Wall tiles**: `assets/walls/wall_N.png`, one set each (64×128, 4×4 grid of 16×32 pieces, grayscale). 4-bit auto-tile bitmask (N=1, E=2, S=4, W=8). Sprites extend up to 16 px above tile (3D face); a lower set (Half panel, Cubicle) leaves the top of its pieces transparent. `wallTiles.ts` computes the bitmask at render time, counting a neighbour only when it is a wall of the same HEIGHT (read off the art: the lone piece's first opaque row) — so brick joins plaster, but a cubicle wall closes its own end against a full one. The mask can't see diagonals, so a piece running south keeps its side outline on a joined side (right beside a plain run, whose front face shows there); where the diagonal joins too — a wall more than one tile thick — `withoutSeams` fills that outline from the cap, so the top reads solid. `wall_0` is the original hand-drawn set; `wall_1`…`wall_8` are generated (`scripts/generate-wall-sets.mjs`), so a new kind is a texture function + one line in its `KINDS`. Colorizable via HSBC sliders. Wall sprites z-sorted with furniture/characters (`getWallInstances()` builds `FurnitureInstance[]`).

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
| `core/src/layout/constants.ts`     | Layout constants the pure layout ops need (grid limits, default colour, PC reach); the webview's constants.ts re-exports them           |
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
- **A session that moves keeps its transcript.** EnterWorktree / ExitWorktree in an interactive session MOVE the whole file into the new folder's project dir (same name); a `-p` session keeps writing the old one, while its hooks name a `transcript_path` that never exists. So an agent is re-pointed only to a file that exists, once the one it reads is gone, keeping its offset — re-reading from 0 is the resume bug below (`agentMoves.ts`).
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
- **Consent before any FIRST settings-file write**, per provider (`hooksConsent: {providerId: 'granted'|'declined'}`, absent = unanswered; the `hooksEnabled` preference beside it is per-provider and machine-global). **Exactly one population is asked: the one with nothing of ours installed** — hooks already on disk are granted silently at startup, since that install only ever removes events. The ask is one box of the Intro's choices step (`IntroChoices.tsx`: usage bars, live updates = the hooks, the Pixel Office MCP; one card each in a row, all off to start, a line each with the full terms behind "Read more", Continue sends them all, every box off is warned about first; ticked = `install`, left off = `never`), in the first-run tour a greeter character speaks in-app on both surfaces (`IntroDialog.tsx`, a game's dialog: the camera centres the greeter, its words type out in a box along the office's foot one short message at a time — `introDialogRules.ts` cuts them to two rows of the box — and a step's controls are a menu above it, shown once the step's last message is out — its options stacked in one box at the right edge (`IntroOptions.tsx`), or in the dialog box under the words where the step shows cards or a field over it; Back is a button at the dialog box's foot, one message at a time, then the step before: "Hi, I'm <greeter>" → "First, get Claude Code" only when `hooksConsentRequest.cliInstalled` is false (`HookProvider.isCliInstalled`, Claude: `claude` on PATH, `executableOnPath.ts`) → "Sign in to Claude Code" only when the CLI is there and reports no login (see "Sign-in") → choices → all set); the server sends `hooksConsentRequest` during the `webviewReady` handshake, one per provider, privileged connections only, carrying the provider's own `consentDisclosure()` (headline, summary, disclosure) so no client-side copy can drift. The ask-or-not predicate, the choice→action rule, and the execution live ONCE in `server/src/providers/hook/` (`consentGate.ts` decides, `consentExecutor.ts` performs); surfaces supply only their effects. **A choice is an absolute state command, not an event** — Back re-opens the ask, so a revision undoes whatever the earlier answer left: hooks on disk, a grant a failed install recorded, or a decline's own persisted hooks-off. That is why the consent record is a tri-state and each answer commits in ONE config write; the full rule and its rejected alternatives are `docs/adr/0001`. The first-run tour has no close (no x, no Escape; only the tutorial's ask opened from Settings closes on Escape and Not Now): a reload mid-tour sends nothing and the whole Intro returns next open; the closing step reports the install OUTCOME, not the click.
- **`hooksStatus` is install state, `hooksEnabled` is preference.** The Settings checkbox binds to `hooksInstalled` and toggles the _displayed_ state with no optimistic local update, so it can't read "on" over an untouched settings.json and lands correct rather than flickering when an install fails. Every failure path re-derives and broadcasts the truth (standalone via `clientMessageHandler`, VS Code via `reportHooksStatus`). The hook script is copied BEFORE the entries are written; a failed copy aborts the install (entries pointing at a missing script spawn a dead `node` per event). **Hooks-off is persisted only AFTER a successful uninstall** — flipping it first strands the user: the entries keep firing while the persisted preference makes the next start skip the gate entirely.
- **Never rewrite a shape we did not author.** The unparseable-file abort generalizes: a non-object `hooks`, a non-array `hooks.<Event>`, and junk entries inside an event array are all refused or passed through, never replaced. An array `hooks` was the sharp case — string keys assigned onto it vanish from `JSON.stringify`, so the write committed and reported `installed: true` over a file with no hooks in it. Emptied event keys are deleted only when _our_ removal emptied them. **Internal sentinels must not be values user JSON can hold**: `null` marked "this entry is now empty", so a user-authored `null` inside a hooks array was silently deleted (a file with no Pixel Agents command anywhere came back rewritten and logged as "Hooks removed") — it is a `Symbol` now.
- **Hook identity is anchored at both ends, not a substring.** `includes('claude-hook.js') && includes('.pixel-agents')` claimed — and `uninstallHooks` then DELETED — a `.backup` copy of our script, a shell comment naming our path, a wrapper passing it as an argument, `/opt/evil.pixel-agents/hooks/claude-hook.js`, and `my-pixel-agents-hook.js`. Ours = the `/.pixel-agents/hooks/claude-hook.js` suffix, ending the command's FIRST token, matched **case-insensitively** (the token is normalized to lower case). Case-sensitive matching is what shipped, and on the case-insensitive volumes this runs on (macOS, Windows) a differently-cased path is the SAME INODE as our script and genuinely firing: reinstall appended a duplicate and uninstall left the cased entry as an orphan our own `areHooksInstalled` could no longer see — a live hook with no removal route. The folding is unconditional (no filesystem case-sensitivity probe), so the accepted trade is a Linux-only false positive that is **not** a mere dedup: on a case-sensitive volume `~/.Pixel-Agents/hooks/claude-hook.js` is a genuinely DIFFERENT file, we classify it as ours, and uninstall **deletes** it (`claudeHookInstaller.test.ts` pins that removal). Nothing creates that path, and the trade is deliberate — the alternative is a guaranteed unremovable live hook on the two platforms this actually ships to. A symlink alias to our script is deliberately _not_ recognized — the cost is one duplicate entry, versus deleting a stranger's hook if we resolved paths.
- **The Pixel Office MCP is injected per launch with per-agent tokens, never installed** (`--mcp-config` file under `~/.pixel-agents/`, a token minted for that agent alone, in memory only; never the server token, never a write to `~/.claude`). Chosen over a user-scope install (reaches sessions the office never launched, outlives the office, and edits Claude's config) and over handing agents the server token (any code an agent runs could then drive every message the office accepts). `docs/adr/0003`.
- **E2E over webview unit tests** for OSS friction. Community PRs change webview internals constantly; unit tests would force contributors to update internals tests on top of feature work. E2E pins user-facing behavior, which is stable across internal refactors.

## Project Identity

- Extension ID: `pablodelucca.pixel-agents` (VS Code Marketplace + Open VSX)
- npm package: `pixel-agents` (CLI bin: `pixel-agents`)
- GitHub: `https://github.com/pixel-agents-hq/pixel-agents`
- License: MIT
