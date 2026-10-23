import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { toMajorMinor } from './changelogData.js';
import { AgentCardBar } from './components/AgentCardBar.js';
import { AgentLookToggle } from './components/AgentLookToggle.js';
import { AnshPanel } from './components/AnshPanel.js';
import { BottomToolbar } from './components/BottomToolbar.js';
import { ChangelogModal } from './components/ChangelogModal.js';
import { ConnectionIndicator } from './components/ConnectionIndicator.js';
import { DailyStrip } from './components/DailyStrip.js';
import { DebugView } from './components/DebugView.js';
import { DirectoryModal } from './components/DirectoryModal.js';
import { EditActionBar } from './components/EditActionBar.js';
import { IntroBubble } from './components/IntroBubble.js';
import { MigrationNotice } from './components/MigrationNotice.js';
import type { RemoteWorkerInputs } from './components/RemoteWorkers.js';
import { RemoteWorkersChip, RemoteWorkersPanel } from './components/RemoteWorkers.js';
import { SettingsModal } from './components/SettingsModal.js';
import { TasksBoard, TasksButton } from './components/TasksBoard.js';
import { TerminalDrawer } from './components/TerminalDrawer.js';
import { Tooltip } from './components/Tooltip.js';
import { Button } from './components/ui/Button.js';
import { Modal } from './components/ui/Modal.js';
import { VersionIndicator } from './components/VersionIndicator.js';
import { FitIcon, ZoomControls } from './components/ZoomControls.js';
import {
  FIT_MARGINS_DESKTOP,
  FIT_MARGINS_DESKTOP_READ_ONLY,
  FIT_MARGINS_MOBILE,
  OFFICE_CANVAS_TEST_ID,
} from './constants.js';
import { officeAgentIds } from './hooks/agentKindState.js';
import { useCameraFit } from './hooks/useCameraFit.js';
import { useDirectoryEditor } from './hooks/useDirectoryEditor.js';
import { useEditorActions } from './hooks/useEditorActions.js';
import { useEditorKeyboard } from './hooks/useEditorKeyboard.js';
import type { Directory } from './hooks/useExtensionMessages.js';
import { useExtensionMessages } from './hooks/useExtensionMessages.js';
import { useIntroTour } from './hooks/useIntroTour.js';
import { useIsMobile } from './hooks/useIsMobile.js';
import { useKeyboardViewport } from './hooks/useKeyboardViewport.js';
import { useTerminalDrawer } from './hooks/useTerminalDrawer.js';
import { InboxStripItems } from './inbox/InboxPanel.js';
import { useInboxMessages } from './inbox/inboxStore.js';
import { MobileShell } from './mobile/MobileShell.js';
import { useMobileShell } from './mobile/useMobileShell.js';
import { AnshBubbleOverlay } from './office/components/AnshBubbleOverlay.js';
import { LimitBreakOverlay } from './office/components/LimitBreakOverlay.js';
import { NpcOverlay } from './office/components/NpcOverlay.js';
import { NpcSpeechOverlay } from './office/components/NpcSpeechOverlay.js';
import { OfficeCanvas } from './office/components/OfficeCanvas.js';
import { ToolOverlay } from './office/components/ToolOverlay.js';
import { EditorState } from './office/editor/editorState.js';
import { EditorToolbar } from './office/editor/EditorToolbar.js';
import { OfficeState } from './office/engine/officeState.js';
import { exportLayoutToFile } from './office/layout/exportLayout.js';
import { isRotatable } from './office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from './office/layout/layoutSerializer.js';
import { overlayProjection } from './office/projection.js';
import { getPetCount } from './office/sprites/petSpriteData.js';
import { EditTool, type OfficeLayout, TILE_SIZE } from './office/types.js';
import { ApprovalCard } from './permissions/ApprovalCard.js';
import {
  agentClickAction,
  approvalAgentLabel,
  remoteSetupHint,
} from './permissions/approvalState.js';
import { usePermissionApprovals } from './permissions/usePermissionApprovals.js';
import { isBrowserRuntime, isE2E } from './runtime.js';
import { NoticeBoardOverlay } from './signals/NoticeBoardOverlay.js';
import { TimelineCard } from './signals/TimelineCard.js';
import { installTestHooks } from './testHooks.js';
import { transport } from './transport/index.js';
import { FIT_MARGINS_TV, TV_SAFE_AREA_PADDING } from './tvMode/constants.js';
import { TvExitButton, TvModeButton } from './tvMode/TvControls.js';
import { showsIn } from './tvMode/tvModeState.js';
import { useTvAutoFit, useTvMode } from './tvMode/useTvMode.js';
import { UsageMeterOverlay } from './usage/UsageMeterOverlay.js';

// Game state lives outside React — updated imperatively by message handlers
const officeStateRef = { current: null as OfficeState | null };
const editorState = new EditorState();

// Test-only observability hooks (message/sound logs, addAgent wrapper, selectAgent).
// Installed only under the e2e harness so they never patch prototypes or grow
// unbounded logs in a real user's session.
if (isE2E) installTestHooks(officeStateRef);

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState();
  }
  return officeStateRef.current;
}

