import { useCallback, useEffect, useRef, useState } from 'react';

import type { DirectoryModalValues } from '../components/DirectoryModal.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { transport } from '../transport/index.js';
import type { Directory, DirectorySaved } from './useExtensionMessages.js';

/** The Area mapping a Directory save still owes once the host accepts it. Its
 *  key is NOT known yet: it is the name the host stores the entry under, which
 *  arrives with the host's ack (directorySaved). */
interface DirectoryAreaMapping {
  /** Name the entry had before this save; dropped when it differs (a rename). */
  previousKey?: string;
  areas: string[];
}

/** A Directory mutation waiting for the host's answer. A save is answered by
 *  its own ack (directorySaved) and carries the Area mapping to key by it; a
 *  delete has nothing left to write, and the rebroadcast list is its answer. */
type PendingDirectoryMutation =
  { kind: 'save'; mapping: DirectoryAreaMapping } | { kind: 'remove' };

interface DirectoryEditorInputs {
  directories: Directory[];
  directoryRejection: { reason: string } | null;
  directorySaved: DirectorySaved | null;
  areaMappings: Record<string, string[]>;
  setAreaMappings: (next: Record<string, string[]>) => void;
  getOfficeState: () => OfficeState;
}

/**
 * The Directory modal's state and its round trips with the host (the launch
 * drawer's + and pencil, on both shells).
 *
 * The host owns validation, so a mutation is a round trip: send, then wait.
 * A save succeeds on its ack, directorySaved, which carries the entry as the
 * host stored it — the Area mapping is keyed by that stored name, never by a
 * client-side guess at how the host resolves and names a path. A delete
 * succeeds on the rebroadcast Directory list. directoryRejected is the failure
 * signal for both. pendingDirectorySaveRef is what distinguishes "our mutation
 * came back" from the list simply loading (or another office's ack).
 */
export function useDirectoryEditor({
  directories,
  directoryRejection,
  directorySaved,
  areaMappings,
  setAreaMappings,
  getOfficeState,
}: DirectoryEditorInputs) {
  const [directoryModal, setDirectoryModal] = useState<{
    open: boolean;
    editing: Directory | null;
  }>({ open: false, editing: null });
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const pendingDirectorySaveRef = useRef<PendingDirectoryMutation | null>(null);

  // The Area mapping half of a save. It only lands once the host has accepted
  // the Directory — a refused path must not leave a mapping keyed to a
  // Directory that was never created.
  const applyDirectoryAreaMapping = useCallback(
    (mapping: DirectoryAreaMapping, key: string) => {
      const next = { ...areaMappings };
      // A rename carries the mapping to the new name rather than orphaning it
      // under the old one (seat placement is keyed by Directory name).
      if (mapping.previousKey !== undefined && mapping.previousKey !== key) {
        delete next[mapping.previousKey];
      }
      if (mapping.areas.length === 0) {
        delete next[key];
      } else {
        next[key] = mapping.areas;
      }
      if (JSON.stringify(next) === JSON.stringify(areaMappings)) return;
      setAreaMappings(next);
      getOfficeState().setAreaMappings(next);
      transport.send({ type: 'saveAreaMappings', mappings: next });
    },
    [areaMappings, setAreaMappings, getOfficeState],
  );

  const finishMutation = useCallback(() => {
    pendingDirectorySaveRef.current = null;
    setDirectoryModal({ open: false, editing: null });
    setDirectoryError(null);
  }, []);

  // A save's ack: the stored name keys the mapping. Keyed on the ack ALONE: the
  // mapping callback changes with every areaMappings update, and re-running on
  // that while a later save is pending would apply this old ack's name to it.
  useEffect(() => {
    const pending = pendingDirectorySaveRef.current;
    if (directorySaved === null || pending?.kind !== 'save') return;
    applyDirectoryAreaMapping(pending.mapping, directorySaved.directory.name);
    finishMutation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directorySaved]);

  // A delete's answer is the rebroadcast list.
  useEffect(() => {
    if (pendingDirectorySaveRef.current?.kind !== 'remove') return;
    finishMutation();
  }, [directories, finishMutation]);

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
        kind: 'save',
        mapping: { previousKey: editing?.name, areas: values.areas },
      };
      setDirectoryError(null);
      transport.send({
        type: 'saveDirectory',
        name: values.name,
        path: values.path,
        characters: values.characters,
        characterOrder: values.characterOrder,
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
    pendingDirectorySaveRef.current = { kind: 'remove' };
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
