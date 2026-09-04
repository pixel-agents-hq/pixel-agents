import { useCallback, useEffect, useRef, useState } from 'react';

import type { DirectoryModalValues } from '../components/DirectoryModal.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { transport } from '../transport/index.js';
import type { Directory } from './useExtensionMessages.js';

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

interface DirectoryEditorInputs {
  directories: Directory[];
  directoryRejection: { reason: string } | null;
  areaMappings: Record<string, string[]>;
  setAreaMappings: (next: Record<string, string[]>) => void;
  getOfficeState: () => OfficeState;
}

/**
 * The Directory modal's state and its round trips with the host (the launch
 * drawer's + and pencil, on both shells).
 *
 * The host owns validation, so a save is a round trip: send, then wait. The
 * rebroadcast Directory list is the success signal (it also arrives when
 * another office mutates, which is equally a reason to stop editing), and
 * directoryRejected is the failure one. pendingDirectorySaveRef is what
 * distinguishes "our save came back" from the list simply loading.
 */
export function useDirectoryEditor({
  directories,
  directoryRejection,
  areaMappings,
  setAreaMappings,
  getOfficeState,
}: DirectoryEditorInputs) {
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
    [areaMappings, setAreaMappings, getOfficeState],
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

  return {
    modal: directoryModal,
    error: directoryError,
    assignedAreas: directoryModal.editing ? (areaMappings[directoryModal.editing.name] ?? []) : [],
    add: handleAddDirectory,
    edit: handleEditDirectory,
    close: handleCloseDirectoryModal,
    submit: handleSubmitDirectory,
    remove: handleDeleteDirectory,
  };
}
