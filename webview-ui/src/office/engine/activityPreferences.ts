import { OFFICE_EFFECTS_STORAGE_KEY, OFFICE_REDUCED_MOTION_QUERY } from '../../constants.js';

/** Structural browser capabilities keep the preference state importable by
 * the Node build/tests without loading drawing code or requiring lib DOM. */
interface OfficeBrowserCapabilities {
  localStorage?: { getItem(key: string): string | null };
  matchMedia?: (query: string) => { readonly matches: boolean };
}

let effectsEnabled: boolean | null = null;
let reducedMotionQuery: { readonly matches: boolean } | null = null;

function browserCapabilities(): OfficeBrowserCapabilities | undefined {
  return (globalThis as typeof globalThis & { window?: OfficeBrowserCapabilities }).window;
}

export function setOfficeEffectsEnabled(enabled: boolean): void {
  effectsEnabled = enabled;
}

export function isOfficeEffectsEnabled(): boolean {
  if (effectsEnabled === null) {
    effectsEnabled = true;
    try {
      const storage = browserCapabilities()?.localStorage;
      if (storage) effectsEnabled = storage.getItem(OFFICE_EFFECTS_STORAGE_KEY) !== 'false';
    } catch {
      // Storage may be unavailable in embedded or privacy-restricted offices.
    }
  }
  return effectsEnabled;
}

/** matches follows OS changes automatically: no listener to leak or clean up. */
export function areOfficeEffectsAnimated(): boolean {
  if (!isOfficeEffectsEnabled()) return false;
  if (!reducedMotionQuery) {
    const browser = browserCapabilities();
    if (browser?.matchMedia) reducedMotionQuery = browser.matchMedia(OFFICE_REDUCED_MOTION_QUERY);
  }
  return !reducedMotionQuery?.matches;
}
