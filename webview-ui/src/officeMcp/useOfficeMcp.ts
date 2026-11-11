import { useSyncExternalStore } from 'react';

import type { OfficeMcpChoice } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import {
  dismissOfficeMcpAsk,
  markOfficeMcpAnswered,
  type OfficeMcpEntry,
  officeMcpEntry,
  subscribeOfficeMcp,
} from './officeMcpStore.js';

export interface OfficeMcpControls extends OfficeMcpEntry {
  /** The Intro step's answer: sent at once (Back sends a revised one). */
  answer: (choice: OfficeMcpChoice) => void;
  /** The tour closed. Sends nothing. */
  dismiss: () => void;
  /** Settings: on (after the disclosure confirm) or off (revokes every agent's access). */
  setEnabled: (enabled: boolean) => void;
  setReadOnly: (readOnly: boolean) => void;
}

/** The Pixel Office MCP's state and the messages that change it (officeMcpStore.ts). */
export function useOfficeMcp(): OfficeMcpControls {
  const entry = useSyncExternalStore(subscribeOfficeMcp, officeMcpEntry);
  return {
    ...entry,
    answer: (choice) => {
      markOfficeMcpAnswered();
      transport.send({ type: 'officeMcpConsentResponse', choice });
    },
    dismiss: dismissOfficeMcpAsk,
    setEnabled: (enabled) => transport.send({ type: 'setOfficeMcpEnabled', enabled }),
    setReadOnly: (readOnly) => transport.send({ type: 'setOfficeMcpReadOnly', readOnly }),
  };
}
