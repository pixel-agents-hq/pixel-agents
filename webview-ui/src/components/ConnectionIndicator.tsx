import { useEffect, useState } from 'react';

import type { MessageKey } from '../i18n/index.js';
import { useT } from '../i18n/index.js';
import { transport } from '../transport/index.js';
import type { TransportState } from '../transport/types.js';

const STATE_LABELS: Partial<Record<TransportState, MessageKey>> = {
  connecting: 'app.connecting',
  reconnecting: 'app.reconnecting',
  disconnected: 'app.disconnected',
};

/**
 * Standalone connection status badge. Renders nothing while connected (the happy
 * path, and always in VS Code where the transport is permanently connected), so
 * it is invisible unless the WebSocket drops in standalone mode. Modeled on
 * VersionIndicator's absolute-overlay + pixel-panel convention.
 */
export function ConnectionIndicator() {
  const t = useT();
  const [state, setState] = useState<TransportState>(transport.state);

  useEffect(() => {
    // Re-read on mount in case the state changed before this subscribed.
    setState(transport.state);
    return transport.onStateChange(setState);
  }, []);

  if (state === 'connected') return null;

  const label = t(STATE_LABELS[state] ?? 'app.disconnected');
  const dotClass = state === 'connecting' ? 'bg-status-permission' : 'bg-status-error';

  return (
    <div className="absolute mobile-safe-top left-1/2 -translate-x-1/2 z-20 pixel-panel py-6 px-12 flex items-center gap-8 text-sm">
      <span className={`w-8 h-8 rounded-full inline-block shrink-0 ${dotClass} pixel-pulse`} />
      {label}
    </div>
  );
}
