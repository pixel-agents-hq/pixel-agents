/**
 * Pets: the office holds at most one of each type.
 * Pure: each returns a new layout (or the same one when nothing changes).
 */

import type { OfficeLayout } from '../types.js';

/** Whether a pet of this type is in the office (one of each at most). */
export function hasPet(layout: OfficeLayout, petType: number): boolean {
  return (layout.pets ?? []).some((p) => p.petType === petType);
}

/**
 * Add a pet of `petType`, recorded under `id` (the caller mints it: this stays
 * pure). The office holds one pet of each type, so a type already there is a
 * no-op. Returns new layout (immutable).
 */
export function addPet(layout: OfficeLayout, petType: number, id: string): OfficeLayout {
  if (hasPet(layout, petType)) return layout;
  return { ...layout, pets: [...(layout.pets ?? []), { id, petType }] };
}

/** Remove the pet of `petType`. Returns new layout (immutable); no-op when there is none. */
export function removePet(layout: OfficeLayout, petType: number): OfficeLayout {
  if (!hasPet(layout, petType)) return layout;
  return { ...layout, pets: (layout.pets ?? []).filter((p) => p.petType !== petType) };
}
