/**
 * The launch drawer's provider selection (per device, localStorage — the same
 * posture as the mobile card order: a view preference, not server state).
 *
 * Both send surfaces read it at send time (desktop drawer, mobile bar), and
 * the drawer owns the only writer, so a cycle in one surface is picked up by
 * the next launch anywhere without cross-component state plumbing.
 */

export const LAUNCH_PROVIDER_STORAGE_KEY = 'pixel-agents.launchProviderId';

export interface LaunchProviderOption {
  id: string;
  displayName: string;
}

/** Stored pick, or '' when unset/corrupt. Validation against the live
 *  launchable list happens in the picker (a provider that vanished from the
 *  server must not stay selected). */
export function readStoredLaunchProvider(): string {
  try {
    const raw = localStorage.getItem(LAUNCH_PROVIDER_STORAGE_KEY);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

export function writeStoredLaunchProvider(providerId: string): void {
  try {
    localStorage.setItem(LAUNCH_PROVIDER_STORAGE_KEY, providerId);
  } catch {
    /* private mode / quota: selection just won't persist */
  }
}

/**
 * Resolve the provider a launch should use WITHOUT any component state
 * (the mobile bar sends through this): the stored pick when it is still
 * launchable, else Claude when available (legacy default), else the first
 * launchable one. Returns undefined when nothing is launchable — the wire
 * message then simply omits providerId and the server's own legacy default
 * decides.
 */
export function resolveLaunchProviderId(options: LaunchProviderOption[]): string | undefined {
  if (options.length === 0) return undefined;
  const stored = readStoredLaunchProvider();
  if (options.some((o) => o.id === stored)) return stored;
  if (options.some((o) => o.id === 'claude')) return 'claude';
  return options[0].id;
}
