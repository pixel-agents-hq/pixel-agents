import { useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { writeClipboardText } from '../terminal/clipboard.js';
import type { AgentLinkState } from './inboxModel.js';
import { safeClaudeUrl } from './inboxModel.js';

const COPIED_FEEDBACK_MS = 1500;

interface AgentLinkActionProps {
  link: AgentLinkState | undefined;
  /** 'row': a labelled button in the inbox. 'icon': the label's small button. */
  variant: 'row' | 'icon';
}

/**
 * "Open in Claude" when the session runs Remote Control (a claude.ai/code
 * link, nothing else is ever opened), else "Copy" for its resume command.
 * When the clipboard refuses (plain-http pages, denied permission) the
 * command appears in a pre-selected read-only box to copy by hand -- no
 * native prompt.
 */
export function AgentLinkAction({ link, variant }: AgentLinkActionProps) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  if (!link) return null;

  const url = safeClaudeUrl(link.url);
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="Open this session in Claude"
        onClick={(e) => e.stopPropagation()}
        className={
          variant === 'row'
            ? 'shrink-0 text-2xs px-6 py-1 border-2 border-border text-text no-underline hover:text-accent-bright'
            : 'shrink-0 leading-none no-underline ml-2'
        }
        data-testid="agent-link-open"
      >
        {variant === 'row' ? '🔗 Open in Claude' : '🔗'}
      </a>
    );
  }

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Called synchronously from the click: the copy-event fallback needs the gesture.
    void writeClipboardText(link.resumeCommand)
      .catch(() => false)
      .then((ok) => {
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
        } else {
          setManual(true);
        }
      });
  };

  return (
    <span className="relative shrink-0 inline-flex items-center">
      <Button
        variant={variant === 'row' ? 'default' : 'ghost'}
        size={variant === 'row' ? 'sm' : 'icon'}
        onClick={copy}
        title={`Copy: ${link.resumeCommand}`}
        className={variant === 'row' ? 'text-2xs' : 'ml-2 leading-none'}
        data-testid="agent-link-copy"
      >
        {copied ? '✓' : variant === 'row' ? '📋 Copy resume' : '📋'}
      </Button>
      {manual && (
        <input
          readOnly
          autoFocus
          value={link.resumeCommand}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => setManual(false)}
          className="absolute right-0 top-full mt-2 z-10 w-[260px] max-w-[80vw] text-2xs px-4 py-2 bg-bg border-2 border-border text-text"
          aria-label="Resume command: copy it by hand"
          data-testid="agent-link-manual"
        />
      )}
    </span>
  );
}
