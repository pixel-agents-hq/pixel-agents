import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_NAME, LAYOUT_REVISION_KEY, PIXEL_AGENTS_DIR } from './constants.js';
import { type JsonFileWatcher, watchJsonFile, writeJsonAtomic } from './jsonFileWatcher.js';

function getLayoutFilePath(): string {
  return path.join(os.homedir(), PIXEL_AGENTS_DIR, LAYOUT_FILE_NAME);
}

export function readLayoutFromFile(): Record<string, unknown> | null {
  const filePath = getLayoutFilePath();
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    console.error('[Pixel Agents] Failed to read layout file:', err);
    return null;
  }
}

/** Persist the layout (atomic; a layout watcher in this process doesn't report it back). */
export function writeLayoutToFile(layout: Record<string, unknown>): void {
  try {
    writeJsonAtomic(getLayoutFilePath(), layout);
  } catch (err) {
    console.error('[Pixel Agents] Failed to write layout file:', err);
  }
}

interface LayoutLoadResult {
  layout: Record<string, unknown>;
  /** True when the user's saved layout was replaced by a newer bundled default */
  wasReset: boolean;
}

/**
 * Load layout from file. Falls back to bundled default if the file is empty.
 * Resets to the bundled default when a newer revision is bundled.
 *
 * Migration from VS Code workspaceState happens earlier, in
 * adapters/vscode/migrateVsCodeState.ts (run on extension activate). By the
 * time this is called, the file is the only source of truth.
 *
 * 1. If file exists → return it (reset if bundled default has a newer revision)
 * 2. Else if defaultLayout provided → write to file, return it
 * 3. Else → return null
 */
export function loadLayout(
  defaultLayout?: Record<string, unknown> | null,
): LayoutLoadResult | null {
  const fromFile = readLayoutFromFile();
  if (fromFile) {
    const fileRevision = (fromFile[LAYOUT_REVISION_KEY] as number) ?? 0;
    const defaultRevision = (defaultLayout?.[LAYOUT_REVISION_KEY] as number) ?? 0;
    if (defaultRevision > fileRevision) {
      console.log(
        `[Pixel Agents] Layout revision outdated (${fileRevision} < ${defaultRevision}), resetting to bundled default`,
      );
      writeLayoutToFile(defaultLayout!);
      return { layout: defaultLayout!, wasReset: true };
    }
    console.log('[Pixel Agents] Layout loaded from file');
    return { layout: fromFile, wasReset: false };
  }

  if (defaultLayout) {
    console.log('[Pixel Agents] Writing bundled default layout to file');
    writeLayoutToFile(defaultLayout);
    return { layout: defaultLayout, wasReset: false };
  }

  return null;
}

/**
 * Watch ~/.pixel-agents/layout.json for external changes (other VS Code windows).
 */
export function watchLayoutFile(
  onExternalChange: (layout: Record<string, unknown>) => void,
): JsonFileWatcher {
  return watchJsonFile(getLayoutFilePath(), 'layout', (value) =>
    onExternalChange(value as Record<string, unknown>),
  );
}
