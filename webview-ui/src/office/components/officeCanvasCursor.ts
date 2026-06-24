// webview-ui/src/office/components/officeCanvasCursor.ts
//
// Pure cursor resolver for the OfficeCanvas in normal (non-edit) mode.
// Decision cascade: character hit → pet hit → seat-reassign hit → default.
// All callers pass closures over the OfficeState — no direct coupling.

export interface OfficeCursorTile {
  col: number;
  row: number;
}

export interface OfficeCursorSeat {
  assigned: unknown;
}

export interface OfficeCursorCharacter {
  seatId: string | null;
}

export interface OfficeCursorState {
  hitId: number | null;
  petId: string | null;
  selectedAgentId: number | null;
  tile: OfficeCursorTile | null;
  getSeatAtTile: (col: number, row: number) => string | null;
  getSeat: (seatId: string) => OfficeCursorSeat | undefined;
  getCharacter: (id: number) => OfficeCursorCharacter | undefined;
}

export type OfficeCursor = 'pointer' | 'default';

export function computeNormalModeCursor(state: OfficeCursorState): OfficeCursor {
  // 1. Direct character hit → pointer.
  if (state.hitId !== null) {
    return 'pointer';
  }

  // 2. Pet hit → pointer. Explicit !== null so empty-string id still counts as a hit.
  if (state.petId !== null) {
    return 'pointer';
  }

  // 3. Seat-reassignment hover — when a character is selected and the hovered
  //    tile is either an unassigned seat OR the selected character's own seat.
  if (state.selectedAgentId !== null && state.tile) {
    const seatId = state.getSeatAtTile(state.tile.col, state.tile.row);
    if (seatId) {
      const seat = state.getSeat(seatId);
      if (seat) {
        const selectedCh = state.getCharacter(state.selectedAgentId);
        if (!seat.assigned || (selectedCh && selectedCh.seatId === seatId)) {
          return 'pointer';
        }
      }
    }
  }

  return 'default';
}
