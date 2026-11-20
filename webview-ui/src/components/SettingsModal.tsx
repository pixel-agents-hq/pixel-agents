import { useEffect, useRef, useState } from 'react';

import { officeRadio } from '../music/musicEngine.js';
import { useOfficeRadio } from '../music/useOfficeRadio.js';
import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
import { useOfficeMcp } from '../officeMcp/useOfficeMcp.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { useUsageBridge } from '../usage/useUsageBridge.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';
import { MenuItem } from './ui/MenuItem.js';
import { Modal } from './ui/Modal.js';
import { PixelIcon } from './ui/PixelIcon.js';

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
  /** Where the host saves files sent to a terminal; null hides the field (no
   *  terminal here to send files to). */
  uploadDirectory: { path: string } | null;
  /** Browser-native layout export (standalone only; VS Code uses the host save dialog). */
  onExportLayout: () => void;
  /** Browser-native layout import from a chosen file (standalone only). */
  onImportLayout: (file: File) => void;
  /** Settings → Play the Tutorial: opens the tutorial's ask (absent: no
   *  tutorial on this server, or one is running). */
  onPlayTutorial?: () => void;
  /** Settings → Replay the Intro: the first-run tour again, its choices
   *  starting from what is on now (absent: not offered here). */
  onReplayIntro?: () => void;
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
  uploadDirectory,
  onExportLayout,
  onImportLayout,
  onPlayTutorial,
  onReplayIntro,
}: SettingsModalProps) {
  // The office radio's player is a per-browser setting the radio keeps itself.
  const radio = useOfficeRadio();
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assetDirDraft, setAssetDirDraft] = useState('');
  // Usage Bars: installing rewrites the user's status line, so it asks first
  // with the server's own disclosure. Pending until the server answers with
  // the install state (no optimistic tick, like the hooks row). The state
  // (usageBridgeStatus) undefined hides the row: this host was not told, or
  // has no usage bridge.
  const [confirmUsageBars, setConfirmUsageBars] = useState(false);
  const { status: usageBridge, pending: usagePending, setEnabled: setUsageBars } = useUsageBridge();
  // The Pixel Office MCP: shown only where the server offers it (its status
  // arrived). Turning it on confirms with the server's disclosure, as the
  // Intro step does; off and read-only apply at once to running agents. No
  // optimistic tick: the rows follow the officeMcpStatus every office gets.
  const [confirmOfficeMcp, setConfirmOfficeMcp] = useState(false);
  const officeMcp = useOfficeMcp();
  const officeMcpOn = officeMcp.status?.consent === 'granted';

  return (
    <>
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
        {onPlayTutorial && (
          <MenuItem
            onClick={() => {
              onPlayTutorial();
              onClose();
            }}
          >
            Play the Tutorial
          </MenuItem>
        )}
        {onReplayIntro && (
          <MenuItem
            onClick={() => {
              onReplayIntro();
              onClose();
            }}
          >
            Replay the Intro
          </MenuItem>
        )}
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
          label="Music Player"
          title="The office radio's player, bottom of the office"
          checked={!radio.hidden}
          onChange={() => officeRadio.setHidden(!radio.hidden)}
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
        {usageBridge && (
          <>
            <Checkbox
              label="Usage Bars"
              title={`Your ${usageBridge.providerName} plan's usage left, top-left`}
              checked={usageBridge.installed}
              onChange={() => {
                if (usagePending) return;
                if (usageBridge.installed) setUsageBars(false);
                else setConfirmUsageBars(true);
              }}
            />
            {usageBridge.error && (
              <div className="px-10 pb-4 text-xs text-status-error">{usageBridge.error}</div>
            )}
          </>
        )}
        {officeMcp.status && (
          <>
            <Checkbox
              label="Pixel Office MCP"
              title="Let agents launched here see and act on the office (the Pixel Agents Office MCP)"
              checked={officeMcpOn}
              onChange={() => {
                if (officeMcpOn) officeMcp.setEnabled(false);
                else setConfirmOfficeMcp(true);
              }}
            />
            {officeMcpOn && (
              <Checkbox
                label="Pixel Office MCP Read-only"
                title="Agents may list and read the office, but not change it, launch, close or message"
                checked={officeMcp.status.readOnly}
                onChange={() => officeMcp.setReadOnly(!officeMcp.status?.readOnly)}
              />
            )}
          </>
        )}
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
        {/* Permission posture, set once instead of per launch: while on, the host
          adds the CLI's skip-permissions flag to every agent it launches. */}
        <Checkbox
          label={
            <span className="flex items-center gap-4">
              Skip Permissions
              <PixelIcon name="warning" />
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
        {uploadDirectory && <UploadDirectoryField stored={uploadDirectory} />}
        <Checkbox label="Debug View" checked={isDebugMode} onChange={onToggleDebugMode} />
      </Modal>
      {officeMcp.status && (
        <Modal
          isOpen={confirmOfficeMcp}
          onClose={() => setConfirmOfficeMcp(false)}
          title={officeMcp.status.headline}
          zIndex={60}
        >
          <div className="flex flex-col gap-8 px-10 pb-8 text-sm leading-snug max-w-md">
            {officeMcp.status.disclosure.split('\n\n').map((paragraph) => (
              <p key={paragraph} className="m-0">
                {paragraph}
              </p>
            ))}
            <div className="flex justify-end gap-8 pt-4">
              <Button variant="ghost" onClick={() => setConfirmOfficeMcp(false)}>
                Cancel
              </Button>
              <Button
                variant="accent"
                onClick={() => {
                  setConfirmOfficeMcp(false);
                  officeMcp.setEnabled(true);
                }}
              >
                Allow
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {usageBridge && (
        <Modal
          isOpen={confirmUsageBars}
          onClose={() => setConfirmUsageBars(false)}
          title="Show usage bars?"
          zIndex={60}
        >
          <div className="flex flex-col gap-8 px-10 pb-8 text-sm leading-snug max-w-md">
            {usageBridge.disclosure.split('\n\n').map((paragraph) => (
              <p key={paragraph} className="m-0">
                {paragraph}
              </p>
            ))}
            <div className="flex justify-end gap-8 pt-4">
              <Button variant="ghost" onClick={() => setConfirmUsageBars(false)}>
                Cancel
              </Button>
              <Button
                variant="accent"
                onClick={() => {
                  setConfirmUsageBars(false);
                  setUsageBars(true);
                }}
              >
                Connect
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/**
 * Where files sent to a terminal (dropped on it, or attached from the phone)
 * are saved on the host. The browser has no directory picker for another
 * machine's disk, so the path is typed: absolute or under `~`; emptied, it
 * goes back to Pixel Agents' own folder on the host, where files are deleted
 * after a week (a folder typed here is never cleaned). The server answers every save
 * with the folder that now stands, which is what the field then shows — a
 * refused path snaps back.
 */
function UploadDirectoryField({ stored }: { stored: { path: string } }) {
  const [draft, setDraft] = useState(stored.path);
  useEffect(() => setDraft(stored.path), [stored]);
  const save = () => transport.send({ type: 'setUploadDirectory', path: draft.trim() });
  return (
    <div className="flex flex-col gap-2 py-4 px-10">
      <label htmlFor="upload-directory" className="text-xs text-text-muted">
        Save Sent Files To
      </label>
      <div className="flex items-center gap-4">
        <input
          id="upload-directory"
          type="text"
          value={draft}
          placeholder="Pixel Agents' own folder"
          title="Files dropped on a terminal are saved here. Empty = Pixel Agents' own folder, where files are deleted after 7 days. A folder you choose is never cleaned."
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          className="flex-1 min-w-0 text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
        />
        <Button
          variant="default"
          size="sm"
          onClick={save}
          disabled={draft.trim() === stored.path}
          className="shrink-0"
        >
          Save
        </Button>
      </div>
    </div>
  );
}
