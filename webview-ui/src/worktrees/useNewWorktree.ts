import { useCallback, useEffect, useState } from 'react';

import type { WorktreeBranch, WorktreeOptions } from '../../../core/src/messages.js';
import type { Directory } from '../hooks/useExtensionMessages.js';
import { transport } from '../transport/index.js';

/** What the user chose for a new Worktree: its name, and the branch to start
 *  from (absent = the Directory's own base setting). */
export interface WorktreeChoices {
  name: string;
  from?: WorktreeBranch;
}

interface Asking {
  directory: Directory;
  palette?: number;
  /** null until the server's `worktreeOptions` arrives. */
  options: WorktreeOptions | null;
}

/**
 * The new-worktree modal's state: a row's worktree button opens it for its
 * Directory (wearing the roster pick, if any) and asks the server for a name
 * and the branches; Launch hands the choices to `launch` and closes it. A
 * Directory the server can't offer one for is answered `worktreeRejected`,
 * which closes it too (the rejection modal says why).
 */
export function useNewWorktree(
  launch: (directory: Directory, palette: number | undefined, choices: WorktreeChoices) => void,
) {
  const [asking, setAsking] = useState<Asking | null>(null);

  const open = useCallback((directory: Directory, palette?: number) => {
    setAsking({ directory, palette, options: null });
    transport.send({ type: 'requestWorktreeOptions', directoryPath: directory.path });
  }, []);

  const close = useCallback(() => setAsking(null), []);

  const askingPath = asking?.directory.path ?? null;
  useEffect(() => {
    if (askingPath === null) return;
    return transport.onMessage((msg) => {
      if (msg.type === 'worktreeOptions' && msg.directoryPath === askingPath) {
        setAsking((prev) =>
          prev && prev.directory.path === askingPath ? { ...prev, options: msg } : prev,
        );
      } else if (msg.type === 'worktreeRejected' && msg.directoryPath === askingPath) {
        setAsking((prev) => (prev && prev.options === null ? null : prev));
      }
    });
  }, [askingPath]);

  const submit = useCallback(
    (choices: WorktreeChoices) => {
      if (!asking) return;
      launch(asking.directory, asking.palette, choices);
      setAsking(null);
    },
    [asking, launch],
  );

  return { asking, open, close, submit };
}
