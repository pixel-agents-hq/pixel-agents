import { useEffect, useRef, useState } from 'react';

import type { Directory } from '../hooks/useExtensionMessages.js';
import { isBrowserRuntime } from '../runtime.js';
import { LaunchDrawer } from './LaunchDrawer.js';
import { Button } from './ui/Button.js';
import { PixelIcon } from './ui/PixelIcon.js';

interface BottomToolbarProps {
  isEditMode: boolean;
  onToggleEditMode: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  directories: Directory[];
  /** Drawer's pinned `+ Directory` row — opens the Directory modal empty. */
  onAddDirectory: () => void;
  /** Pencil on a user-defined row — opens the modal pre-filled. */
  onEditDirectory: (directory: Directory) => void;
  /** Standalone: server has a working PTY, so agents can be launched here. */
  terminalAvailable: boolean;
  /** Why the terminal is off (shown on the disabled button's tooltip). */
  terminalUnavailableReason: string | null;
  /** A Directory picked from the + drawer: launch into it. */
  onLaunch: (directory: Directory) => void;
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
  directories,
  onAddDirectory,
  onEditDirectory,
  terminalAvailable,
  terminalUnavailableReason,
  onLaunch,
}: BottomToolbarProps) {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const launchRef = useRef<HTMLDivElement>(null);

  // Close the launch drawer on outside press (the dropdown convention here)
  // or Escape.
  useEffect(() => {
    if (!isDrawerOpen) return;
    const handlePress = (e: PointerEvent) => {
      if (launchRef.current && !launchRef.current.contains(e.target as Node)) {
        setIsDrawerOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsDrawerOpen(false);
    };
    document.addEventListener('pointerdown', handlePress);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePress);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isDrawerOpen]);

  // A plain press never launches: it opens the drawer, and the launch happens
  // from a Directory row. Hovering opens it too, and leaving shuts it again;
  // a press pins it open until a press elsewhere, Escape, or a second press
  // on the + (the press that follows a hover pins rather than shuts).
  const drawerPinned = useRef(false);
  const handleAgentClick = () => {
    if (isDrawerOpen && drawerPinned.current) {
      setIsDrawerOpen(false);
      return;
    }
    drawerPinned.current = true;
    setIsDrawerOpen(true);
  };
  const hoverDrawer = () => {
    if (isDrawerOpen) return;
    drawerPinned.current = false;
    setIsDrawerOpen(true);
  };

  // Standalone can launch agents whenever the server has a working PTY. When it
  // doesn't, show the button disabled with the reason rather than hiding it —
  // silently missing UI reads as a bug, and the cause (a native module that
  // couldn't install) is not something a user would otherwise ever discover.
  const canLaunch = !isBrowserRuntime || terminalAvailable;
  const showUnavailable = isBrowserRuntime && !terminalAvailable;

  const handleDirectorySelect = (directory: Directory) => {
    setIsDrawerOpen(false);
    onLaunch(directory);
  };

  return (
    // Bottom-left. The terminal panel docks on the right edge, so it never
    // reaches these buttons and no lift is needed.
    <div className="absolute left-10 bottom-10 z-20 flex items-center gap-4 pixel-panel p-4">
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
            ref={launchRef}
            className="relative"
            // Hover is the desktop secondary gesture (long-press is the mobile
            // one): it opens the drawer without committing to a launch.
            onMouseEnter={hoverDrawer}
            // A pinned drawer stays open when the pointer wanders off: only a
            // press outside, Escape or a second press on the + shuts it.
            onMouseLeave={() => {
              if (!drawerPinned.current) setIsDrawerOpen(false);
            }}
          >
            <button
              type="button"
              onClick={handleAgentClick}
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
              onSelect={handleDirectorySelect}
              onAddDirectory={() => {
                setIsDrawerOpen(false);
                onAddDirectory();
              }}
              onEditDirectory={(directory) => {
                setIsDrawerOpen(false);
                onEditDirectory(directory);
              }}
            />
          </div>
        )}
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
      <Button
        variant={isSettingsOpen ? 'active' : 'default'}
        onClick={onToggleSettings}
        title="Settings"
        className={`${ROW_HEIGHT} press-juice`}
        icon="settings"
      >
        Settings
      </Button>
    </div>
  );
}