function App() {
  // Browser runtime (dev or static dist): dispatch mock messages after the
  // useExtensionMessages listener has been registered.
  useEffect(() => {
    // browserMock is for Vite dev mode only (UI prototyping without a server).
    // In standalone server mode, the server sends all state over WebSocket.
    // In VS Code mode, the extension sends all state via postMessage.
    if (isBrowserRuntime && import.meta.env.DEV) {
      void import('./browserMock.js').then(({ dispatchMockMessages }) => dispatchMockMessages());
    }
  }, []);

  const editor = useEditorActions(getOfficeState, editorState);

  const isEditDirty = useCallback(
    () => editor.isEditMode && editor.isDirty,
    [editor.isEditMode, editor.isDirty],
  );

  const {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    agentAwaitingInput,
    agentSeenActivity,
    subagentTools,
    subagentCharacters,
    agentProgress,
    agentSleep,
    dailyStats,
    agentTitles,
    backgroundAgents,
    layoutReady,
    layoutWasReset,
    loadedAssets,
    directories,
    directoryRejection,
    directorySaved,
    directorySuggestions,
    agentDirectoryNames,
    externalAssetDirectories,
    lastSeenVersion,
    extensionVersion,
    watchAllSessions,
    setWatchAllSessions,
    alwaysShowLabels,
    ghostHeadlessAgents,
    setGhostHeadlessAgents,
    hooksEnabled,
    hooksInstalled,
    hooksStatusSeq,
    hooksInfoShown,
    consentRequest,
    dismissConsentRequest,
    areaMappings,
    setAreaMappings,
    showAreas,
    setShowAreas,
    bypassPermissions,
    setBypassPermissions,
    showHostDirectories,
    setShowHostDirectories,
    officeReadOnly,
    terminalAvailable,
    terminalUnavailableReason,
    terminalAgentIds,
  } = useExtensionMessages(getOfficeState, editor.setLastSavedLayout, isEditDirty);
  // Needs-you inbox: agentLink / agentLimit (and the paused flag the office routes on).
  useInboxMessages(getOfficeState);

  // Show migration notice once layout reset is detected
  const [migrationNoticeDismissed, setMigrationNoticeDismissed] = useState(false);
  const showMigrationNotice = layoutWasReset && !migrationNoticeDismissed;

  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHooksInfoOpen, setIsHooksInfoOpen] = useState(false);
  const [hooksTooltipDismissed, setHooksTooltipDismissed] = useState(false);
  const [isDebugMode, setIsDebugMode] = useState(false);
  // The machine of a relayed session clicked while asking with no card to
  // open: the hint says why (agentClickAction 'setupHint').
  const [setupHintMachine, setSetupHintMachine] = useState<string | null>(null);
  const [alwaysShowOverlay, setAlwaysShowOverlay] = useState(false);

  // Background agents get a Remote Workers tile instead of a character, so
  // they stay out of the office overlay and the card bars.
  const officeAgents = useMemo(
    () => officeAgentIds(agents, backgroundAgents),
    [agents, backgroundAgents],
  );
  const remoteWorkers = useMemo(() => {
    const inputs: RemoteWorkerInputs = {};
    for (const id of agents) {
      const info = backgroundAgents[id];
      if (!info) continue;
      inputs[id] = {
        title: agentTitles[id],
        directoryName: info.directoryName,
        tools: agentTools[id],
        status: agentStatuses[id],
        awaitingInput: agentAwaitingInput[id],
        seenActivity: agentSeenActivity[id],
        sleep: agentSleep[id],
      };
    }
    return inputs;
  }, [
    agents,
    backgroundAgents,
    agentTitles,
    agentTools,
    agentStatuses,
    agentAwaitingInput,
    agentSeenActivity,
    agentSleep,
  ]);

  // Mobile shell (phones, touch tablets): office and terminal as sliding
  // full-screen pages with the cards in a bottom bar. Desktop keeps the
  // right-docked drawer.
  const isMobile = useIsMobile();
  // Software keyboard: whether it is up (the key bar shows), and the height
  // to clamp the shell to so the terminal shrinks (and the PTY resizes)
  // instead of hiding its input line under the keys (iOS only — Android
  // resizes the layout viewport itself).
  const keyboard = useKeyboardViewport(isMobile);
  // The office's imperative character selection, mirrored into React so the
  // card bars can restyle the focused agent's card on canvas taps.
  const focusedAgentId = useSyncExternalStore(
    useCallback((onChange: () => void) => getOfficeState().subscribeSelection(onChange), []),
    () => getOfficeState().selectedAgentId,
  );

  // Standalone only: every input here stays false/empty under VS Code. Owns the
  // active tab on both shells; the desktop-only bits (isOpen, width, resize)
  // are simply unread on mobile, where the sliding track plays the drawer.
  const terminalDrawer = useTerminalDrawer({
    terminalAgentIds,
    getOfficeState,
    agentTools,
    agentStatuses,
    agentAwaitingInput,
    agentSeenActivity,
  });

  const launchIntoDirectory = useCallback((directory: Directory) => {
    transport.send({ type: 'launchAgent', directoryPath: directory.path });
  }, []);
  const mobileShell = useMobileShell({
    getOfficeState,
    terminalAgentIds,
    drawer: terminalDrawer,
    focusedAgentId,
    launchAgent: launchIntoDirectory,
  });

  const currentMajorMinor = toMajorMinor(extensionVersion);

  const handleWhatsNewDismiss = useCallback(() => {
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  const handleOpenChangelog = useCallback(() => {
    setIsChangelogOpen(true);
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  // Sync alwaysShowOverlay from persisted settings
  useEffect(() => {
    setAlwaysShowOverlay(alwaysShowLabels);
  }, [alwaysShowLabels]);

  const directoryEditor = useDirectoryEditor({
    directories,
    directoryRejection,
    directorySaved,
    areaMappings,
    setAreaMappings,
    getOfficeState,
  });

  const handleToggleDebugMode = useCallback(() => setIsDebugMode((prev) => !prev), []);
  const handleToggleAlwaysShowOverlay = useCallback(() => {
    setAlwaysShowOverlay((prev) => {
      const newVal = !prev;
      transport.send({ type: 'setAlwaysShowLabels', enabled: newVal });
      return newVal;
    });
  }, []);

  // Toggle "Display headless as ghosts". setGhostHeadlessAgents also updates the
  // renderer's module copy, so the office redraws on the next frame.
  const handleToggleGhostHeadlessAgents = useCallback(() => {
    const next = !ghostHeadlessAgents;
    setGhostHeadlessAgents(next);
    transport.send({ type: 'setGhostHeadlessAgents', enabled: next });
  }, [ghostHeadlessAgents, setGhostHeadlessAgents]);

  const handleSelectAgent = useCallback((id: number) => {
    transport.send({ type: 'focusAgent', id });
  }, []);

  // The Intro's wire-facing state machine — which asks survive being mooted,
  // when a hooksStatus is this tour's install verdict — lives in useIntroTour
  // (pure reducer in introTourState.ts); the App only wires it to the bubble.
  const {
    intro,
    installFailed,
    installPending,
    onChoice: handleConsentChoice,
    onClose: handleIntroClose,
  } = useIntroTour({ consentRequest, hooksInstalled, hooksStatusSeq, dismissConsentRequest });

  // The Settings surface renders one provider today; its checkbox binds to
  // the Claude row of the per-provider install-state map.
  const claudeHooksInstalled = hooksInstalled['claude'] === true;
  // The "Instant Detection Active" toast. Never in a read-only office: it can't
  // record the dismissal (the server refuses setHooksInfoShown), so it would
  // come back on every load, and hooks aren't a viewer's business anyway.
  const showHooksTooltip =
    !officeReadOnly &&
    hooksEnabled &&
    claudeHooksInstalled &&
    !hooksInfoShown &&
    !hooksTooltipDismissed;

  // Mutate Directory→Area mappings locally + send to server. Updates OfficeState in
  // the same tick so a follow-up agentCreated picks up the new mapping.
  const handleAreaMappingChange = useCallback(
    (directoryName: string, areaLabel: string, action: 'add' | 'remove') => {
      const current = areaMappings[directoryName] ?? [];
      let nextLabels: string[];
      if (action === 'add') {
        if (current.includes(areaLabel)) return;
        nextLabels = [...current, areaLabel];
      } else {
        nextLabels = current.filter((l) => l !== areaLabel);
      }
      const next = { ...areaMappings };
      if (nextLabels.length === 0) {
        delete next[directoryName];
      } else {
        next[directoryName] = nextLabels;
      }
      setAreaMappings(next);
      getOfficeState().setAreaMappings(next);
      transport.send({ type: 'saveAreaMappings', mappings: next });
    },
    [areaMappings, setAreaMappings],
  );

  // Toggle global Show Areas — persisted via setShowAreas message; runs server-
  // side through configPersistence.
  const onToggleShowAreas = useCallback(() => {
    const next = !showAreas;
    setShowAreas(next);
    transport.send({ type: 'setShowAreas', enabled: next });
  }, [showAreas, setShowAreas]);

  // When AREA_PAINT is active in the editor, force the overlay on even if the
  // user has toggled Show Areas off globally — they need to see what they're
  // editing. The selected area's overlay is alpha-bumped via activeAreaLabel.
  const isEditingAreas = editor.isEditMode && editorState.activeTool === EditTool.AREA_PAINT;
  const effectiveShowAreas = isEditingAreas || showAreas;
  const activeAreaLabel = isEditingAreas ? editor.selectedAreaLabel : null;

  // e2e: register the component-scoped editor-action drivers + the effective
  // show-areas gate on the test-hooks namespace (module-load installTestHooks
  // can't reach these React callbacks). The action drivers bypass canvas
  // pixel→tile geometry — the handlers still own undo/dirty/rebuild; for specs
  // that drive the real canvas gesture instead, getTileCenter projects a tile
  // to canvas CSS pixels with the renderer's own zoom + pan. Guarded on isE2E.
  useEffect(() => {
    if (!isE2E || typeof window === 'undefined') return;
    const hooks = (window.__pixelAgentsTestHooks ??= {});
    hooks.editorTileAction = (col, row) => editor.handleEditorTileAction(col, row);
    hooks.editorEraseAction = (col, row) => editor.handleEditorEraseAction(col, row);
    hooks.editorDrop = (uid, col, row, duplicate = false) =>
      editor.handleDrop(uid, col, row, { duplicate });
    hooks.getTileCenter = (col, row) => {
      const canvas = document.querySelector(`[data-testid="${OFFICE_CANVAS_TEST_ID}"]`);
      if (!canvas) return null;
      const projection = overlayProjection(
        getOfficeState().getLayout(),
        canvas.getBoundingClientRect(),
        editor.zoom,
        editor.panRef.current,
        window.devicePixelRatio || 1,
      );
      return {
        x: projection.toScreenX((col + 0.5) * TILE_SIZE),
        y: projection.toScreenY((row + 0.5) * TILE_SIZE),
      };
    };
    hooks.getShowAreas = () => effectiveShowAreas;
  }, [
    editor.handleEditorTileAction,
    editor.handleEditorEraseAction,
    editor.handleDrop,
    editor.zoom,
    editor.panRef,
    effectiveShowAreas,
  ]);

  const containerRef = useRef<HTMLDivElement>(null);

  // TV mode: the office alone, fullscreen, every control hidden (tvMode/).
  // Browser board only; while editing, T is the editor's toggle-state key.
  const tv = useTvMode({ enabled: isBrowserRuntime, keysEnabled: !editor.isEditMode });
  const { enter: enterTvMode } = tv;

  // Permission requests (and AskUserQuestion) sessions are waiting on the
  // board to answer. In TV mode on a board that may answer, each one opens
  // its own card: nothing on the TV invites the click that would.
  const approvals = usePermissionApprovals(tv.tvMode && !officeReadOnly);
  const { agentIds: approvalAgentIds, open: openApproval } = approvals;
  const enterTv = useCallback(() => {
    // The editor's panels are controls too, and its tile actions would still
    // fire on a click: leave it first (as its own Esc does; unsaved edits stay
    // in the office until saved).
    if (editor.isEditMode) editor.handleToggleEditMode();
    enterTvMode();
  }, [editor, enterTvMode]);

  // Fit: the Fit button everywhere; auto-fit (first layout, layout resize,
  // viewport resize — until the user zooms or pans) in the browser only —
  // the TV / phone board. VS Code panels keep their DPR-based default zoom.
  const cameraFit = useCameraFit({
    getOfficeState,
    containerRef,
    zoom: editor.zoom,
    setZoom: editor.handleZoomChange,
    panRef: editor.panRef,
    margins: tv.tvMode
      ? FIT_MARGINS_TV
      : isMobile
        ? FIT_MARGINS_MOBILE
        : officeReadOnly
          ? FIT_MARGINS_DESKTOP_READ_ONLY
          : FIT_MARGINS_DESKTOP,
    autoFit: isBrowserRuntime,
    layoutReady,
    isEditMode: editor.isEditMode,
  });
  // TV mode frames the whole office on entry and on every window resize.
  useTvAutoFit(tv.tvMode, cameraFit.fit);

  const [editorTickForKeyboard, setEditorTickForKeyboard] = useState(0);
  useEditorKeyboard(
    editor.isEditMode,
    editorState,
    editor.handleDeleteSelected,
    editor.handleRotateSelected,
    editor.handleToggleState,
    editor.handleUndo,
    editor.handleRedo,
    useCallback(() => setEditorTickForKeyboard((n) => n + 1), []),
    editor.handleToggleEditMode,
  );

  const handleCloseAgent = useCallback((id: number) => {
    transport.send({ type: 'closeAgent', id });
  }, []);

  const { reveal: revealTerminal } = terminalDrawer;
  const { showTerminal: showMobileTerminal } = mobileShell;
  const handleClick = useCallback(
    (agentId: number) => {
      // If clicked agent is a sub-agent, focus the parent's terminal instead
      const os = getOfficeState();
      const focusId = os.terminalOwnerOf(agentId);
      // An agent waiting on an approval opens its card instead; a relayed one
      // asking with no card (its computer never waits on the board) says why.
      const machine = os.agentSources.get(focusId)?.label;
      const action = agentClickAction({
        hasPending: approvalAgentIds.has(focusId),
        machine,
        needsPermission: os.characters.get(focusId)?.bubbleType === 'permission',
      });
      if (action === 'card') {
        openApproval(focusId);
        return;
      }
      if (action === 'setupHint' && machine !== undefined) {
        setSetupHintMachine(machine);
        return;
      }
      transport.send({ type: 'focusAgent', id: focusId });
      // Standalone: focusAgent is a no-op server-side (there's no editor to
      // raise a panel in), so focus is resolved here — reveal the agent's tab
      // (desktop drawer) and slide to the terminal page (mobile). A Teammate
      // without a terminal of its own runs in its Lead's, so it reveals that
      // one (VS Code resolves the same way server-side).
      const leadId = os.characters.get(focusId)?.leadAgentId;
      const terminalId =
        leadId !== undefined && !terminalAgentIds.includes(focusId) ? leadId : focusId;
      if (terminalAgentIds.includes(terminalId)) {
        revealTerminal(terminalId);
        if (isMobile) showMobileTerminal();
      }
    },
    [
      terminalAgentIds,
      isMobile,
      revealTerminal,
      showMobileTerminal,
      approvalAgentIds,
      openApproval,
    ],
  );

  // Card click when there is no terminal pane to switch (VS Code, or a
  // watch-only standalone session): ask the host to raise the agent's own
  // terminal — VS Code shows the editor terminal, standalone has nothing to
  // show — and select its character so the office follows the click.
  const handleCardSelect = useCallback((agentId: number) => {
    transport.send({ type: 'focusAgent', id: agentId });
    getOfficeState().selectAndFollow(agentId);
  }, []);

  const officeState = getOfficeState();

  // Merged set of Directories the Areas dropdown can map: host-contributed ones plus
  // every distinct Directory an agent has run in this session (deduped by name; name
  // is the areaMappings key / seat-bias identity, path is only the React list key).
  const areaDirectories = useMemo(() => {
    const byName = new Map<string, { name: string; path: string }>();
    for (const f of directories) byName.set(f.name, f);
    for (const name of agentDirectoryNames) {
      if (!byName.has(name)) byName.set(name, { name, path: name });
    }
    return [...byName.values()];
  }, [directories, agentDirectoryNames]);

  // The Areas the office defines, offered as a multi-select in the Directory
  // modal. Read straight off the layout (imperative state) on each render, so a
  // layout that loaded — or an Area just added in the editor — is in the list
  // the next time the modal opens.
  const areaLabels = (officeState.getLayout().areas ?? []).map((area) => area.label);

  // Areas authoring is available when the layout already defines areas, or when
  // there is at least one mappable Directory. Decouples the Areas UI from VS Code
  // multi-root workspaces (fixes single-root VS Code AND standalone, where
  // directories is always empty).
  const areasAvailable =
    (officeState.getLayout().areas?.length ?? 0) > 0 || areaDirectories.length > 0;

  const handleExportLayout = useCallback(() => {
    exportLayoutToFile(getOfficeState().getLayout());
  }, []);

  const handleImportLayout = useCallback(
    (file: File) => {
      // Browser-native import (standalone): read + validate + apply directly,
      // bypassing the layoutLoaded message whose dirty guard would skip it.
      if (
        isEditDirty() &&
        !window.confirm('Replace the current layout? Unsaved edits will be lost.')
      ) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = JSON.parse(String(reader.result)) as Record<string, unknown>;
          // Match the VS Code guard, plus the furniture-array check VS Code omits
          // (migrate + rebuild iterate furniture and would throw on a non-array).
          if (
            imported.version !== 1 ||
            !Array.isArray(imported.tiles) ||
            !Array.isArray(imported.furniture)
          ) {
            window.alert('Invalid layout file.');
            return;
          }
          const migrated = migrateLayoutColors(imported as unknown as OfficeLayout);
          getOfficeState().rebuildFromLayout(migrated);
          editor.setLastSavedLayout(migrated);
          transport.send({
            type: 'saveLayout',
            layout: migrated as unknown as Record<string, unknown>,
          });
          editor.markClean();
        } catch {
          window.alert('Failed to read or parse layout file.');
        }
      };
      reader.readAsText(file);
    },
    [isEditDirty, editor],
  );

  // Force dependency on editorTickForKeyboard to propagate keyboard-triggered re-renders
  void editorTickForKeyboard;

  // Show "Press R to rotate" hint when a rotatable item is selected or being placed
  const showRotateHint =
    editor.isEditMode &&
    (() => {
      if (editorState.selectedFurnitureUid) {
        const item = officeState
          .getLayout()
          .furniture.find((f) => f.uid === editorState.selectedFurnitureUid);
        if (item && isRotatable(item.type)) return true;
      }
      if (
        editorState.activeTool === EditTool.FURNITURE_PLACE &&
        isRotatable(editorState.placingType)
      ) {
        return true;
      }
      return false;
    })();

  if (!layoutReady) {
    return <div className="w-full h-full flex items-center justify-center ">Loading...</div>;
  }

  // The office region is shared by both shells: desktop mounts it as the
  // flexing left half of the split view (the terminal panel docks beside it);
  // mobile mounts it as the first page of the sliding track. containerRef
  // (ToolOverlay geometry) rides along either way.
  const officeRegion = (
    <div
      ref={containerRef}
      className={`relative h-full overflow-hidden ${isMobile ? 'w-full' : 'flex-1 min-w-0'}`}
    >
      <OfficeCanvas
        officeState={officeState}
        onClick={handleClick}
        isEditMode={editor.isEditMode}
        editorState={editorState}
        onEditorTileAction={editor.handleEditorTileAction}
        onEditorEraseAction={editor.handleEditorEraseAction}
        onEditorSelectionChange={editor.handleEditorSelectionChange}
        onDeleteSelected={editor.handleDeleteSelected}
        onRotateSelected={editor.handleRotateSelected}
        onDrop={editor.handleDrop}
        editorTick={editor.editorTick}
        zoom={editor.zoom}
        onZoomChange={cameraFit.userZoom}
        panRef={editor.panRef}
        showAreas={effectiveShowAreas}
        activeAreaLabel={activeAreaLabel}
        tapSelectsFirst={isMobile}
        onManualCamera={cameraFit.markManual}
      />

      {!isDebugMode ? (
        <>
          {/* Mobile: pinch replaces the zoom buttons (Fit floats top-left
                instead), and the toolbar's jobs move to the card bar (+) and
                the floating Settings button. */}
          {!isMobile && showsIn('zoomControls', tv.tvMode) && (
            <ZoomControls
              zoom={editor.zoom}
              onZoomChange={cameraFit.userZoom}
              onFit={cameraFit.fit}
              extra={isBrowserRuntime ? <TvModeButton onClick={enterTv} /> : undefined}
            />
          )}

          {/* Vignette overlay */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ background: 'var(--vignette)' }}
          />

          {editor.isEditMode && editor.isDirty && (
            <EditActionBar editor={editor} editorState={editorState} />
          )}

          {showRotateHint && (
            <div
              className="absolute left-1/2 -translate-x-1/2 z-11 bg-accent-bright text-white text-sm py-3 px-8 rounded-none border-2 border-accent shadow-pixel pointer-events-none whitespace-nowrap"
              style={{ top: editor.isDirty ? 64 : 8 }}
            >
              Rotate (R)
            </div>
          )}

          {editor.isEditMode &&
            (() => {
              const selUid = editorState.selectedFurnitureUid;
              const selColor = selUid
                ? (officeState.getLayout().furniture.find((f) => f.uid === selUid)?.color ?? null)
                : null;
              return (
                <EditorToolbar
                  activeTool={editorState.activeTool}
                  selectedTileType={editorState.selectedTileType}
                  selectedFurnitureType={editorState.placingType}
                  selectedFurnitureUid={selUid}
                  selectedFurnitureColor={selColor}
                  floorColor={editorState.floorColor}
                  wallColor={editorState.wallColor}
                  selectedWallSet={editorState.selectedWallSet}
                  onToolChange={editor.handleToolChange}
                  onTileTypeChange={editor.handleTileTypeChange}
                  onFloorColorChange={editor.handleFloorColorChange}
                  onWallColorChange={editor.handleWallColorChange}
                  onWallSetChange={editor.handleWallSetChange}
                  onSelectedFurnitureColorChange={editor.handleSelectedFurnitureColorChange}
                  pickedFurnitureColor={editorState.pickedFurnitureColor}
                  onPickedFurnitureColorChange={editor.handlePickedFurnitureColorChange}
                  onColorPickToggle={editor.handleColorPickToggle}
                  onFurnitureTypeChange={editor.handleFurnitureTypeChange}
                  loadedAssets={loadedAssets}
                  activePetTypes={officeState.getActivePetTypes()}
                  petCount={getPetCount()}
                  onPetToggle={editor.handlePetToggle}
                  carpetVariant={editor.carpetVariant}
                  carpetColor={editor.carpetColor}
                  carpetAccentColor={editor.carpetAccentColor}
                  onCarpetVariantChange={editor.handleCarpetVariantChange}
                  onCarpetColorChange={editor.handleCarpetColorChange}
                  onCarpetAccentColorChange={editor.handleCarpetAccentColorChange}
                  areas={officeState.getLayout().areas ?? []}
                  selectedAreaLabel={editor.selectedAreaLabel}
                  directories={areaDirectories}
                  areasAvailable={areasAvailable}
                  areaMappings={areaMappings}
                  onSelectArea={editor.handleSelectArea}
                  onAddArea={editor.handleAddArea}
                  onRemoveArea={editor.handleRemoveArea}
                  onRenameArea={editor.handleRenameArea}
                  onAreaColorChange={editor.handleAreaColorChange}
                  onAreaMappingChange={handleAreaMappingChange}
                />
              );
            })()}

          <ToolOverlay
            officeState={officeState}
            agents={officeAgents}
            agentTools={agentTools}
            subagentTools={subagentTools}
            subagentCharacters={subagentCharacters}
            agentProgress={agentProgress}
            agentSleep={agentSleep}
            agentTitles={agentTitles}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
            onCloseAgent={handleCloseAgent}
            alwaysShowOverlay={alwaysShowOverlay}
            compactLabels={isMobile}
            approvalAgentIds={approvalAgentIds}
            onApprovalClick={openApproval}
          />

          {/* Phase M NPCs (Ansh, the Manager): a name label on hover. */}
          <NpcOverlay
            officeState={officeState}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
          />

          {/* Ansh's errands between thoughts: his line, and the answer in a chat. */}
          <NpcSpeechOverlay
            officeState={officeState}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
          />

          {/* The limit break: the sign over the Lounge and what is said there. */}
          <LimitBreakOverlay
            officeState={officeState}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
          />

          {/* Ansh's brain: his latest thought, said in a bubble over his head. */}
          <AnshBubbleOverlay
            officeState={officeState}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
          />

          {/* Useful signals: the notice board's lines, and the tapped character's timeline. */}
          <NoticeBoardOverlay
            officeState={officeState}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
            hidden={editor.isEditMode}
          />
          {/* The server room's wall display: subscription usage + reset times. */}
          <UsageMeterOverlay
            officeState={officeState}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
            hidden={editor.isEditMode}
            readOnly={officeReadOnly}
          />
          <TimelineCard
            officeState={officeState}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
            sheet={isMobile}
            hidden={editor.isEditMode}
          />

          {/* Done-today strip. Hidden while editing: the editor toolbar takes
              the slot above the BottomToolbar that the strip uses. */}
          {!editor.isEditMode && (
            <DailyStrip
              stats={dailyStats}
              compact={isMobile}
              aboveToolbar={!isMobile && !officeReadOnly && !tv.tvMode}
              action={
                showsIn('tasksButton', tv.tvMode) ? <TasksButton compact={isMobile} /> : undefined
              }
              leading={
                <InboxStripItems
                  compact={isMobile}
                  passive={!showsIn('inboxButton', tv.tvMode)}
                  agentIds={agents}
                  agentTools={agentTools}
                  agentStatuses={agentStatuses}
                  agentProgress={agentProgress}
                  agentTitles={agentTitles}
                  backgroundAgents={backgroundAgents}
                  officeState={officeState}
                />
              }
            />
          )}

          {/* Background agents: a panel under the zoom controls (desktop,
              hidden while editing, like the strip: the editor's panels need the
              room), a "🤖 N" chip bottom-right on phones. */}
          {isMobile
            ? showsIn('remoteWorkersChip', tv.tvMode) && (
                <RemoteWorkersChip workers={remoteWorkers} />
              )
            : !editor.isEditMode && <RemoteWorkersPanel workers={remoteWorkers} />}
        </>
      ) : (
        <DebugView
          agents={agents}
          selectedAgent={selectedAgent}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          subagentTools={subagentTools}
          officeState={officeState}
          onSelectAgent={handleSelectAgent}
        />
      )}

      {/* Hooks first-run tooltip. Gated on hooksInstalled (the hooksStatus
          message), NOT the hooksEnabled preference: hooksEnabled defaults true
          while first-run consent is still pending, and announcing "Instant
          Detection Active" before anything is installed would be a lie. */}
      {showHooksTooltip && showsIn('toasts', tv.tvMode) && (
        <Tooltip
          title="Instant Detection Active"
          position="top-right"
          onDismiss={() => {
            setHooksTooltipDismissed(true);
            transport.send({ type: 'setHooksInfoShown' });
          }}
        >
          <span className="text-sm text-text leading-none">
            Your agents now respond in real-time.{' '}
            <span
              className="text-accent cursor-pointer underline"
              onClick={() => {
                setIsHooksInfoOpen(true);
                setHooksTooltipDismissed(true);
                transport.send({ type: 'setHooksInfoShown' });
              }}
            >
              View more
            </span>
          </span>
        </Tooltip>
      )}

      {officeReadOnly && showsIn('viewOnlyBanner', tv.tvMode) && (
        <div className="absolute mobile-safe-top left-1/2 -translate-x-1/2 z-10 flex items-center gap-8 text-sm text-text-muted pointer-events-none select-none whitespace-nowrap">
          View only
          {/* The agents' look is a per-browser view preference, so it stays switchable here. */}
          <AgentLookToggle />
        </div>
      )}

      {/* A read-only office gets no toolbar: launching, layout editing and every
          setting would be refused by the server anyway. */}
      {!isMobile && !officeReadOnly && showsIn('bottomToolbar', tv.tvMode) && (
        <BottomToolbar
          isEditMode={editor.isEditMode}
          onToggleEditMode={editor.handleToggleEditMode}
          isSettingsOpen={isSettingsOpen}
          onToggleSettings={() => setIsSettingsOpen((v) => !v)}
          directories={directories}
          onAddDirectory={directoryEditor.add}
          onEditDirectory={directoryEditor.edit}
          terminalAvailable={terminalAvailable}
          terminalUnavailableReason={terminalUnavailableReason}
        />
      )}

      {/* Mobile: Fit and Settings float top-left (the layout editor stays
            desktop-only — its tools are drag/hover-driven). Fit shows in a
            read-only office too: looking around is not a change. */}
      {isMobile && !isDebugMode && showsIn('settingsButton', tv.tvMode) && (
        <div className="absolute mobile-safe-top left-8 z-20 flex items-center gap-6">
          <Button
            size="sm"
            className="border-border! shadow-pixel flex items-center self-stretch"
            onClick={cameraFit.fit}
            title="Fit the whole office"
            aria-label="Fit the whole office"
          >
            <FitIcon />
          </Button>
          <TvModeButton compact onClick={enterTv} />
          {!officeReadOnly && (
            <Button
              size="sm"
              variant={isSettingsOpen ? 'active' : 'default'}
              className="border-border! shadow-pixel"
              onClick={() => setIsSettingsOpen((v) => !v)}
            >
              Settings
            </Button>
          )}
        </div>
      )}

      {showsIn('versionIndicator', tv.tvMode) && (
        <VersionIndicator
          currentVersion={extensionVersion}
          lastSeenVersion={lastSeenVersion}
          hideUpdateNotice={officeReadOnly}
          onDismiss={handleWhatsNewDismiss}
          onOpenChangelog={handleOpenChangelog}
        />
      )}

      {intro && showsIn('introBubble', tv.tvMode) && (
        <IntroBubble
          officeState={officeState}
          headline={intro.headline}
          disclosure={intro.disclosure}
          containerRef={containerRef}
          zoom={editor.zoom}
          panRef={editor.panRef}
          installFailed={installFailed}
          installPending={installPending}
          onChoice={handleConsentChoice}
          onClose={handleIntroClose}
          escapeSuppressed={
            isSettingsOpen ||
            isChangelogOpen ||
            isHooksInfoOpen ||
            showMigrationNotice ||
            editor.isEditMode
          }
        />
      )}

      <ConnectionIndicator />

      {/* TV mode's one control: Exit, top-right, while the viewer is active. */}
      {tv.tvMode && <TvExitButton visible={tv.active} onClick={tv.exit} />}
    </div>
  );

  return (
    // Desktop: split view — the office region flexes to fill the space left of
    // the terminal panel. Mobile: a column — the sliding office/terminal track
    // on top, the agent-card bar pinned along the bottom.
    // TV mode: padded by the safe-area insets; idle, the cursor hides (.tv-idle).
    <div
      className={`w-full h-full relative overflow-hidden flex ${isMobile ? 'flex-col' : ''} ${tv.tvMode && !tv.active ? 'tv-idle' : ''}`}
      style={{
        ...(isMobile && keyboard.clampHeight !== null
          ? { height: keyboard.clampHeight }
          : undefined),
        ...(tv.tvMode ? TV_SAFE_AREA_PADDING : undefined),
      }}
    >
      {isMobile ? (
        <MobileShell
          office={officeRegion}
          shell={mobileShell}
          drawer={terminalDrawer}
          agentIds={officeAgents}
          terminalAgentIds={terminalAgentIds}
          focusedAgentId={focusedAgentId}
          terminalAvailable={terminalAvailable}
          terminalUnavailableReason={terminalUnavailableReason}
          directories={directories}
          onAddDirectory={directoryEditor.add}
          onEditDirectory={directoryEditor.edit}
          onCloseAgent={handleCloseAgent}
          keyboardOpen={keyboard.keyboardOpen}
          tvMode={tv.tvMode}
        />
      ) : (
        <>
          {officeRegion}

          {/* Standalone with a terminal: terminalAvailable is only ever true when
              the server reports a working PTY to a tokened session, which VS
              Code's surface never does. In flow as a flex sibling so the office
              region reflows beside it instead of being overlaid.

              Otherwise (VS Code, or a watch-only standalone session) the card
              bar stands alone with every agent in the office, external sessions
              included — the at-a-glance "who needs attention" strip, with a
              click raising the agent's editor terminal where there is one.

              TV mode hides both: the office takes the whole width. */}
          {terminalAvailable && showsIn('terminalDrawer', tv.tvMode) ? (
            <TerminalDrawer
              agentIds={terminalAgentIds}
              shownAgentId={terminalDrawer.shownAgentId}
              onSelectAgent={terminalDrawer.select}
              onCloseAgent={handleCloseAgent}
              isOpen={terminalDrawer.isOpen}
              onClosePanel={terminalDrawer.close}
              widthPx={terminalDrawer.widthPx}
              onResizeStart={terminalDrawer.onResizeStart}
              getAppearance={terminalDrawer.getAppearance}
              statusFor={terminalDrawer.statusFor}
              onStatusChange={terminalDrawer.onStatusChange}
            />
          ) : (
            !isDebugMode &&
            showsIn('agentCardBar', tv.tvMode) && (
              <AgentCardBar
                agentIds={officeAgents}
                focusedAgentId={focusedAgentId}
                getAppearance={terminalDrawer.getAppearance}
                statusFor={terminalDrawer.statusFor}
                onSelect={handleCardSelect}
                onClose={handleCloseAgent}
              />
            )
          )}
        </>
      )}

      {/* A relayed session asking in its own terminal only: why there's no card. */}
      <Modal
        isOpen={setupHintMachine !== null}
        onClose={() => setSetupHintMachine(null)}
        title="🔐 Answer it on that computer"
        zIndex={60}
      >
        <div
          className="flex flex-col gap-6 px-10 pb-6 max-w-[560px] text-sm"
          data-testid="approval-setup-hint"
        >
          {setupHintMachine !== null &&
            remoteSetupHint(setupHintMachine).map((line) => (
              <p key={line} className="m-0">
                {line}
              </p>
            ))}
        </div>
      </Modal>

      {/* Approval card: top level, like the modals below (see there). */}
      <ApprovalCard
        card={approvals.card}
        readOnly={officeReadOnly}
        agentLabel={
          approvals.card
            ? approvalAgentLabel(
                officeState.characters.get(approvals.card.request.agentId)?.directoryName,
                agentTitles[approvals.card.request.agentId],
                officeState.agentSources.get(approvals.card.request.agentId)?.label,
              )
            : ''
        }
        onAnswer={approvals.answer}
        onClose={approvals.close}
      />

      {/* Hooks info modal. Top level, beside the other modals: inside the
          office region it would sit in the mobile shell's transformed track,
          and a transformed ancestor is the containing block of position:
          fixed — the modal would size to the 200%-wide track. */}
      <Modal
        isOpen={isHooksInfoOpen}
        onClose={() => setIsHooksInfoOpen(false)}
        title="Instant Detection is ON"
        zIndex={52}
      >
        <div className="text-base text-text px-10" style={{ lineHeight: 1.4 }}>
          <p className="mb-8">Your Pixel Agents office now reacts in real-time:</p>
          <ul className="mb-8 pl-18 list-disc m-0">
            <li className="text-sm mb-2">Permission prompts appear instantly</li>
            <li className="text-sm mb-2">Turn completions detected the moment they happen</li>
            <li className="text-sm mb-2">Sound notifications play immediately</li>
          </ul>
          <p className="mb-12 text-text-muted">
            This works through Claude Code Hooks, small event listeners that notify Pixel Agents
            whenever something happens in your Claude sessions.
          </p>
          <div className="text-center">
            <button
              onClick={() => setIsHooksInfoOpen(false)}
              className="py-4 px-20 text-lg bg-accent text-white border-2 border-accent rounded-none cursor-pointer shadow-pixel"
            >
              Got it
            </button>
          </div>
          <p className="mt-8 text-xs text-text-muted text-center">
            To disable, go to Settings {'>'} Instant Detection
          </p>
        </div>
      </Modal>
      {/* Rendered at the composition root, not inside a launch surface: the
          drawer that opens it lives in BottomToolbar on desktop and
          MobileAgentBar on mobile, and both close as soon as it appears. */}
      <DirectoryModal
        isOpen={directoryEditor.modal.open}
        editing={directoryEditor.modal.editing}
        error={directoryEditor.error}
        suggestions={directorySuggestions}
        areas={areaLabels}
        assignedAreas={directoryEditor.assignedAreas}
        onSubmit={directoryEditor.submit}
        onDelete={directoryEditor.remove}
        onClose={directoryEditor.close}
      />

      {/* The Manager's Tasks board: a viewport overlay, so top level (see above). */}
      <TasksBoard fullScreen={isMobile} canWriteReport={!officeReadOnly} />

      {/* Ansh's thoughts (a click on Ansh): a viewport overlay, so top level too. */}
      <AnshPanel readOnly={officeReadOnly} />

      <ChangelogModal
        isOpen={isChangelogOpen}
        onClose={() => setIsChangelogOpen(false)}
        currentVersion={extensionVersion}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        isDebugMode={isDebugMode}
        onToggleDebugMode={handleToggleDebugMode}
        alwaysShowOverlay={alwaysShowOverlay}
        onToggleAlwaysShowOverlay={handleToggleAlwaysShowOverlay}
        ghostHeadlessAgents={ghostHeadlessAgents}
        onToggleGhostHeadlessAgents={handleToggleGhostHeadlessAgents}
        externalAssetDirectories={externalAssetDirectories}
        watchAllSessions={watchAllSessions}
        onToggleWatchAllSessions={() => {
          const newVal = !watchAllSessions;
          setWatchAllSessions(newVal);
          transport.send({ type: 'setWatchAllSessions', enabled: newVal });
        }}
        hooksInstalled={claudeHooksInstalled}
        onToggleHooksEnabled={() => {
          // Toggle the DISPLAYED state (actual install), not the preference: when the two disagree — preference on,
          // nothing installed while consent is pending — toggling the preference would turn hooks OFF for a user
          // asking for ON. No optimistic local update either; both backends answer with the truthful hooksStatus this
          // checkbox renders, so it lands correct instead of flickering when an install fails. The providerId is
          // ECHOED from that row (never originated here), so nothing sends until the row has arrived.
          const [rowProviderId] =
            Object.entries(hooksInstalled).find(([id]) => id === 'claude') ?? [];
          if (rowProviderId !== undefined) {
            transport.send({
              type: 'setHooksEnabled',
              providerId: rowProviderId,
              enabled: !claudeHooksInstalled,
            });
          }
        }}
        showAreas={showAreas}
        onToggleShowAreas={onToggleShowAreas}
        showAreasAvailable={areasAvailable}
        bypassPermissions={bypassPermissions}
        onToggleBypassPermissions={() => {
          const newVal = !bypassPermissions;
          setBypassPermissions(newVal);
          transport.send({ type: 'setBypassPermissions', enabled: newVal });
        }}
        showHostDirectories={showHostDirectories}
        onToggleShowHostDirectories={() => {
          const newVal = !showHostDirectories;
          setShowHostDirectories(newVal);
          transport.send({ type: 'setShowHostDirectories', enabled: newVal });
        }}
        onExportLayout={handleExportLayout}
        onImportLayout={handleImportLayout}
        onEnterTvMode={isBrowserRuntime ? enterTv : undefined}
      />

      {showMigrationNotice && showsIn('toasts', tv.tvMode) && (
        <MigrationNotice onDismiss={() => setMigrationNoticeDismissed(true)} />
      )}
    </div>
  );
}

export default App;
