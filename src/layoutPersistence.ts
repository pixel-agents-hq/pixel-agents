import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ExtensionContext } from "vscode";

import {
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_NAME,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  LAYOUT_REVISION_KEY,
  WORKSPACE_KEY_LAYOUT,
} from "./constants.js";

export interface LayoutWatcher {
  markOwnWrite(): void;
  dispose(): void;
}

function getLayoutFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, LAYOUT_FILE_NAME);
}

export function readLayoutFromFile(): Record<string, unknown> | null {
  const filePath = getLayoutFilePath();
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    console.error("[Pixel Agents] Failed to read layout file:", err);
    return null;
  }
}

export function writeLayoutToFile(layout: Record<string, unknown>): void {
  const filePath = getLayoutFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(layout, null, 2);
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, json, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error("[Pixel Agents] Failed to write layout file:", err);
  }
}

interface LayoutLoadResult {
  layout: Record<string, unknown>;
  /** True when the user's saved layout was replaced by a newer bundled default */
  wasReset: boolean;
}

/**
 * Load layout with migration from workspace state:
 * 1. If file exists → return it (reset if bundled default has a newer revision)
 * 2. Else if workspace state has layout → write to file, clear workspace state, return it
 * 3. Else if defaultLayout provided → write to file, return it
 * 4. Else → return null
 */
export function migrateAndLoadLayout(
  context: ExtensionContext,
  defaultLayout?: Record<string, unknown> | null,
): LayoutLoadResult | null {
  // 1. Try file — but reset if bundled default has a newer revision
  const fromFile = readLayoutFromFile();
  if (fromFile) {
    const fileRevision = (fromFile[LAYOUT_REVISION_KEY] as number) ?? 0;
    const defaultRevision =
      (defaultLayout?.[LAYOUT_REVISION_KEY] as number) ?? 0;
    if (defaultRevision > fileRevision) {
      console.log(
        `[Pixel Agents] Layout revision outdated (${fileRevision} < ${defaultRevision}), resetting to bundled default`,
      );
      writeLayoutToFile(defaultLayout!);
      return { layout: defaultLayout!, wasReset: true };
    }
    console.log("[Pixel Agents] Layout loaded from file");
    return { layout: fromFile, wasReset: false };
  }

  // 2. Migrate from workspace state
  const fromState =
    context.workspaceState.get<Record<string, unknown>>(WORKSPACE_KEY_LAYOUT);
  if (fromState) {
    console.log("[Pixel Agents] Migrating layout from workspace state to file");
    writeLayoutToFile(fromState);
    context.workspaceState.update(WORKSPACE_KEY_LAYOUT, undefined);
    return { layout: fromState, wasReset: false };
  }

  // 3. Use bundled default
  if (defaultLayout) {
    console.log("[Pixel Agents] Writing bundled default layout to file");
    writeLayoutToFile(defaultLayout);
    return { layout: defaultLayout, wasReset: false };
  }

  // 4. Nothing
  return null;
}

/**
 * Watch ~/.pixel-agents/layout.json for external changes (other VS Code windows).
 * Uses hybrid fs.watch + polling (same pattern as JSONL watching).
 */
export function watchLayoutFile(
  onExternalChange: (layout: Record<string, unknown>) => void,
): LayoutWatcher {
  const filePath = getLayoutFilePath();
  let skipNextChange = false;
  let lastMtime = 0;
  let fsWatcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  // Initialize lastMtime
  try {
    if (fs.existsSync(filePath)) {
      lastMtime = fs.statSync(filePath).mtimeMs;
    }
  } catch {
    /* ignore */
  }

  function checkForChange(): void {
    if (disposed) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs <= lastMtime) return;
      lastMtime = stat.mtimeMs;

      if (skipNextChange) {
        skipNextChange = false;
        return;
      }

      const raw = fs.readFileSync(filePath, "utf-8");
      const layout = JSON.parse(raw) as Record<string, unknown>;
      console.log("[Pixel Agents] External layout change detected");
      onExternalChange(layout);
    } catch (err) {
      console.error("[Pixel Agents] Error checking layout file:", err);
    }
  }

  function startFsWatch(): void {
    if (disposed || fsWatcher) return;
    try {
      if (!fs.existsSync(filePath)) return;
      fsWatcher = fs.watch(filePath, () => {
        checkForChange();
      });
      fsWatcher.on("error", (err) => {
        // fs.watch can be unreliable on macOS (kqueue) and may hit inotify limits on Linux
        console.log(`[Pixel Agents] Layout: fs.watch error: ${err.message}`);
        fsWatcher?.close();
        fsWatcher = null;
      });
    } catch {
      // File may not exist yet — polling will retry
    }
  }

  // Start fs.watch if file exists
  startFsWatch();

  // Polling backup (also starts fs.watch if file appears)
  pollTimer = setInterval(() => {
    if (disposed) return;
    if (!fsWatcher) {
      startFsWatch();
    }
    checkForChange();
  }, LAYOUT_FILE_POLL_INTERVAL_MS);

  return {
    markOwnWrite(): void {
      skipNextChange = true;
      // Update lastMtime preemptively so a near-instant poll doesn't miss the flag
      try {
        if (fs.existsSync(filePath)) {
          lastMtime = fs.statSync(filePath).mtimeMs;
        }
      } catch {
        /* ignore */
      }
    },
    dispose(): void {
      disposed = true;
      fsWatcher?.close();
      fsWatcher = null;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}
