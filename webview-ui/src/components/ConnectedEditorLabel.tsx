import {
  CONNECTED_EDITOR_JOIN,
  EDITOR_PROVIDER_DISPLAY_NAMES,
  STANDALONE_EDITOR_NAME,
} from '../constants.ts';

interface ConnectedEditorLabelProps {
  editorName: string;
  hooksInstalled: Record<string, boolean>;
}

/**
 * Standalone sends editorName "Standalone", which hides the editor whose hooks
 * are actually flowing in. Prefer installed editor providers (Cursor, …);
 * fall back to the host surface name (VS Code / Cursor / Standalone).
 */
function connectedEditorText(editorName: string, hooksInstalled: Record<string, boolean>): string {
  if (editorName === STANDALONE_EDITOR_NAME) {
    const names = Object.entries(EDITOR_PROVIDER_DISPLAY_NAMES)
      .filter(([id]) => hooksInstalled[id] === true)
      .map(([, name]) => name);
    if (names.length > 0) return names.join(CONNECTED_EDITOR_JOIN);
  }
  return editorName;
}

/**
 * Muted footer naming the editor or surface this office is connected to
 * (VS Code, Cursor, Standalone, …). Sibling of VersionIndicator.
 */
export function ConnectedEditorLabel({ editorName, hooksInstalled }: ConnectedEditorLabelProps) {
  const label = connectedEditorText(editorName, hooksInstalled);
  if (!label) return null;

  return (
    <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 text-lg text-text select-none pointer-events-none opacity-40">
      {label}
    </div>
  );
}
