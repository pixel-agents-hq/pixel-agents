import { useState } from 'react';

import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface ProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectDir: string;
  displayName: string;
  workspacePath: string;
  skills: string[];
  lastSeenAt?: number;
  availableSkills: string[];
}

function formatRelativeTime(ms?: number): string {
  if (!ms) return 'never';
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function ProjectModal({
  isOpen,
  onClose,
  projectDir,
  displayName,
  workspacePath,
  skills: initialSkills,
  lastSeenAt,
  availableSkills,
}: ProjectModalProps) {
  const [skills, setSkills] = useState(initialSkills);
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const suggestions = availableSkills.filter(
    (s) => s.toLowerCase().includes(input.toLowerCase()) && !skills.includes(s),
  );

  function addSkill(skill: string): void {
    const trimmed = skill.trim();
    if (!trimmed || skills.includes(trimmed)) return;
    const next = [...skills, trimmed];
    setSkills(next);
    setInput('');
    setShowSuggestions(false);
    transport.send({ type: 'updateDormantProject', projectDir, skills: next });
  }

  function removeSkill(skill: string): void {
    const next = skills.filter((s) => s !== skill);
    setSkills(next);
    transport.send({ type: 'updateDormantProject', projectDir, skills: next });
  }

  function hide(): void {
    transport.send({ type: 'updateDormantProject', projectDir, hidden: true });
    onClose();
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={displayName}>
      <div className="flex flex-col gap-6 p-4">
        <div>
          <span className="text-2xs opacity-50 block">{workspacePath}</span>
          <span className="text-2xs opacity-40 block mt-1">
            Last active: {formatRelativeTime(lastSeenAt)}
          </span>
        </div>

        <div>
          <div className="text-xs opacity-70 mb-2">Skills</div>
          <div className="flex flex-wrap gap-2 mb-3">
            {skills.map((s) => (
              <span key={s} className="flex items-center gap-1 text-2xs px-4 py-1 pixel-panel">
                {s}
                <button
                  onClick={() => removeSkill(s)}
                  className="opacity-60 hover:opacity-100 ml-1"
                  aria-label={`Remove ${s}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          <div className="relative">
            <input
              type="text"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setShowSuggestions(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addSkill(input);
                if (e.key === 'Escape') {
                  setShowSuggestions(false);
                  setInput('');
                }
              }}
              placeholder="+ Add skill…"
              className="pixel-panel w-full px-4 py-2 text-xs bg-transparent outline-none"
              style={{ border: '2px solid var(--pixel-border)' }}
            />
            {showSuggestions && suggestions.length > 0 && (
              <div
                className="absolute left-0 right-0 top-full mt-1 pixel-panel overflow-y-auto"
                style={{ maxHeight: 120, zIndex: 50 }}
              >
                {suggestions.slice(0, 8).map((s) => (
                  <button
                    key={s}
                    className="block w-full text-left px-4 py-2 text-2xs hover:opacity-80"
                    onClick={() => addSkill(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-between pt-2">
          <Button variant="ghost" size="sm" onClick={hide} className="text-2xs opacity-60">
            Hide from office
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
