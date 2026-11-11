import { ROSTER_ARROW_WIDTH_PX, ROSTER_HOVER_CLOSE_DELAY_MS } from '../constants.js';
import type { Directory } from '../hooks/useExtensionMessages.js';
import { useHoverPin } from '../hooks/useHoverPin.js';
import { popClass, usePresence } from '../hooks/usePresence.js';
import { useRosterLaunch } from '../hooks/useRosterLaunch.js';
import { isBrowserRuntime } from '../runtime.js';
import { CharacterRow } from './CharacterPicker.js';
import { LaunchDrawer } from './LaunchDrawer.js';
import { Button } from './ui/Button.js';
import { PixelIcon } from './ui/PixelIcon.js';

interface BottomToolbarProps {
  isEditMode: boolean;
  onToggleEditMode: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  /** False when the conversation sidebar holds Settings instead. */
  showSettings: boolean;
  /** The Characters view is open (the button shows active). */
  isCharactersOpen: boolean;
  /** Opens the Characters view: editing a roster card, or its `+ New`. */
  onOpenCharacters: () => void;
  directories: Directory[];
  /** Drawer's pinned `+ Directory` row — opens the Directory modal empty. */
  onAddDirectory: () => void;
  /** Pencil on a user-defined row — opens the modal pre-filled. */
  onEditDirectory: (directory: Directory) => void;
  /** Standalone: server has a working PTY, so agents can be launched here. */
  terminalAvailable: boolean;
  /** Why the terminal is off (shown on the disabled button's tooltip). */
  terminalUnavailableReason: string | null;
  /** A Directory picked from the + drawer: launch into it (wearing `palette`
   *  when a character was picked first). */
  onLaunch: (directory: Directory, palette?: number) => void;
}

/** Every toolbar button's height: the labelled ones' natural height (26 px
 *  text + padding) rounded to whole pixels, so the + can be an exact square. */
const ROW_HEIGHT = 'h-52';
/** The + launch button: a square as tall as its row, the + centred (the
 *  phone's + card, MobileAgentBar). */
const LAUNCH_SQUARE = 'size-52 flex items-center justify-center border-2 rounded-none select-none';

