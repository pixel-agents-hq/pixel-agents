import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { toMajorMinor } from './changelogData.js';
import type { TabStatus } from './components/AgentCard.js';
import { AgentCardBar } from './components/AgentCardBar.js';
import { BottomToolbar } from './components/BottomToolbar.js';
import { ChangelogModal } from './components/ChangelogModal.js';
import { ConnectionIndicator } from './components/ConnectionIndicator.js';
import { DebugView } from './components/DebugView.js';
import type { DirectoryModalValues } from './components/DirectoryModal.js';
import { DirectoryModal } from './components/DirectoryModal.js';
import { EditActionBar } from './components/EditActionBar.js';
import { IntroBubble } from './components/IntroBubble.js';
import { MigrationNotice } from './components/MigrationNotice.js';
import { MobileAgentBar } from './components/MobileAgentBar.js';
import { MobileKeyBar } from './components/MobileKeyBar.js';
import { MobileTerminalPage } from './components/MobileTerminalPage.js';
import { SettingsModal } from './components/SettingsModal.js';
import { TerminalDrawer } from './components/TerminalDrawer.js';
import type { TerminalInputHandle } from './components/TerminalPane.js';
import { Tooltip } from './components/Tooltip.js';
import { Button } from './components/ui/Button.js';
import { Modal } from './components/ui/Modal.js';
import { VersionIndicator } from './components/VersionIndicator.js';
import { ZoomControls } from './components/ZoomControls.js';
import {
  MOBILE_EDGE_SWIPE_COMMIT_RATIO,
  MOBILE_EDGE_SWIPE_COMMIT_VELOCITY,
  MOBILE_EDGE_SWIPE_SLOP_PX,
  MOBILE_EDGE_SWIPE_ZONE_PX,
  MOBILE_VIEW_TRANSITION_MS,
} from './constants.js';
import { useEditorActions } from './hooks/useEditorActions.js';
import { useEditorKeyboard } from './hooks/useEditorKeyboard.js';
import type { Directory } from './hooks/useExtensionMessages.js';
import { useExtensionMessages } from './hooks/useExtensionMessages.js';
import { useIntroTour } from './hooks/useIntroTour.js';
import { useIsMobile } from './hooks/useIsMobile.js';
import { useTerminalDrawer } from './hooks/useTerminalDrawer.js';
import { useVisualViewportHeight } from './hooks/useVisualViewportHeight.js';
import { OfficeCanvas } from './office/components/OfficeCanvas.js';
import { ToolOverlay } from './office/components/ToolOverlay.js';
import { EditorState } from './office/editor/editorState.js';
import { EditorToolbar } from './office/editor/EditorToolbar.js';
import { OfficeState } from './office/engine/officeState.js';
import { exportLayoutToFile } from './office/layout/exportLayout.js';
import { isRotatable } from './office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from './office/layout/layoutSerializer.js';
import { getPetCount } from './office/sprites/petSpriteData.js';
import { EditTool, type OfficeLayout } from './office/types.js';
import { isBrowserRuntime, isE2E } from './runtime.js';
import type { TerminalConnectionStatus } from './terminal/terminalClient.js';
import { installTestHooks } from './testHooks.js';
import { transport } from './transport/index.js';

// Game state lives outside React — updated imperatively by message handlers
const officeStateRef = { current: null as OfficeState | null };
const editorState = new EditorState();

/** The Area mapping a Directory save still owes once the host accepts it. */
interface DirectoryAreaMapping {
  /** Directory name the mapping is stored under. */
  key: string;
  /** Name the entry had before this save; dropped when it differs (a rename). */
  previousKey?: string;
  areas: string[];
}

/** A Directory mutation waiting for the host's answer. `mapping` is absent for
 *  a delete, which has nothing left to write. */
interface PendingDirectorySave {
  mapping?: DirectoryAreaMapping;
}

/**
 * The name the host will store this entry under — the key its Area mapping
 * hangs on and the label its agents will wear. Mirrors the host's own fallback
 * (server/src/directories.ts): an empty name becomes the path's basename.
 */
