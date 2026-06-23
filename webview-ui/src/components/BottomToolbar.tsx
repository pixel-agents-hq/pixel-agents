import { useEffect, useRef, useState } from 'react';

import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Dropdown, DropdownItem } from './ui/Dropdown.js';

type AgentType = 'claude-code' | 'copilot-cli';

interface BottomToolbarProps {
  isEditMode: boolean;
  onToggleEditMode: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  workspaceFolders: WorkspaceFolder[];
}

export function BottomToolbar({
  isEditMode,
  onToggleEditMode,
  isSettingsOpen,
  onToggleSettings,
  workspaceFolders,
}: BottomToolbarProps) {
  const [isAgentMenuOpen, setIsAgentMenuOpen] = useState(false);
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const pendingAgentTypeRef = useRef<AgentType>('claude-code');
  const pendingBypassRef = useRef(false);

  // Close menus on outside click
  useEffect(() => {
    if (!isAgentMenuOpen && !isFolderPickerOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) {
        setIsAgentMenuOpen(false);
        setIsFolderPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isAgentMenuOpen, isFolderPickerOpen]);

  const hasMultipleFolders = workspaceFolders.length > 1;

  const launchAgent = (agentType: AgentType, bypassPermissions: boolean, folderPath?: string) => {
    transport.send({ type: 'launchAgent', agentType, bypassPermissions, folderPath });
  };

  const handleAgentClick = () => {
    setIsFolderPickerOpen(false);
    setIsAgentMenuOpen((v) => !v);
  };

  // After choosing an agent type, either launch directly or (in multi-root
  // workspaces) defer to the folder picker, remembering the selection.
  const handleAgentTypeSelect = (agentType: AgentType, bypassPermissions: boolean) => {
    setIsAgentMenuOpen(false);
    if (hasMultipleFolders) {
      pendingAgentTypeRef.current = agentType;
      pendingBypassRef.current = bypassPermissions;
      setIsFolderPickerOpen(true);
    } else {
      launchAgent(agentType, bypassPermissions);
    }
  };

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false);
    launchAgent(pendingAgentTypeRef.current, pendingBypassRef.current, folder.path);
  };

  return (
    <div className="absolute bottom-10 left-10 z-20 flex items-center gap-4 pixel-panel p-4">
      {/* Hide + Agent in standalone browser mode (no terminal to interact with) */}
      {!isBrowserRuntime && (
        <div ref={agentMenuRef} className="relative">
          <Button
            variant="accent"
            onClick={handleAgentClick}
            className={
              isAgentMenuOpen || isFolderPickerOpen
                ? 'bg-accent-bright'
                : 'bg-accent hover:bg-accent-bright'
            }
          >
            + Agent
          </Button>
          <Dropdown isOpen={isAgentMenuOpen} className="min-w-128">
            <DropdownItem onClick={() => handleAgentTypeSelect('claude-code', false)}>
              Claude Code
            </DropdownItem>
            <DropdownItem onClick={() => handleAgentTypeSelect('claude-code', true)}>
              Claude Code (Bypass) <span className="text-2xs text-warning">⚠</span>
            </DropdownItem>
            <DropdownItem onClick={() => handleAgentTypeSelect('copilot-cli', false)}>
              Copilot CLI
            </DropdownItem>
          </Dropdown>
          <Dropdown isOpen={isFolderPickerOpen} className="min-w-128">
            {workspaceFolders.map((folder) => (
              <DropdownItem
                key={folder.path}
                onClick={() => handleFolderSelect(folder)}
                className="text-base"
              >
                {folder.name}
              </DropdownItem>
            ))}
          </Dropdown>
        </div>
      )}
      <Button
        variant={isEditMode ? 'active' : 'default'}
        onClick={onToggleEditMode}
        title="Edit office layout"
      >
        Layout
      </Button>
      <Button
        variant={isSettingsOpen ? 'active' : 'default'}
        onClick={onToggleSettings}
        title="Settings"
      >
        Settings
      </Button>
    </div>
  );
}
