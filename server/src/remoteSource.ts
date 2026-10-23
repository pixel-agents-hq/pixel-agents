/**
 * Where a relay-ingested session runs (another computer, or a cloud session).
 * remote/relay stamps `pixel_source` on every event it forwards. It is trusted
 * because the hook route requires this server's bearer token, which only local
 * processes hold — the relay authenticates the remote sender with its own key.
 */
export interface RemoteSource {
  id: string;
  label: string;
  kind: 'computer' | 'cloud';
}

export function remoteSourceOf(event: Record<string, unknown>): RemoteSource | undefined {
  const raw = event.pixel_source;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { id, label, kind } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return undefined;
  if (typeof label !== 'string' || !label) return undefined;
  if (kind !== 'computer' && kind !== 'cloud') return undefined;
  return { id, label, kind };
}
