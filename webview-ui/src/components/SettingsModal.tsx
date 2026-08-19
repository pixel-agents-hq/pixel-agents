import { useEffect, useRef, useState } from 'react';

import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';
import { MenuItem } from './ui/MenuItem.js';
import { Modal } from './ui/Modal.js';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  alwaysShowOverlay: boolean;
  onToggleAlwaysShowOverlay: () => void;
  /** Whether headless agents (adopted, no terminal to focus) render translucent. */
  ghostHeadlessAgents: boolean;
  onToggleGhostHeadlessAgents: () => void;
  externalAssetDirectories: string[];
  /** Raw persisted CLAUDE_CONFIG_DIR override; '' means unset. */
  claudeConfigDir: string;
  /** What the server actually resolves to right now (setting, env var, or default). */
  resolvedClaudeConfigDir: string;
  /** Which source produced resolvedClaudeConfigDir: 'setting' | 'env' | 'default'. */
  resolvedClaudeConfigDirSource: string;
  /** Whether resolvedClaudeConfigDir exists on disk right now. */
  resolvedClaudeConfigDirExists: boolean;
  /** Whether claudeConfigDir would resolve to an existing directory after a restart. */
  pendingDirExists: boolean;
  /** Last server-side rejection of a save. `value` is the trimmed input the
   *  server turned down; `token` changes on every rejection so re-submitting
   *  the same bad value re-fires the notice. */
  claudeConfigDirRejection?: { value: string; token: number };
  watchAllSessions: boolean;
  onToggleWatchAllSessions: () => void;
  /** ACTUAL install state (the hooksStatus message), not the hooksEnabled
   *  preference. The preference defaults to true while first-run consent is
   *  still pending, so binding the checkbox to it renders "on" over an empty
   *  ~/.claude/settings.json. */
  hooksInstalled: boolean;
  onToggleHooksEnabled: () => void;
  /** Whether the areas overlay is rendered outside of the Areas edit tool. */
  showAreas: boolean;
  onToggleShowAreas: () => void;
  /** Hide the Show Areas checkbox entirely when areas are unavailable. */
  showAreasAvailable: boolean;
  /** Browser-native layout export (standalone only; VS Code uses the host save dialog). */
  onExportLayout: () => void;
  /** Browser-native layout import from a chosen file (standalone only). */
  onImportLayout: (file: File) => void;
}

