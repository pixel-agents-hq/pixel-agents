import { useEffect, useReducer, useRef } from 'react';

import { castStore, useCast } from '../characters/castStore.js';
import { characterLabel, newProfile } from '../characters/profiles.js';
import type { RosterPick } from '../components/LaunchDrawer.js';
import { LAUNCH_MENUS_CLOSED, launchMenusReducer } from './launchMenus.js';

interface RosterLaunchInputs {
  /** Whether agents can be launched here; when not, a pick edits instead. */
  canLaunch: boolean;
  /** Opens the Characters view (on the cast's current character). Absent
   *  hides the roster arrow, and takes an open roster with it. */
  onOpenCharacters?: () => void;
  /** Whether Escape closes the drawer (desktop yes; the phone's drawer has
   *  no Escape). Escape always closes the roster. */
  escapeClosesDrawer: boolean;
}

/**
 * The launch button's menus, shared by the phone's card bar and the desktop
 * toolbar: its Directory drawer and, behind the roster arrow, the roster. At
 * most one is open. A pick closes the roster and opens the drawer, whose
 * launch then wears that character (`palette`, kept through the drawer's
 * closing pop so its heading stays, and replaced or dropped when it next opens); the launch button always opens the plain drawer, dropping a pick.
 * Editing and `+ New` open the Characters view on that character.
 * A press outside the open menu closes it (the drawer's boundary is
 * `launchRef`, the shell's launch button wrapper; the roster's is the roster
 * and its arrow), and so does Escape (the drawer's only where
 * `escapeClosesDrawer`).
 */
export function useRosterLaunch({
  canLaunch,
  onOpenCharacters,
  escapeClosesDrawer,
}: RosterLaunchInputs) {
  const cast = useCast();
  const [{ menu, palette }, dispatch] = useReducer(launchMenusReducer, LAUNCH_MENUS_CLOSED);
  const rosterRef = useRef<HTMLDivElement>(null);
  /** The roster arrow: its own press toggles, so it is not "outside". */
  const buttonRef = useRef<HTMLButtonElement>(null);
  /** The launch button and its drawer: a press outside closes the drawer. */
  const launchRef = useRef<HTMLDivElement>(null);

  // The arrow goes away (no Characters view to edit in); take the roster with it.
  useEffect(() => {
    if (!onOpenCharacters) dispatch({ type: 'close', which: 'roster' });
  }, [onOpenCharacters]);

  useEffect(() => {
    if (menu === 'none') return;
    const which = menu;
    const close = () => dispatch({ type: 'close', which });
    const outside = (target: EventTarget | null) =>
      menu === 'drawer'
        ? !!launchRef.current && !launchRef.current.contains(target as Node)
        : !(
            target instanceof Node &&
            (rosterRef.current?.contains(target) || buttonRef.current?.contains(target))
          );
    const handlePress = (e: PointerEvent) => {
      if (outside(e.target)) close();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (menu === 'roster' || escapeClosesDrawer)) close();
    };
    document.addEventListener('pointerdown', handlePress);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePress);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menu, escapeClosesDrawer]);

  const closeRoster = () => dispatch({ type: 'close', which: 'roster' });
  const edit = (index: number) => {
    closeRoster();
    castStore.select(index);
    onOpenCharacters?.();
  };

  return {
    isDrawerOpen: menu === 'drawer',
    isRosterOpen: menu === 'roster',
    rosterRef,
    buttonRef,
    launchRef,
    /** The pick the drawer is asking a Directory for (or, while it pops
     *  shut, was asking), if any (LaunchDrawer's `pick`). */
    pendingPick:
      palette !== null
        ? ({
            palette,
            heading: `Launch ${characterLabel(cast.profiles[palette], palette)} in`,
          } satisfies RosterPick)
        : undefined,
    /** The launch button (and desktop's hover over it): open the plain
     *  drawer, dropping any pick. */
    openDrawer: () => dispatch({ type: 'openDrawer' }),
    /** Shut the drawer (a launch, `+ Directory`, the pencil, the pointer leaving). */
    closeDrawer: () => dispatch({ type: 'close', which: 'drawer' }),
    openRoster: () => dispatch({ type: 'openRoster' }),
    closeRoster,
    /** The phone's arrow: open the roster (shutting the drawer), or shut it. */
    toggleRoster: () => dispatch({ type: 'toggleRoster' }),
    pick: (index: number) => {
      // Nowhere to launch: the pick can only mean editing it.
      if (!canLaunch) {
        edit(index);
        return;
      }
      // The launch it leads to moves it to the front of every office's
      // roster (the server records it).
      dispatch({ type: 'pick', palette: index });
    },
    edit,
    addNew: () => {
      closeRoster();
      // add() selects the new character, so the view opens on it.
      if (castStore.add([newProfile()])) onOpenCharacters?.();
    },
  };
}