export function BottomToolbar({
  isEditMode,
  onToggleEditMode,
  isSettingsOpen,
  onToggleSettings,
  showSettings,
  isCharactersOpen,
  onOpenCharacters,
  directories,
  onAddDirectory,
  onEditDirectory,
  terminalAvailable,
  terminalUnavailableReason,
  onLaunch,
}: BottomToolbarProps) {
  // Standalone can launch agents whenever the server has a working PTY. When it
  // doesn't, show the button disabled with the reason rather than hiding it —
  // silently missing UI reads as a bug, and the cause (a native module that
  // couldn't install) is not something a user would otherwise ever discover.
  const canLaunch = !isBrowserRuntime || terminalAvailable;
  const showUnavailable = isBrowserRuntime && !terminalAvailable;

  // The + opens its Directory drawer; the arrow beside it opens the roster
  // above the toolbar, and a pick opens the + button's drawer for that
  // character (the phone's flow, minus the slide).
  const menus = useRosterLaunch({
    canLaunch,
    onOpenCharacters,
    escapeClosesDrawer: true,
  });
  const { isDrawerOpen, closeDrawer } = menus;

  // A plain press never launches: it opens the plain drawer (dropping any
  // roster pick, as on the phone), and the launch happens from a Directory row. Hovering opens it too, and leaving shuts it again;
  // a press pins it open until a press elsewhere, Escape, or a second press
  // on the +. A drawer the roster opened is a question waiting for an answer
  // (where to launch the picked character): the pointer wandering off doesn't
  // cancel it, only a press outside or Escape does.
  const drawerHover = useHoverPin({
    isOpen: isDrawerOpen,
    open: menus.openDrawer,
    close: closeDrawer,
    closeDelayMs: 0,
    holdOpen: () => !!menus.pendingPick,
  });

  // Hovering the arrow opens the roster, as hovering the + opens its drawer;
  // it shuts a moment after the pointer leaves both the arrow and the roster.
  // A press pins it, and a second press shuts it.
  const rosterHover = useHoverPin({
    isOpen: menus.isRosterOpen,
    open: menus.openRoster,
    close: menus.closeRoster,
    closeDelayMs: ROSTER_HOVER_CLOSE_DELAY_MS,
  });

  const handleDirectorySelect = (directory: Directory, palette?: number) => {
    closeDrawer();
    onLaunch(directory, palette);
  };

  const rosterPanel = usePresence(menus.isRosterOpen);

  return (
    // Bottom-left. The terminal panel docks on the right edge, so it never
    // reaches these buttons and no lift is needed. The column spans the
    // office so the roster above the toolbar can use its width; it passes
    // presses through everywhere but its panels.
    <div className="absolute left-10 right-10 bottom-10 z-20 flex flex-col items-start gap-4 pointer-events-none">
      {rosterPanel.mounted && (
        <div
          ref={menus.rosterRef}
          data-testid="character-picker"
          className={`pointer-events-auto max-w-full pixel-panel p-4 ${popClass(rosterPanel.closing)}`}
          onMouseEnter={rosterHover.keep}
          onMouseLeave={rosterHover.leave}
        >
          <CharacterRow
            onPick={menus.pick}
            onEdit={menus.edit}
            onNew={menus.addNew}
            isOpen={menus.isRosterOpen}
            // A scrollbar above and below the cards, drawn like the sidebar's,
            // the same gap from the cards on both sides.
            className="quiet-scrollbar-x pb-4"
            edgeScrollbars={{
              rowClassName: 'fade-stagger',
              mirrorClassName: 'quiet-scrollbar-x pt-4',
            }}
          />
        </div>
      )}
      <div className="pointer-events-auto flex items-center gap-4 pixel-panel p-4">
        {/* The + and, right of it, the roster's arrow: one card, two buttons,
            as on the phone's bar. The arrow points up while the roster is
            shut and turns down while it is open; a press toggles it. */}
        <div className="flex shrink-0">
          {showUnavailable && (
            <button
              type="button"
              disabled
              title={terminalUnavailableReason ?? 'Terminal unavailable on this server.'}
              aria-label="New agent"
              className={`${LAUNCH_SQUARE} bg-btn-bg border-border text-text-muted cursor-default opacity-(--btn-disabled-opacity)`}
            >
              <PixelIcon name="plus" />
            </button>
          )}
          {canLaunch && (
            <div
              ref={menus.launchRef}
              className="relative"
              // Hover is the desktop secondary gesture (long-press is the mobile
              // one): it opens the drawer without committing to a launch.
              onMouseEnter={drawerHover.enter}
              onMouseLeave={drawerHover.leave}
            >
              <button
                type="button"
                onClick={drawerHover.press}
                aria-label="New agent"
                title="Launch agent"
                className={`${LAUNCH_SQUARE} press-juice border-accent text-white cursor-pointer ${isDrawerOpen ? 'bg-accent-bright' : 'bg-accent hover:bg-accent-bright'}`}
              >
                {/* A quarter turn while its drawer is open (a + looks the
                    same either way, so it rests crisp). */}
                <span
                  className={`flex transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${isDrawerOpen ? 'rotate-90' : ''}`}
                >
                  <PixelIcon name="plus" />
                </span>
              </button>
              <LaunchDrawer
                isOpen={isDrawerOpen}
                directories={directories}
                pick={menus.pendingPick}
                onSelect={handleDirectorySelect}
                onAddDirectory={() => {
                  closeDrawer();
                  onAddDirectory();
                }}
                onEditDirectory={(directory) => {
                  closeDrawer();
                  onEditDirectory(directory);
                }}
              />
            </div>
          )}
          <button
            ref={menus.buttonRef}
            type="button"
            onClick={rosterHover.press}
            onMouseEnter={rosterHover.enter}
            onMouseLeave={rosterHover.leave}
            aria-label="Roster"
            aria-expanded={menus.isRosterOpen}
            title={
              menus.isRosterOpen
                ? 'Hide roster'
                : 'Launch an agent as one of your characters, or edit them'
            }
            // Enabled even when nothing can launch: a pick then edits.
            style={{ width: ROSTER_ARROW_WIDTH_PX }}
            className={`h-52 press-juice flex items-center justify-center border-2 border-l-bg/40 rounded-none select-none cursor-pointer ${
              canLaunch
                ? `border-accent text-white ${menus.isRosterOpen || isCharactersOpen ? 'bg-accent-bright' : 'bg-accent hover:bg-accent-bright'}`
                : 'bg-btn-bg border-border text-text-muted'
            }`}
          >
            <span
              className={`flex transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${menus.isRosterOpen ? '' : 'rotate-180'}`}
            >
              <PixelIcon name="down" scale={1} />
            </span>
          </button>
        </div>
        <Button
          variant={isEditMode ? 'active' : 'default'}
          onClick={onToggleEditMode}
          title="Edit office layout"
          className={`${ROW_HEIGHT} press-juice`}
          icon="layout"
        >
          Layout
        </Button>
        {showSettings && (
          <Button
            variant={isSettingsOpen ? 'active' : 'default'}
            onClick={onToggleSettings}
            title="Settings"
            className={`${ROW_HEIGHT} press-juice`}
            icon="settings"
          >
            Settings
          </Button>
        )}
      </div>
    </div>
  );
}
