import { useRef, useState } from 'react';

import { LOCALE_NAMES, LOCALES, setLanguageChoice, useLocale, useT } from '../i18n/index.js';
import { officeRadio } from '../music/musicEngine.js';
import { useOfficeRadio } from '../music/useOfficeRadio.js';
import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
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
}: SettingsModalProps) {
  // The office radio's player is a per-browser setting the radio keeps itself.
  const radio = useOfficeRadio();
  const t = useT();
  const { choice: languageChoice } = useLocale();
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

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title={t('common.settings')}>
        {/* Open Sessions Folder opens an OS file manager — impossible in the browser. */}
        {!isBrowserRuntime && (
          <MenuItem
            onClick={() => {
              transport.send({ type: 'openSessionsFolder' });
              onClose();
            }}
          >
            {t('settings.openSessionsFolder')}
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
          {t('settings.exportLayout')}
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
          {t('settings.importLayout')}
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
              placeholder={t('settings.assetDirPlaceholder')}
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
              {t('common.add')}
            </Button>
          </div>
        ) : (
          <MenuItem
            onClick={() => {
              transport.send({ type: 'addExternalAssetDirectory' });
              onClose();
            }}
          >
            {t('settings.addAssetDirectory')}
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
          label={t('settings.soundNotifications')}
          checked={soundLocal}
          onChange={() => {
            const newVal = !isSoundEnabled();
            setSoundEnabled(newVal);
            setSoundLocal(newVal);
            transport.send({ type: 'setSoundEnabled', enabled: newVal });
          }}
        />
        <Checkbox
          label={t('settings.musicPlayer')}
          title={t('settings.musicPlayerTitle')}
          checked={!radio.hidden}
          onChange={() => officeRadio.setHidden(!radio.hidden)}
        />
        <Checkbox
          label={t('settings.watchAllSessions')}
          checked={watchAllSessions}
          onChange={onToggleWatchAllSessions}
        />
        <Checkbox
          label={t('settings.hooks')}
          checked={hooksInstalled}
          onChange={onToggleHooksEnabled}
        />
        {usageBridge && (
          <>
            <Checkbox
              label={t('settings.usageBars')}
              title={t('settings.usageBarsTitle', { provider: usageBridge.providerName })}
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
        <Checkbox
          label={t('settings.alwaysShowLabels')}
          checked={alwaysShowOverlay}
          onChange={onToggleAlwaysShowOverlay}
        />
        {/* Headless agents are the office's only terminal-less citizens in VS Code.
          Standalone has no terminals at all, so nothing there would ever ghost. */}
        {!isBrowserRuntime && (
          <Checkbox
            label={t('settings.ghostHeadless')}
            checked={ghostHeadlessAgents}
            onChange={onToggleGhostHeadlessAgents}
          />
        )}
        {showAreasAvailable && (
          <Checkbox
            label={t('settings.showAreas')}
            checked={showAreas}
            onChange={onToggleShowAreas}
          />
        )}
        {/* Permission posture, set once instead of per launch: while on, the host
          adds the CLI's skip-permissions flag to every agent it launches. */}
        <Checkbox
          label={
            <span className="flex items-center gap-4">
              {t('settings.skipPermissions')}
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
          label={
            isBrowserRuntime ? t('settings.showStartDirectory') : t('settings.showWorkspaceFolders')
          }
          checked={showHostDirectories}
          onChange={onToggleShowHostDirectories}
        />
        {/* Per browser, like the radio: each viewer reads the office in their own language. */}
        <div className="flex items-center justify-between gap-8 py-4 px-10">
          <span className="text-sm">{t('settings.language')}</span>
          <div className="flex gap-4" role="radiogroup" aria-label={t('settings.language')}>
            {(['auto', ...LOCALES] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={languageChoice === option ? 'active' : 'ghost'}
                role="radio"
                aria-checked={languageChoice === option}
                title={option === 'auto' ? t('settings.languageAutoTitle') : undefined}
                onClick={() => setLanguageChoice(option)}
              >
                {option === 'auto' ? t('settings.languageAuto') : LOCALE_NAMES[option]}
              </Button>
            ))}
          </div>
        </div>
        <Checkbox
          label={t('settings.debugView')}
          checked={isDebugMode}
          onChange={onToggleDebugMode}
        />
      </Modal>
      {usageBridge && (
        <Modal
          isOpen={confirmUsageBars}
          onClose={() => setConfirmUsageBars(false)}
          title={t('settings.usageConfirmTitle')}
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
                {t('common.cancel')}
              </Button>
              <Button
                variant="accent"
                onClick={() => {
                  setConfirmUsageBars(false);
                  setUsageBars(true);
                }}
              >
                {t('settings.connect')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
