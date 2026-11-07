import { useCallback, useEffect, useRef, useState } from 'react';

import type { WorkspaceModalValues } from '../components/WorkspaceModal.js';
import { transport } from '../transport/index.js';
import type { PendingWorkspaceMutation, Workspace } from '../workspaces.js';
import { isMutationApplied } from '../workspaces.js';
import type { WorkspaceRejection } from './useExtensionMessages.js';

interface WorkspaceEditorInputs {
  workspaces: Workspace[] | null;
  workspaceRejection: WorkspaceRejection | null;
}

/**
 * The Workspace modal's state and its round trips with the server (the
 * switcher's `+` and pencil, on both shells).
 *
 * The server owns validation, so a write is a round trip: send, then wait. The
 * only failure signal is workspaceRejected; success is the rebroadcast list
 * containing what was sent (`isMutationApplied`) — not just any rebroadcast,
 * because another office's change also produces one and must not close a modal
 * whose own write is still pending.
 */
export function useWorkspaceEditor({ workspaces, workspaceRejection }: WorkspaceEditorInputs) {
  const [modal, setModal] = useState<{ open: boolean; editing: Workspace | null }>({
    open: false,
    editing: null,
  });
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<PendingWorkspaceMutation | null>(null);

  const finish = useCallback(() => {
    pendingRef.current = null;
    setModal({ open: false, editing: null });
    setError(null);
  }, []);

  useEffect(() => {
    const pending = pendingRef.current;
    if (pending === null || workspaces === null) return;
    if (isMutationApplied(pending, workspaces)) finish();
  }, [workspaces, finish]);

  useEffect(() => {
    if (workspaceRejection === null || pendingRef.current === null) return;
    pendingRef.current = null;
    setError(workspaceRejection.reason);
  }, [workspaceRejection]);

  const open = useCallback((editing: Workspace | null) => {
    pendingRef.current = null;
    setError(null);
    setModal({ open: true, editing });
  }, []);

  const close = useCallback(() => {
    pendingRef.current = null;
    setModal({ open: false, editing: null });
    setError(null);
  }, []);

  const submit = useCallback(
    (values: WorkspaceModalValues) => {
      const id = modal.editing?.id;
      pendingRef.current = { kind: 'save', id, ...values };
      setError(null);
      transport.send({
        type: 'saveWorkspace',
        ...(id !== undefined ? { id } : {}),
        name: values.name,
        directoryPaths: values.directoryPaths,
      });
    },
    [modal.editing],
  );

  const remove = useCallback(() => {
    const id = modal.editing?.id;
    if (id === undefined) return;
    pendingRef.current = { kind: 'remove', id };
    transport.send({ type: 'removeWorkspace', id });
  }, [modal.editing]);

  return {
    modal,
    error,
    create: useCallback(() => open(null), [open]),
    edit: useCallback((workspace: Workspace) => open(workspace), [open]),
    close,
    submit,
    remove,
  };
}