function directoryKeyFor(values: { name: string; path: string }): string {
  if (values.name.length > 0) return values.name;
  const trimmed = values.path.replace(/[/\\]+$/, '');
  const lastSeparator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return lastSeparator === -1 ? trimmed : trimmed.slice(lastSeparator + 1);
}

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
    layoutReady,
    layoutWasReset,
    loadedAssets,
    directories,
    directoryRejection,
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
    terminalAvailable,
    terminalUnavailableReason,
    terminalAgentIds,
  } = useExtensionMessages(getOfficeState, editor.setLastSavedLayout, isEditDirty);

  // Show migration notice once layout reset is detected
  const [migrationNoticeDismissed, setMigrationNoticeDismissed] = useState(false);
  const showMigrationNotice = layoutWasReset && !migrationNoticeDismissed;

  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHooksInfoOpen, setIsHooksInfoOpen] = useState(false);
  const [hooksTooltipDismissed, setHooksTooltipDismissed] = useState(false);
  const [isDebugMode, setIsDebugMode] = useState(false);
  const [alwaysShowOverlay, setAlwaysShowOverlay] = useState(false);

  // Mobile shell: office and terminal are full-screen pages in a sliding
  // track, with the agent cards in a bottom scroller. Desktop keeps the
  // right-docked drawer. Crossing the breakpoint (rotation, window resize)
  // remounts the terminal panes; their sockets reconnect and the server
  // replays the current screen.
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<'office' | 'terminal'>('office');
  // Software-keyboard handling: clamp the shell to the visual viewport so the
  // terminal shrinks (and the PTY resizes) instead of hiding its input line
  // under the keys. null while the keyboard is closed.
  const keyboardViewportHeight = useVisualViewportHeight(isMobile);
  // Mirror the office's imperative character selection into React so the
  // mobile card bar can restyle the focused agent's card — selection changes
  // from canvas taps would otherwise never re-render the bar.
  const [focusedAgentId, setFocusedAgentId] = useState<number | null>(null);
  useEffect(() => {
    const os = getOfficeState();
    os.onSelectionChange = setFocusedAgentId;
    setFocusedAgentId(os.selectedAgentId);
    return () => {
      os.onSelectionChange = null;
    };
  }, []);

  // Terminal socket status per agent for the mobile card bar's red dot — the
  // desktop equivalent lives inside TerminalDrawer, which mobile doesn't mount.
  const [mobileConnStatuses, setMobileConnStatuses] = useState<
    Record<number, TerminalConnectionStatus>
  >({});
  const handleMobileTermStatus = useCallback(
    (agentId: number, status: TerminalConnectionStatus) => {
      setMobileConnStatuses((prev) =>
        prev[agentId] === status ? prev : { ...prev, [agentId]: status },
      );
    },
    [],
  );

  // Mobile only slides over for launches initiated from the + card
  // (pendingMobileLaunchRef): the office is the app's main screen, so a
  // reload that re-announces live sessions must land on the office, not
  // whatever terminal happens to exist.
  const pendingMobileLaunchRef = useRef(false);
  const onNewTerminal = useCallback(() => {
    if (pendingMobileLaunchRef.current) setMobileView('terminal');
    pendingMobileLaunchRef.current = false;
  }, []);

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
    onNewTerminal,
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

  // A Directory picked from the + card's drawer: launch, then slide to the new
  // terminal when the server announces it (onNewTerminal above).
  const handleMobileLaunchDirectory = useCallback((directory: Directory) => {
    pendingMobileLaunchRef.current = true;
    transport.send({ type: 'launchAgent', directoryPath: directory.path });
  }, []);

  // ── Directory management (the drawer's + / pencil) ──────
  //
  // The host owns validation, so a save is a round trip: send, then wait. The
  // rebroadcast Directory list is the success signal (it also arrives when
  // another office mutates, which is equally a reason to stop editing), and
  // directoryRejected is the failure one. pendingDirectorySaveRef is what
  // distinguishes "our save came back" from the list simply loading.
  const [directoryModal, setDirectoryModal] = useState<{
    open: boolean;
    editing: Directory | null;
  }>({ open: false, editing: null });
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const pendingDirectorySaveRef = useRef<PendingDirectorySave | null>(null);

  // The Area mapping half of a save. It only lands once the host has accepted
  // the Directory — a refused path must not leave a mapping keyed to a
  // Directory that was never created.
  const applyDirectoryAreaMapping = useCallback(
    (mapping: DirectoryAreaMapping) => {
      const next = { ...areaMappings };
      // A rename carries the mapping to the new name rather than orphaning it
      // under the old one (seat placement is keyed by Directory name).
      if (mapping.previousKey !== undefined && mapping.previousKey !== mapping.key) {
        delete next[mapping.previousKey];
      }
      if (mapping.areas.length === 0) {
        delete next[mapping.key];
      } else {
        next[mapping.key] = mapping.areas;
      }
      if (JSON.stringify(next) === JSON.stringify(areaMappings)) return;
      setAreaMappings(next);
      getOfficeState().setAreaMappings(next);
      transport.send({ type: 'saveAreaMappings', mappings: next });
    },
    [areaMappings, setAreaMappings],
  );

  useEffect(() => {
    const pending = pendingDirectorySaveRef.current;
    if (pending === null) return;
    pendingDirectorySaveRef.current = null;
    if (pending.mapping) applyDirectoryAreaMapping(pending.mapping);
    setDirectoryModal({ open: false, editing: null });
    setDirectoryError(null);
  }, [directories, applyDirectoryAreaMapping]);

  useEffect(() => {
    if (directoryRejection === null || pendingDirectorySaveRef.current === null) return;
    pendingDirectorySaveRef.current = null;
    setDirectoryError(directoryRejection.reason);
  }, [directoryRejection]);

  const handleAddDirectory = useCallback(() => {
    setDirectoryError(null);
    setDirectoryModal({ open: true, editing: null });
    // Asked per opening, not once at boot: the answer is whatever sessions are
    // on disk right now, minus the Directories that exist right now.
    transport.send({ type: 'requestDirectorySuggestions' });
  }, []);

  const handleEditDirectory = useCallback((directory: Directory) => {
    setDirectoryError(null);
    setDirectoryModal({ open: true, editing: directory });
    transport.send({ type: 'requestDirectorySuggestions' });
  }, []);

  const handleCloseDirectoryModal = useCallback(() => {
    pendingDirectorySaveRef.current = null;
    setDirectoryModal({ open: false, editing: null });
    setDirectoryError(null);
  }, []);

  const handleSubmitDirectory = useCallback(
    (values: DirectoryModalValues) => {
      const editing = directoryModal.editing;
      pendingDirectorySaveRef.current = {
        mapping: {
          key: directoryKeyFor(values),
          previousKey: editing?.name,
          areas: values.areas,
        },
      };
      setDirectoryError(null);
      transport.send({
        type: 'saveDirectory',
        name: values.name,
        path: values.path,
        // Identifies the entry being edited, so a re-pointed path replaces it
        // instead of adding a second Directory.
        ...(editing ? { previousPath: editing.path } : {}),
      });
    },
    [directoryModal.editing],
  );

  const handleDeleteDirectory = useCallback(() => {
    const editing = directoryModal.editing;
    if (!editing) return;
    // No mapping work: a deleted Directory's mapping is inert (nothing launches
    // with that name any more) and keeping it means an entry re-added under the
    // same name comes back to its Areas.
    pendingDirectorySaveRef.current = {};
    transport.send({ type: 'removeDirectory', path: editing.path });
  }, [directoryModal.editing]);

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
  // can't reach these React callbacks). Bypasses only canvas pixel→tile
  // geometry — the handlers still own undo/dirty/rebuild. Guarded on isE2E.
  useEffect(() => {
    if (!isE2E || typeof window === 'undefined') return;
    const hooks = (window.__pixelAgentsTestHooks ??= {});
    hooks.editorTileAction = (col, row) => editor.handleEditorTileAction(col, row);
    hooks.editorEraseAction = (col, row) => editor.handleEditorEraseAction(col, row);
    hooks.editorDragMove = (uid, col, row) => editor.handleDragMove(uid, col, row);
    hooks.editorDragDuplicate = (uid, col, row) => editor.handleDragDuplicate(uid, col, row);
    hooks.getShowAreas = () => effectiveShowAreas;
  }, [
    editor.handleEditorTileAction,
    editor.handleEditorEraseAction,
    editor.handleDragMove,
    editor.handleDragDuplicate,
    effectiveShowAreas,
  ]);

  const containerRef = useRef<HTMLDivElement>(null);

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
  const handleClick = useCallback(
    (agentId: number) => {
      // If clicked agent is a sub-agent, focus the parent's terminal instead
      const os = getOfficeState();
      const meta = os.subagentMeta.get(agentId);
      const focusId = meta ? meta.parentAgentId : agentId;
      transport.send({ type: 'focusAgent', id: focusId });
      // Standalone: focusAgent is a no-op server-side (there's no editor to
      // raise a panel in), so focus is resolved here — reveal the agent's tab
      // (desktop drawer) and slide to the terminal page (mobile).
      if (terminalAgentIds.includes(focusId)) {
        revealTerminal(focusId);
        if (isMobile) setMobileView('terminal');
      }
    },
    [terminalAgentIds, isMobile, revealTerminal],
  );

  // Card click when there is no terminal pane to switch (VS Code, or a
  // watch-only standalone session): ask the host to raise the agent's own
  // terminal — VS Code shows the editor terminal, standalone has nothing to
  // show — and select its character so the office follows the click.
  const handleCardSelect = useCallback((agentId: number) => {
    transport.send({ type: 'focusAgent', id: agentId });
    const os = getOfficeState();
    if (os.characters.has(agentId)) {
      os.selectedAgentId = agentId;
      os.cameraFollowId = agentId;
    }
  }, []);

  // Input handles handed up by each mobile TerminalPane, so the key bar can
  // inject bytes or paste into whichever pane is showing. A ref, not state:
  // sends are imperative and registration must not re-render the app.
  const mobileTermInputsRef = useRef(new Map<number, TerminalInputHandle>());
  const registerMobileTermInput = useCallback(
    (agentId: number, handle: TerminalInputHandle | null) => {
      if (handle) mobileTermInputsRef.current.set(agentId, handle);
      else mobileTermInputsRef.current.delete(agentId);
    },
    [],
  );
  const getMobileTermInput = useCallback(() => {
    // Mirror MobileTerminalPage's fallback: first pane when the active agent
    // has no PTY.
    const activeId = terminalDrawer.activeAgentId;
    const targetId =
      activeId !== null && terminalAgentIds.includes(activeId)
        ? activeId
        : (terminalAgentIds[0] ?? null);
    return targetId === null ? null : (mobileTermInputsRef.current.get(targetId) ?? null);
  }, [terminalDrawer.activeAgentId, terminalAgentIds]);
  const handleMobileKey = useCallback(
    (sequence: string) => getMobileTermInput()?.send(sequence),
    [getMobileTermInput],
  );
  const handleMobilePaste = useCallback(() => {
    const handle = getMobileTermInput();
    if (!handle) return;
    // Silently a no-op when the user dismisses Safari's paste-permission
    // callout or the clipboard is empty.
    navigator.clipboard.readText().then(
      (text) => {
        if (text) handle.paste(text);
      },
      () => undefined,
    );
  }, [getMobileTermInput]);

  // The >_ / Office view toggle. Entering the terminal view collapses the
  // canvas focus into the terminal selection: whoever is focused in the
  // office is the agent whose terminal shows (sub-agents resolve to their
  // parent, which owns the pane). Card taps, character double-taps, and
  // launches already keep the two in sync — this toggle was the one path
  // that could land on a different agent's terminal than the focused one.
  const handleMobileViewToggle = useCallback(() => {
    if (mobileView === 'terminal') {
      setMobileView('office');
      return;
    }
    if (focusedAgentId !== null) {
      const meta = getOfficeState().subagentMeta.get(focusedAgentId);
      const focusId = meta ? meta.parentAgentId : focusedAgentId;
      revealTerminal(focusId);
    }
    setMobileView('terminal');
  }, [mobileView, focusedAgentId, revealTerminal]);

  // Edge swipes between the two mobile pages — the gestural twin of the
  // >_ / Office toggle, so a commit runs the exact same handler (including
  // the focus-collapse). Capture listeners on the shell run before the
  // terminal's and canvas's own capture handlers, but a touch in the edge
  // strip is only CLAIMED once its movement is clearly horizontal — until
  // then everything propagates normally, so edge taps still select
  // characters or focus the terminal. While armed-but-unclaimed, only
  // preventDefault runs (suppressing iOS's own history edge-swipe); the
  // toggle button, copy pill, and selection handles opt out entirely. A
  // claimed drag moves the track 1:1 with the finger (transition off), and
  // the release either commits — transition restored, state flip animates
  // from the dragged position — or settles back.
  const mobileShellRef = useRef<HTMLDivElement | null>(null);
  const mobileTrackRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const shell = mobileShellRef.current;
    const track = mobileTrackRef.current;
    if (!isMobile || !shell || !track) return;
    const toTerminal = mobileView === 'office';
    if (toTerminal && !terminalAvailable) return;
    const baseTransform = toTerminal ? 'translateX(0)' : 'translateX(-50%)';
    const transition = `transform ${String(MOBILE_VIEW_TRANSITION_MS)}ms ease-out`;
    const sw = {
      id: -1,
      claimed: false,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastT: 0,
      velocity: 0,
      width: 0,
      armedTarget: null as EventTarget | null,
      synthetic: false,
    };
    const findT = (list: TouchList) => {
      for (let i = 0; i < list.length; i++) {
        if (list[i].identifier === sw.id) return list[i];
      }
      return null;
    };
    // Terminal rows are rebuilt on every repaint, and WebKit keeps addressing
    // a gesture's events to its touchstart node — detached, they stop
    // propagating through the shell, which both froze a claimed swipe and
    // left sw.id armed forever (blocking every later swipe). Same cure as the
    // terminal's own gestures: rescue listeners bound to the armed target
    // keep the stream, and only fire when the shell can no longer see it.
    const dMove = (e: Event) => {
      if (e.target instanceof Node && shell.contains(e.target)) return;
      onMove(e as TouchEvent);
    };
    const dEnd = (e: Event) => {
      if (e.target instanceof Node && shell.contains(e.target)) return;
      onEnd(e as TouchEvent);
    };
    const dCancel = (e: Event) => {
      if (e.target instanceof Node && shell.contains(e.target)) return;
      onCancel(e as TouchEvent);
    };
    const release = () => {
      sw.id = -1;
      sw.claimed = false;
      if (sw.armedTarget) {
        sw.armedTarget.removeEventListener('touchmove', dMove);
        sw.armedTarget.removeEventListener('touchend', dEnd);
        sw.armedTarget.removeEventListener('touchcancel', dCancel);
        sw.armedTarget = null;
      }
    };
    // When the swipe claims the gesture, tell whatever was underneath (the
    // terminal's scroll/long-press, the canvas pan) that its touch is over —
    // a real bubbling touchcancel cleans their state through the same paths
    // a system cancel would, attached or detached.
    const cancelUnderlying = (t: Touch) => {
      const target = sw.armedTarget;
      if (!target) return;
      sw.synthetic = true;
      try {
        target.dispatchEvent(
          new TouchEvent('touchcancel', {
            bubbles: true,
            changedTouches: [t],
            touches: [],
            targetTouches: [],
          }),
        );
      } catch {
        // No TouchEvent constructor: underlying gestures self-heal on their
        // next touch instead.
      }
      sw.synthetic = false;
    };
    const onStart = (e: TouchEvent) => {
      // Self-heal a stale arm whose end was never delivered (its target
      // detached before the finger lifted).
      if (sw.id !== -1 && !findT(e.touches)) release();
      if (sw.id !== -1) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const rect = shell.getBoundingClientRect();
      const inZone = toTerminal
        ? t.clientX >= rect.right - MOBILE_EDGE_SWIPE_ZONE_PX
        : t.clientX <= rect.left + MOBILE_EDGE_SWIPE_ZONE_PX;
      if (!inZone) return;
      if (e.target instanceof Element && e.target.closest('button, [data-handle]')) return;
      if (e.cancelable) e.preventDefault();
      sw.id = t.identifier;
      sw.claimed = false;
      sw.startX = t.clientX;
      sw.startY = t.clientY;
      sw.lastX = t.clientX;
      sw.lastT = e.timeStamp;
      sw.velocity = 0;
      sw.width = rect.width;
      sw.armedTarget = e.target;
      if (e.target) {
        e.target.addEventListener('touchmove', dMove, { passive: false });
        e.target.addEventListener('touchend', dEnd);
        e.target.addEventListener('touchcancel', dCancel);
      }
    };
    const onMove = (e: TouchEvent) => {
      if (sw.id === -1) return;
      const t = findT(e.changedTouches);
      if (!t) return;
      const dx = t.clientX - sw.startX;
      const dy = t.clientY - sw.startY;
      if (!sw.claimed) {
        if (Math.abs(dy) > MOBILE_EDGE_SWIPE_SLOP_PX && Math.abs(dy) >= Math.abs(dx)) {
          release(); // vertical intent — hand the touch back for good
          return;
        }
        if (Math.abs(dx) < MOBILE_EDGE_SWIPE_SLOP_PX || Math.abs(dx) <= Math.abs(dy)) return;
        sw.claimed = true;
        track.style.transition = 'none';
        cancelUnderlying(t);
      }
      e.stopPropagation();
      // The armed target may carry the terminal's own rescue listeners;
      // stopPropagation can't silence same-node listeners, this can.
      e.stopImmediatePropagation();
      if (e.cancelable) e.preventDefault();
      const dt = Math.max(1, e.timeStamp - sw.lastT);
      sw.velocity = 0.8 * ((t.clientX - sw.lastX) / dt) + 0.2 * sw.velocity;
      sw.lastX = t.clientX;
      sw.lastT = e.timeStamp;
      const offset = toTerminal
        ? Math.min(0, Math.max(-sw.width, dx))
        : Math.min(sw.width, Math.max(0, dx));
      const base = toTerminal ? 0 : -sw.width;
      track.style.transform = `translateX(${String(base + offset)}px)`;
    };
    const settleBack = () => {
      track.style.transition = transition;
      track.style.transform = baseTransform;
    };
    const onEnd = (e: TouchEvent) => {
      if (sw.id === -1 || !findT(e.changedTouches)) return;
      const { claimed, velocity, width } = sw;
      const dx = sw.lastX - sw.startX;
      release();
      if (!claimed) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      const dir = toTerminal ? -1 : 1;
      const commit =
        dx * dir > width * MOBILE_EDGE_SWIPE_COMMIT_RATIO ||
        velocity * dir > MOBILE_EDGE_SWIPE_COMMIT_VELOCITY;
      if (commit) {
        // Restore the transition, then let the view flip patch the
        // transform — the browser animates from the dragged position.
        track.style.transition = transition;
        handleMobileViewToggle();
      } else {
        settleBack();
      }
    };
    const onCancel = (e: TouchEvent) => {
      if (sw.synthetic) return;
      if (sw.id === -1 || !findT(e.changedTouches)) return;
      const { claimed } = sw;
      release();
      if (claimed) settleBack();
    };
    shell.addEventListener('touchstart', onStart, { capture: true, passive: false });
    shell.addEventListener('touchmove', onMove, { capture: true, passive: false });
    shell.addEventListener('touchend', onEnd, { capture: true });
    shell.addEventListener('touchcancel', onCancel, { capture: true });
    return () => {
      release();
      shell.removeEventListener('touchstart', onStart, { capture: true });
      shell.removeEventListener('touchmove', onMove, { capture: true });
      shell.removeEventListener('touchend', onEnd, { capture: true });
      shell.removeEventListener('touchcancel', onCancel, { capture: true });
    };
  }, [isMobile, mobileView, terminalAvailable, handleMobileViewToggle]);

  // Mobile card tap. In terminal view the bar is a tab strip: one tap
  // switches panes (external agents jump back to the office — they have no
  // pane). In office view it mirrors the character's two-step tap: first tap
  // focuses the character (camera follow + status label), a repeat tap on the
  // already-focused agent opens its terminal.
  const handleMobileCardSelect = useCallback(
    (agentId: number) => {
      const os = getOfficeState();
      const hasTerminal = terminalAgentIds.includes(agentId);
      const focusCharacter = () => {
        if (os.characters.has(agentId)) {
          os.selectedAgentId = agentId;
          os.cameraFollowId = agentId;
        }
      };

      if (mobileView === 'terminal') {
        focusCharacter();
        if (hasTerminal) {
          revealTerminal(agentId);
        } else {
          setMobileView('office');
        }
        return;
      }

      if (os.selectedAgentId === agentId && hasTerminal) {
        revealTerminal(agentId);
        setMobileView('terminal');
        return;
      }
      focusCharacter();
      // Pre-select the pane (and the card highlight) without leaving the office.
      if (hasTerminal) revealTerminal(agentId);
    },
    [terminalAgentIds, mobileView, revealTerminal],
  );

  const officeState = getOfficeState();

  // Card status for the mobile bar: connection-broken (red) wins for agents
  // whose terminal socket dropped; everything else shows live activity.
  // (Desktop's TerminalDrawer derives the same thing from its own pane state.)
  const { getActivity: getAgentActivity } = terminalDrawer;
  const mobileStatusFor = useCallback(
    (agentId: number): TabStatus | null => {
      const conn = mobileConnStatuses[agentId];
      if (terminalAgentIds.includes(agentId) && (conn === 'closed' || conn === 'reconnecting')) {
        return 'disconnected';
      }
      return getAgentActivity(agentId);
    },
    [mobileConnStatuses, terminalAgentIds, getAgentActivity],
  );

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
        isRotatable(editorState.selectedFurnitureType)
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
        onDragMove={editor.handleDragMove}
        onDragDuplicate={editor.handleDragDuplicate}
        editorTick={editor.editorTick}
        zoom={editor.zoom}
        onZoomChange={editor.handleZoomChange}
        panRef={editor.panRef}
        showAreas={effectiveShowAreas}
        activeAreaLabel={activeAreaLabel}
        tapSelectsFirst={isMobile}
      />

      {!isDebugMode ? (
        <>
          {/* Mobile: pinch replaces the zoom buttons, and the toolbar's
                jobs move to the card bar (+) and the floating Settings button. */}
          {!isMobile && <ZoomControls zoom={editor.zoom} onZoomChange={editor.handleZoomChange} />}

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
                  selectedFurnitureType={editorState.selectedFurnitureType}
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
            agents={agents}
            agentTools={agentTools}
            subagentTools={subagentTools}
            subagentCharacters={subagentCharacters}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
            onCloseAgent={handleCloseAgent}
            alwaysShowOverlay={alwaysShowOverlay}
          />
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
      {hooksEnabled && claudeHooksInstalled && !hooksInfoShown && !hooksTooltipDismissed && (
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

      {/* Hooks info modal */}
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

      {!isMobile && (
        <BottomToolbar
          isEditMode={editor.isEditMode}
          onToggleEditMode={editor.handleToggleEditMode}
          isSettingsOpen={isSettingsOpen}
          onToggleSettings={() => setIsSettingsOpen((v) => !v)}
          directories={directories}
          onAddDirectory={handleAddDirectory}
          onEditDirectory={handleEditDirectory}
          terminalAvailable={terminalAvailable}
          terminalUnavailableReason={terminalUnavailableReason}
        />
      )}

      {/* Mobile: Settings floats top-left (the layout editor stays desktop-
            only — its tools are drag/hover-driven). */}
      {isMobile && !isDebugMode && (
        <div className="absolute mobile-safe-top left-8 z-20">
          <Button
            size="sm"
            variant={isSettingsOpen ? 'active' : 'default'}
            className="border-border! shadow-pixel"
            onClick={() => setIsSettingsOpen((v) => !v)}
          >
            Settings
          </Button>
        </div>
      )}

      <VersionIndicator
        currentVersion={extensionVersion}
        lastSeenVersion={lastSeenVersion}
        onDismiss={handleWhatsNewDismiss}
        onOpenChangelog={handleOpenChangelog}
      />

      {intro && (
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
    </div>
  );

  return (
    // Desktop: split view — the office region flexes to fill the space left of
    // the terminal panel. Mobile: a column — the sliding office/terminal track
    // on top, the agent-card bar pinned along the bottom.
    <div
      className={`w-full h-full relative overflow-hidden flex ${isMobile ? 'flex-col' : ''}`}
      style={
        isMobile && keyboardViewportHeight !== null ? { height: keyboardViewportHeight } : undefined
      }
    >
      {isMobile ? (
        <>
          {/* touch-none: drags on the track (canvas margins, safe-area strip,
              terminal padding) must never start an iOS page pan — with the
              keyboard up Safari pans the layout viewport on any vertical drag
              it gets to claim, making the whole app jump. The canvas and the
              terminal panes run their own touch handling; the card bar below
              is a sibling, so its horizontal scroll is unaffected. */}
          <div ref={mobileShellRef} className="relative flex-1 min-h-0 overflow-hidden touch-none">
            {/* Sliding track: office and terminal side by side at 200% width;
                selecting a terminal slides one viewport-width left. Both pages
                keep real layout at all times (never display:none), so the
                canvas ResizeObserver and xterm's fit always see dimensions. */}
            <div
              ref={mobileTrackRef}
              className="absolute top-0 bottom-0 left-0 flex w-[200%]"
              style={{
                transform: mobileView === 'terminal' ? 'translateX(-50%)' : 'translateX(0)',
                transition: `transform ${MOBILE_VIEW_TRANSITION_MS}ms ease-out`,
              }}
            >
              <div className="w-1/2 h-full relative overflow-hidden">{officeRegion}</div>
              <div className="w-1/2 h-full">
                <MobileTerminalPage
                  agentIds={terminalAgentIds}
                  activeAgentId={terminalDrawer.activeAgentId}
                  onStatusChange={handleMobileTermStatus}
                  onRegisterInput={registerMobileTermInput}
                />
              </div>
            </div>

            {/* View toggle — pinned outside the track so it never slides. */}
            {terminalAvailable && (
              <div className="absolute mobile-safe-top right-8 z-40">
                <Button
                  size="sm"
                  className="border-border! shadow-pixel"
                  onClick={handleMobileViewToggle}
                  title={mobileView === 'office' ? 'Show terminal' : 'Show office'}
                >
                  {mobileView === 'office' ? '>_' : 'Office'}
                </Button>
              </div>
            )}
          </div>

          <MobileAgentBar
            agentIds={agents}
            focusedAgentId={focusedAgentId}
            activeTerminalAgentId={terminalDrawer.activeAgentId}
            view={mobileView}
            onSelectAgent={handleMobileCardSelect}
            onCloseAgent={handleCloseAgent}
            onLaunchDirectory={handleMobileLaunchDirectory}
            directories={directories}
            onAddDirectory={handleAddDirectory}
            onEditDirectory={handleEditDirectory}
            canLaunch={terminalAvailable}
            launchUnavailableReason={terminalUnavailableReason}
            getAppearance={terminalDrawer.getAppearance}
            statusFor={mobileStatusFor}
          />

          {/* Accessory keys for the TUI, only while the software keyboard is
              up (keyboardViewportHeight is the clamp signal) — the last flex
              child, so it sits directly above the keyboard. */}
          {mobileView === 'terminal' && keyboardViewportHeight !== null && (
            <MobileKeyBar onKey={handleMobileKey} onPaste={handleMobilePaste} />
          )}
        </>
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
              click raising the agent's editor terminal where there is one. */}
          {terminalAvailable ? (
            <TerminalDrawer
              agentIds={terminalAgentIds}
              activeAgentId={terminalDrawer.activeAgentId}
              onSelectAgent={terminalDrawer.select}
              onCloseAgent={handleCloseAgent}
              isOpen={terminalDrawer.isOpen}
              onClosePanel={terminalDrawer.close}
              widthPx={terminalDrawer.widthPx}
              onResizeStart={terminalDrawer.onResizeStart}
              getAppearance={terminalDrawer.getAppearance}
              getActivity={terminalDrawer.getActivity}
            />
          ) : (
            !isDebugMode && (
              <AgentCardBar
                agentIds={agents}
                focusedAgentId={focusedAgentId}
                getAppearance={terminalDrawer.getAppearance}
                statusFor={terminalDrawer.getActivity}
                onSelect={handleCardSelect}
                onClose={handleCloseAgent}
              />
            )
          )}
        </>
      )}

      {/* Rendered at the composition root, not inside a launch surface: the
          drawer that opens it lives in BottomToolbar on desktop and
          MobileAgentBar on mobile, and both close as soon as it appears. */}
      <DirectoryModal
        isOpen={directoryModal.open}
        editing={directoryModal.editing}
        error={directoryError}
        suggestions={directorySuggestions}
        areas={areaLabels}
        assignedAreas={
          directoryModal.editing ? (areaMappings[directoryModal.editing.name] ?? []) : []
        }
        onSubmit={handleSubmitDirectory}
        onDelete={handleDeleteDirectory}
        onClose={handleCloseDirectoryModal}
      />

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
        onExportLayout={handleExportLayout}
        onImportLayout={handleImportLayout}
      />

      {showMigrationNotice && (
        <MigrationNotice onDismiss={() => setMigrationNoticeDismissed(true)} />
      )}
    </div>
  );
}

export default App;
