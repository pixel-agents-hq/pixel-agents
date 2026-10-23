import { useCallback, useEffect, useState } from 'react';

import type { LaunchProviderOption } from '../launchProvider.js';
import { resolveLaunchProviderId, writeStoredLaunchProvider } from '../launchProvider.js';

/**
 * The launch drawer's provider selection state, shared by BOTH launch surfaces
 * (the desktop BottomToolbar and the mobile MobileAgentBar) so the drawer
 * header can never offer the picker on one layout and silently default to
 * Claude on the other.
 *
 * Initialized from (and written back to) the per-device stored pick; a stored
 * id that no longer names a launchable provider (removed server-side) falls
 * back through resolveLaunchProviderId's precedence instead of staying
 * selected. The mobile send path resolves storage again at send time
 * (App.launchIntoDirectory), so cycling here — which persists before
 * returning — is picked up by the launch without any cross-component plumbing.
 */
export function useLaunchProviderSelection(launchProviders: LaunchProviderOption[]): {
  selectedProviderId: string | undefined;
  cycleProvider: () => void;
} {
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>(() =>
    resolveLaunchProviderId(launchProviders),
  );
  // Re-resolve when the server's launchable list arrives/changes (the first
  // capabilities message lands after mount).
  useEffect(() => {
    setSelectedProviderId((prev) =>
      prev && launchProviders.some((p) => p.id === prev)
        ? prev
        : resolveLaunchProviderId(launchProviders),
    );
  }, [launchProviders]);

  const cycleProvider = useCallback(() => {
    setSelectedProviderId((prev) => {
      const idx = launchProviders.findIndex((p) => p.id === prev);
      const next = launchProviders[(idx + 1) % Math.max(launchProviders.length, 1)];
      if (next) writeStoredLaunchProvider(next.id);
      return next?.id ?? prev;
    });
  }, [launchProviders]);

  return { selectedProviderId, cycleProvider };
}
