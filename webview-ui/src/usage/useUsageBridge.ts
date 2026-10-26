import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { UsageBridgeStatus, UsageLimits } from '../../../core/src/messages.js';
import { USAGE_PROVIDER_ID } from '../constants.js';
import { transport } from '../transport/index.js';
import { awaitingAnswer, subscribeUsage, usageEntry } from './usageStore.js';

export interface UsageBridge {
  /** Install state; undefined until the server says (and forever on a host
   *  or a read-only office that is never told). */
  status: UsageBridgeStatus | undefined;
  /** The last known plan usage. */
  limits: UsageLimits | undefined;
  /** THIS caller's request was sent and no status has arrived since. */
  pending: boolean;
  /** Install or remove the bridge; pending until the next status arrives. */
  setEnabled: (enabled: boolean) => void;
}

/**
 * A provider's usage bridge (usageStore). Each caller keeps its own request:
 * one component's click never marks another's as pending. `onAnswer` runs
 * once when the status answering this caller's request arrives.
 */
export function useUsageBridge(
  onAnswer?: (status: UsageBridgeStatus | undefined) => void,
  providerId: string = USAGE_PROVIDER_ID,
): UsageBridge {
  const entry = useSyncExternalStore(subscribeUsage, () => usageEntry(providerId));
  const [sentAtSeq, setSentAtSeq] = useState<number | null>(null);
  const pending = awaitingAnswer(entry, sentAtSeq);
  const answered = sentAtSeq !== null && !pending;
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;
  useEffect(() => {
    if (!answered) return;
    setSentAtSeq(null);
    onAnswerRef.current?.(entry.status);
  }, [answered, entry]);
  return {
    status: entry.status,
    limits: entry.limits,
    pending,
    setEnabled: (enabled) => {
      // The status on screen when the request left: answered by a NEWER one.
      setSentAtSeq(entry.seq);
      transport.send({ type: 'setUsageBridgeEnabled', providerId, enabled });
    },
  };
}
