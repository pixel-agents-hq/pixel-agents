import { useRef, useState } from 'react';

import { useAgentLook } from '../hooks/useAgentLook.js';
import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
import { setAgentLook } from '../office/agentLook.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { setUsageMeterEnabled, useUsageMeter } from '../usage/usageStore.js';
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
  /** Permission posture applied by the host to every launch from this office. */
  bypassPermissions: boolean;
  onToggleBypassPermissions: () => void;
  /** Whether the launch drawer lists the host's own Directories. */
  showHostDirectories: boolean;
  onToggleShowHostDirectories: () => void;
  /** Browser-native layout export (standalone only; VS Code uses the host save dialog). */
  onExportLayout: () => void;
  /** Browser-native layout import from a chosen file (standalone only). */
  onImportLayout: (file: File) => void;
  /** Enter TV mode (fullscreen, controls hidden). Browser board only. */
  onEnterTvMode?: () => void;
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
  watchAllSessions,
  onToggleWatchAllSessions,
  hooksInstalled,
  onToggleHooksEnabled,
  showAreas,
  onToggleShowAreas,
  showAreasAvailable,
  bypassPermissions,
  onToggleBypassPermissions,
  showHostDirectories,
  onToggleShowHostDirectories,
  onExportLayout,
  onImportLayout,
  onEnterTvMode,
}: SettingsModalProps) {
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assetDirDraft, setAssetDirDraft] = useState('');
  // Agent look (Clawd / Classic): a view preference kept per browser, not a
  // server setting, so a read-only wall display can flip it too.
  const agentLook = useAgentLook();
  // The server room's usage meter: bound to the ACTUAL status line state the
  // server re-derives, never to the click (it refuses a status line of the
  // user's own).
  const usageMeter = useUsageMeter().meter;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Settings">
      {/* TV mode: the office alone, fullscreen. The modal closes with it —
          it is one of the controls TV mode hides. */}
      {onEnterTvMode && (
        <MenuItem
          onClick={() => {
            onEnterTvMode();
            onClose();
          }}
          right={<span className="text-xs text-text-muted">T</span>}
        >
          TV mode
        </MenuItem>
      )}
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
      {/* Claude Code hands the subscription's usage only to a status line, so
          the meter installs ours in ~/.claude/settings.json. */}
      {usageMeter !== null && (
        <Checkbox
          label="Usage Meter (Server Room)"
          checked={usageMeter === 'on'}
          onChange={() => setUsageMeterEnabled(usageMeter !== 'on')}
        />
      )}
      {(usageMeter === 'foreign' || usageMeter === 'unreadable') && (
        <span className="block text-xs text-text-muted px-10 pb-4">
          {usageMeter === 'foreign'
            ? 'Your ~/.claude/settings.json already has a status line. Remove it to use the meter.'
            : "~/.claude/settings.json can't be parsed, so nothing was written."}
        </span>
      )}
      {/* Agents as Clawds (Claude Code's mascot, tinted per repo) or the classic
          chibis. NPCs — Ansh, the Manager, the receptionist — stay chibis. */}
      <div className="flex items-center justify-between py-6 px-10 gap-8">
        <span>Agent Look</span>
        <span className="flex gap-4" role="radiogroup" aria-label="Agent look">
          <Button
            variant={agentLook === 'clawd' ? 'active' : 'default'}
            size="sm"
            role="radio"
            aria-checked={agentLook === 'clawd'}
            onClick={() => setAgentLook('clawd')}
            data-testid="agent-look-clawd"
          >
            Clawd
          </Button>
          <Button
            variant={agentLook === 'classic' ? 'active' : 'default'}
            size="sm"
            role="radio"
            aria-checked={agentLook === 'classic'}
            onClick={() => setAgentLook('classic')}
            data-testid="agent-look-classic"
          >
            Classic
          </Button>
        </span>
      </div>
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
      {/* Permission posture, set once instead of per launch: while on, the host
          adds the CLI's skip-permissions flag to every agent it launches. */}
      <Checkbox
        label={
          <span className="flex items-center gap-4">
            Skip Permissions
            {/* Nudged down: the pixel font's glyphs sit low in their line box,
                so a centered icon reads as floating high. */}
            <span className="material-symbols-sharp text-[12px] translate-y-2" aria-hidden="true">
              warning
            </span>
          </span>
        }
        checked={bypassPermissions}
        onChange={onToggleBypassPermissions}
      />
      {/* The host's own Directories in the launch drawer, named for what each
          host contributes: VS Code its workspace folders, standalone the
          directory the server was started from. */}
      <Checkbox
        label={isBrowserRuntime ? 'Show Start Directory' : 'Show Workspace Folders'}
        checked={showHostDirectories}
        onChange={onToggleShowHostDirectories}
      />
      <Checkbox label="Debug View" checked={isDebugMode} onChange={onToggleDebugMode} />
    </Modal>
  );
}
