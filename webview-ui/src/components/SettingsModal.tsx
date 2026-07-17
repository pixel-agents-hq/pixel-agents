import { useState } from 'react';

import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
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
  externalAssetDirectories: string[];
  watchAllSessions: boolean;
  onToggleWatchAllSessions: () => void;
  hooksEnabled: boolean;
  onToggleHooksEnabled: () => void;
  subagentNames: Record<string, string>;
  onRenameSubagentType: (subagentType: string, name: string) => void;
}

/** "Name your subagents" section: existing type -> name rows (editable name,
 *  removable) plus an add-row for a new subagent_type. Persistent per-type,
 *  not per-invocation — see officeState.renameSubagentType. */
function SubagentNamesSection({
  subagentNames,
  onRenameSubagentType,
}: {
  subagentNames: Record<string, string>;
  onRenameSubagentType: (subagentType: string, name: string) => void;
}) {
  const [newType, setNewType] = useState('');
  const [newName, setNewName] = useState('');
  const entries = Object.entries(subagentNames).sort(([a], [b]) => a.localeCompare(b));

  const addEntry = () => {
    const type = newType.trim();
    const name = newName.trim();
    if (!type || !name) return;
    onRenameSubagentType(type, name);
    setNewType('');
    setNewName('');
  };

  return (
    <div className="flex flex-col gap-4 py-4 px-10">
      <span className="text-xs text-text-muted">Name your subagents</span>
      {entries.map(([type, name]) => (
        <div key={type} className="flex items-center gap-4">
          <span
            className="text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap flex-1"
            title={type}
          >
            {type}
          </span>
          <input
            data-testid={`subagent-name-input-${type}`}
            className="text-sm bg-btn-bg text-text border-2 border-border rounded-none px-2 py-0 w-96 min-w-0"
            defaultValue={name}
            onBlur={(e) => onRenameSubagentType(type, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRenameSubagentType(type, '')}
            className="shrink-0"
          >
            x
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-4">
        <input
          data-testid="subagent-name-new-type"
          className="text-xs bg-btn-bg text-text border-2 border-border rounded-none px-2 py-0 flex-1 min-w-0"
          placeholder="subagent type (e.g. office-architect)"
          value={newType}
          onChange={(e) => setNewType(e.target.value)}
        />
        <input
          data-testid="subagent-name-new-name"
          className="text-sm bg-btn-bg text-text border-2 border-border rounded-none px-2 py-0 w-96 min-w-0"
          placeholder="name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addEntry();
          }}
        />
        <Button variant="ghost" size="sm" onClick={addEntry} className="shrink-0">
          Add
        </Button>
      </div>
    </div>
  );
}

export function SettingsModal({
  isOpen,
  onClose,
  isDebugMode,
  onToggleDebugMode,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
  externalAssetDirectories,
  watchAllSessions,
  onToggleWatchAllSessions,
  hooksEnabled,
  onToggleHooksEnabled,
  subagentNames,
  onRenameSubagentType,
}: SettingsModalProps) {
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Settings">
      <MenuItem
        onClick={() => {
          transport.send({ type: 'openSessionsFolder' });
          onClose();
        }}
      >
        Open Sessions Folder
      </MenuItem>
      <MenuItem
        onClick={() => {
          transport.send({ type: 'exportLayout' });
          onClose();
        }}
      >
        Export Layout
      </MenuItem>
      <MenuItem
        onClick={() => {
          transport.send({ type: 'importLayout' });
          onClose();
        }}
      >
        Import Layout
      </MenuItem>
      <MenuItem
        onClick={() => {
          transport.send({ type: 'addExternalAssetDirectory' });
          onClose();
        }}
      >
        Add Asset Directory
      </MenuItem>
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
        checked={hooksEnabled}
        onChange={onToggleHooksEnabled}
      />
      <Checkbox
        label="Always Show Labels"
        checked={alwaysShowOverlay}
        onChange={onToggleAlwaysShowOverlay}
      />
      <Checkbox label="Debug View" checked={isDebugMode} onChange={onToggleDebugMode} />
      <SubagentNamesSection
        subagentNames={subagentNames}
        onRenameSubagentType={onRenameSubagentType}
      />
    </Modal>
  );
}