export function SettingsModal({
  isOpen,
  onClose,
  isDebugMode,
  onToggleDebugMode,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
  ghostHeadlessAgents,
  onToggleGhostHeadlessAgents,
  externalAssetDirectories,
  claudeConfigDir,
  resolvedClaudeConfigDir,
  resolvedClaudeConfigDirSource,
  resolvedClaudeConfigDirExists,
  pendingDirExists,
  claudeConfigDirRejection,
  watchAllSessions,
  onToggleWatchAllSessions,
  hooksInstalled,
  onToggleHooksEnabled,
  showAreas,
  onToggleShowAreas,
  showAreasAvailable,
  onExportLayout,
  onImportLayout,
}: SettingsModalProps) {
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assetDirDraft, setAssetDirDraft] = useState('');
  const [claudeConfigDirDraft, setClaudeConfigDirDraft] = useState(claudeConfigDir);
  const [claudeConfigDirError, setClaudeConfigDirError] = useState('');

  useEffect(() => {
    setClaudeConfigDirDraft(claudeConfigDir);
    setClaudeConfigDirError('');
  }, [claudeConfigDir]);

  const draftTrimmed = claudeConfigDirDraft.trim();
  // The server is the authority, and it turns down inputs the client-side
  // pre-check lets through (a bare `/`, or a Windows-shaped path on a POSIX
  // host). Nothing was persisted, so claudeConfigDir never changes and the
  // draft-vs-live gap that drives needsRestart would otherwise stay open
  // forever, promising a restart for a value that can never take effect.
  // Reusing claudeConfigDirError keeps the existing "error wins over the
  // restart notice" gate as the single mechanism for that.
  //
  // Deps are the rejection alone -- it changes identity on every rejection
  // message via `token`, so a repeat blur on the same bad value re-fires --
  // while draftTrimmed is read but NOT depended on, so a rejection that
  // arrives after the user has typed something else is dropped instead of
  // labelling their new draft invalid.
  useEffect(() => {
    if (claudeConfigDirRejection && claudeConfigDirRejection.value === draftTrimmed) {
      setClaudeConfigDirError('Rejected: not a valid directory');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeConfigDirRejection]);
  // A blank draft only needs a restart if a setting-sourced override is
  // CURRENTLY live -- i.e. the user is clearing a previously-active override
  // and that clearing hasn't taken effect yet. A non-blank draft needs a
  // restart whenever it hasn't taken effect yet (differs from what's live).
  const needsRestart =
    draftTrimmed === ''
      ? resolvedClaudeConfigDirSource === 'setting'
      : draftTrimmed !== resolvedClaudeConfigDir;
  // pendingDirExists describes the SAVED value, so it says nothing about a
  // draft the user is still typing. Suppress the sub-clause until the draft
  // has been blurred/saved and the server has echoed it back as
  // claudeConfigDir -- otherwise typing "/" flashes an existence verdict
  // that belongs to a completely different path.
  const draftMatchesSaved = draftTrimmed === claudeConfigDir;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Settings">
      {/* Open Sessions Folder opens an OS file manager — impossible in the browser. */}
      {!isBrowserRuntime && (
        <MenuItem
          onClick={() => {
            transport.send({ type: 'openSessionsFolder' });
            onClose();
          }}
        >
          Open Sessions Folder
        </MenuItem>
      )}
      <MenuItem
        onClick={() => {
          if (isBrowserRuntime) {
            onExportLayout();
          } else {
            transport.send({ type: 'exportLayout' });
          }
          onClose();
        }}
      >
        Export Layout
      </MenuItem>
      <MenuItem
        onClick={() => {
          if (isBrowserRuntime) {
            // Open the native file picker; the import is applied in onChange below.
            fileInputRef.current?.click();
          } else {
            transport.send({ type: 'importLayout' });
            onClose();
          }
        }}
      >
        Import Layout
      </MenuItem>
      {isBrowserRuntime && (
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset the value so re-selecting the same file fires change again.
            e.target.value = '';
            if (file) {
              onImportLayout(file);
              onClose();
            }
          }}
        />
      )}
      {/* Browser has no native directory picker, so accept a typed absolute path. */}
      {isBrowserRuntime ? (
        <div className="flex items-center gap-4 py-4 px-10">
          <input
            type="text"
            value={assetDirDraft}
            placeholder="Absolute asset directory path"
            onChange={(e) => setAssetDirDraft(e.target.value)}
            className="flex-1 min-w-0 text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
          />
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              const path = assetDirDraft.trim();
              if (!path) return;
              transport.send({ type: 'addExternalAssetDirectory', path });
              setAssetDirDraft('');
            }}
            className="shrink-0"
          >
            Add
          </Button>
        </div>
      ) : (
        <MenuItem
          onClick={() => {
            transport.send({ type: 'addExternalAssetDirectory' });
            onClose();
          }}
        >
          Add Asset Directory
        </MenuItem>
      )}
      {externalAssetDirectories.map((dir) => (
        <div key={dir} className="flex items-center justify-between py-4 px-10 gap-8">
          <span
            className="text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap"
            title={dir}
          >
            {dir.split(/[/\\]/).pop() ?? dir}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => transport.send({ type: 'removeExternalAssetDirectory', path: dir })}
            className="shrink-0"
          >
            x
          </Button>
        </div>
      ))}
      <div className="flex flex-col gap-4 py-4 px-10">
        <div className="flex items-center gap-4">
          <input
            type="text"
            aria-label="Claude config directory"
            value={claudeConfigDirDraft}
            placeholder="Claude config directory (blank = default)"
            onChange={(e) => {
              setClaudeConfigDirDraft(e.target.value);
              // Clear the rejection notice the moment the user starts fixing it.
              setClaudeConfigDirError('');
            }}
            onBlur={() => {
              // Nothing to save when the field still holds the persisted value;
              // tabbing through an untouched field shouldn't cost a round trip.
              if (draftMatchesSaved) {
                setClaudeConfigDirError('');
                return;
              }
              // Light pre-check only -- authoritative validation is server-side
              // (see clientMessageHandler.ts's applySetClaudeConfigDir), since
              // expanding a leading ~ requires knowing the SERVER's home
              // directory, which the browser tab this modal renders in
              // doesn't have access to. Accepts POSIX roots, a bare/leading
              // `~`, a Windows drive letter (`C:\` or `C:/`), and UNC
              // (`\\server\share`) -- the shapes path.isAbsolute() can call
              // absolute on either platform.
              const looksAbsolute = /^(\/|~$|~[/\\]|[A-Za-z]:[/\\]|\\\\)/.test(draftTrimmed);
              if (draftTrimmed !== '' && !looksAbsolute) {
                setClaudeConfigDirError('Must be an absolute path');
                return;
              }
              setClaudeConfigDirError('');
              transport.send({ type: 'setClaudeConfigDir', claudeConfigDir: draftTrimmed });
            }}
            className="flex-1 min-w-0 text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
          />
        </div>
        {claudeConfigDirError !== '' && (
          <span className="text-xs text-status-error">{claudeConfigDirError}</span>
        )}
        {resolvedClaudeConfigDir !== '' && (
          <span className="text-xs text-text-muted">
            {resolvedClaudeConfigDirSource === 'setting' &&
              `Using configured path: ${resolvedClaudeConfigDir}`}
            {resolvedClaudeConfigDirSource === 'env' &&
              `Using $CLAUDE_CONFIG_DIR: ${resolvedClaudeConfigDir}`}
            {resolvedClaudeConfigDirSource === 'default' &&
              `Using ${resolvedClaudeConfigDir} (default)`}
            {!resolvedClaudeConfigDirExists && ' — does not exist on disk'}
          </span>
        )}
        {/* The error wins: a draft the pre-check rejected was never sent, so
            there is nothing pending to restart for. Showing "this is invalid"
            and "restart to apply" side by side just reads as a contradiction. */}
        {needsRestart && claudeConfigDirError === '' && (
          <span className="text-xs text-text-muted">
            Restart Pixel Agents to apply
            {draftMatchesSaved && !pendingDirExists && ' — this directory does not exist yet'}
          </span>
        )}
      </div>
      <Checkbox
        label="Sound Notifications"
        checked={soundLocal}
        onChange={() => {
          const newVal = !isSoundEnabled();
          setSoundEnabled(newVal);
          setSoundLocal(newVal);
          transport.send({ type: 'setSoundEnabled', enabled: newVal });
        }}
      />
      <Checkbox
        label="Watch All Sessions"
        checked={watchAllSessions}
        onChange={onToggleWatchAllSessions}
      />
      <Checkbox
        label="Instant Detection (Hooks)"
        checked={hooksInstalled}
        onChange={onToggleHooksEnabled}
      />
      <Checkbox
        label="Always Show Labels"
        checked={alwaysShowOverlay}
        onChange={onToggleAlwaysShowOverlay}
      />
      {/* Headless agents are the office's only terminal-less citizens in VS Code.
          Standalone has no terminals at all, so nothing there would ever ghost. */}
      {!isBrowserRuntime && (
        <Checkbox
          label="Display Headless as Ghosts"
          checked={ghostHeadlessAgents}
          onChange={onToggleGhostHeadlessAgents}
        />
      )}
      {showAreasAvailable && (
        <Checkbox label="Show Areas" checked={showAreas} onChange={onToggleShowAreas} />
      )}
      <Checkbox label="Debug View" checked={isDebugMode} onChange={onToggleDebugMode} />
    </Modal>
  );
}
