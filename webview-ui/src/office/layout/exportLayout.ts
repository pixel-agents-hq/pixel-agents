import { LAYOUT_EXPORT_FILENAME, LAYOUT_EXPORT_MIME } from '../../constants.js';
import type { OfficeLayout } from '../types.js';

/**
 * Browser-native layout export (standalone mode, where there is no host save
 * dialog). Serializes a snapshot of the layout and triggers a file download.
 *
 * `getLayout()` returns a live reference, so the caller must pass the layout to
 * snapshot at click time; `JSON.stringify` here captures it immediately, so any
 * later edits cannot mutate the exported blob.
 */
export function exportLayoutToFile(layout: OfficeLayout): void {
  const json = JSON.stringify(layout, null, 2);
  const blob = new Blob([json], { type: LAYOUT_EXPORT_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = LAYOUT_EXPORT_FILENAME;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Defer revocation so the click-driven download has started first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
