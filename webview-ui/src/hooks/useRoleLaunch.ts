import { useCallback, useEffect, useRef, useState } from 'react';

import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import type { RoleLaunchEvent, RoleLaunchState } from '../roleLaunch.js';
import { ROLE_LAUNCH_IDLE, roleLaunchReducer, rolePickerAvailable } from '../roleLaunch.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import type { Directory } from './useExtensionMessages.js';

interface RoleLaunchInputs {
  bypassPermissions: boolean;
  /** The operator dismissed the flow without launching. */
  onCancel?: () => void;
}

/**
 * Wires the roleLaunch reducer to React and the transport. Where a Role picker
 * cannot exist (the VS Code panel), `begin` sends the plain launchAgent
 * exactly as before.
 */
export function useRoleLaunch({ bypassPermissions, onCancel }: RoleLaunchInputs) {
  const [state, setState] = useState<RoleLaunchState>(ROLE_LAUNCH_IDLE);
  const stateRef = useRef<RoleLaunchState>(ROLE_LAUNCH_IDLE);
  const bypassRef = useRef(bypassPermissions);
  bypassRef.current = bypassPermissions;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const dispatch = useCallback((event: RoleLaunchEvent) => {
    const result = roleLaunchReducer(stateRef.current, event);
    stateRef.current = result.state;
    setState(result.state);
    for (const message of result.send) transport.send(message as ClientMessage);
  }, []);

  useEffect(() => {
    if (!rolePickerAvailable(isBrowserRuntime)) return;
    return transport.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case 'rolesAvailable':
        case 'roleConfirmed':
        case 'roleRejected':
          dispatch({ type: msg.type, msg } as RoleLaunchEvent);
          break;
        case 'rolePreview':
          dispatch({ type: 'rolePreview', msg, bypassPermissions: bypassRef.current });
          break;
        case 'agentCreated':
          dispatch({ type: 'agentCreated', roleName: msg.roleName });
          break;
      }
    });
  }, [dispatch]);

  const begin = useCallback(
    (directory: Directory) => {
      if (!rolePickerAvailable(isBrowserRuntime)) {
        transport.send({ type: 'launchAgent', directoryPath: directory.path });
        return;
      }
      dispatch({ type: 'begin', directoryPath: directory.path });
    },
    [dispatch],
  );

  const cancel = useCallback(() => {
    dispatch({ type: 'cancel' });
    onCancelRef.current?.();
  }, [dispatch]);

  return {
    state,
    begin,
    pickRole: useCallback((roleId: string) => dispatch({ type: 'pickRole', roleId }), [dispatch]),
    pickNoRole: useCallback(() => dispatch({ type: 'pickNoRole' }), [dispatch]),
    confirm: useCallback(() => dispatch({ type: 'confirm' }), [dispatch]),
    back: useCallback(() => dispatch({ type: 'back' }), [dispatch]),
    cancel,
  };
}
