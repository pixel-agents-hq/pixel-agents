import { useCallback, useRef, useState, useSyncExternalStore } from 'react';

import type { CliSignInStatus } from '../../../core/src/messages.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { isLoopbackHost, signInEntry, subscribeSignIn } from './signInStore.js';

export interface CliSignInControls {
  /** The server's last answer; undefined until the first. */
  status: CliSignInStatus | undefined;
  /** A request of this caller's has not been answered yet. */
  pending: boolean;
  /** The office is open on the machine the CLI runs on. */
  onHost: boolean;
  /** Ask again whether the CLI is signed in. */
  check: () => void;
  /** Start a sign-in (replacing one under way). */
  start: (account: 'subscription' | 'api') => void;
  /** Hand over the code the sign-in page ended on. */
  submitCode: (code: string) => void;
}

/**
 * A provider's CLI sign-in (signInStore), driven from the Intro's sign-in
 * step. Inside VS Code the office is on the host by construction; in a
 * browser it is when the page was opened under a loopback name. That only
 * picks the smoother of two flows (the CLI opens the browser and finishes
 * with no code), so a wrong guess costs a pasted code and decides no access.
 */
export function useCliSignIn(providerId: string | undefined): CliSignInControls {
  const id = providerId ?? '';
  const entry = useSyncExternalStore(subscribeSignIn, () => signInEntry(id));
  const [sentAtSeq, setSentAtSeq] = useState<number | null>(null);
  const seqRef = useRef(entry.seq);
  seqRef.current = entry.seq;
  const onHost = !isBrowserRuntime || isLoopbackHost(window.location.hostname);

  const check = useCallback(() => {
    if (!id) return;
    setSentAtSeq(seqRef.current);
    transport.send({ type: 'requestCliSignInStatus', providerId: id });
  }, [id]);
  const start = useCallback(
    (account: 'subscription' | 'api') => {
      if (!id) return;
      setSentAtSeq(seqRef.current);
      transport.send({ type: 'startCliSignIn', providerId: id, onHost, account });
    },
    [id, onHost],
  );
  const submitCode = useCallback(
    (code: string) => {
      if (!id) return;
      setSentAtSeq(seqRef.current);
      transport.send({ type: 'submitCliSignInCode', providerId: id, code });
    },
    [id],
  );

  return {
    status: entry.status,
    pending: sentAtSeq !== null && entry.seq === sentAtSeq,
    onHost,
    check,
    start,
    submitCode,
  };
}
