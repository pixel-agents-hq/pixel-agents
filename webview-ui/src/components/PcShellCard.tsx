import type { PcShell } from '../../../core/src/messages.js';
import { pcShellName } from '../../../core/src/pcShells.js';
import { PC_SHELL_CARD_STATE } from '../constants.js';
import type { CardVariant, CloseMode } from './cardBar.js';
import { CARD_VARIANT, CLOSE_MODE } from './cardStyles.js';
import { PieceSprite } from './PieceSprite.js';
import { Button } from './ui/Button.js';
import { PixelIcon } from './ui/PixelIcon.js';

interface PcShellCardProps {
  shell: PcShell;
  /** Say which Directory it is in: only where its PC offered several. */
  named: boolean;
  variant: CardVariant;
  close?: CloseMode;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
}

/**
 * A PC shell's card in the card bar, beside the agents' (CONTEXT.md → PC shell):
 * the PC, switched on, standing on the card's foot where an agent's mug shot
 * is, and the ×. Its Directory's name runs along the top only where the PC
 * offered a choice (its Area has several Directories); the hover title always
 * says it. No status dot and no context gauge: a shell is not an agent. Like an
 * agent's card it is its terminal's tab.
 */
export function PcShellCard({
  shell,
  named,
  variant,
  close = 'shown',
  onSelect,
  onClose,
}: PcShellCardProps) {
  const name = pcShellName(shell);
  return (
    <div
      data-testid="pc-shell-card"
      className={`group relative pointer-events-auto flex items-stretch gap-1 p-1 cursor-pointer border-2 shrink-0 ${CARD_VARIANT[variant]}`}
      onClick={() => onSelect(shell.id)}
      title={`Shell in ${name}`}
    >
      <span className="relative flex shrink-0">
        <PieceSprite type={shell.furnitureType} state={PC_SHELL_CARD_STATE} />
        {named && (
          <span
            data-testid="pc-shell-card-name"
            className="absolute left-0 right-0 top-0 bg-bg text-text text-2xs leading-none px-1 truncate text-center pointer-events-none"
          >
            {name}
          </span>
        )}
      </span>
      <div className="flex flex-col items-center shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            // Don't also select the tab we're about to remove.
            e.stopPropagation();
            onClose(shell.id);
          }}
          title="Close shell"
          className={CLOSE_MODE[close]}
        >
          <PixelIcon name="close" className="translate-x-1" />
        </Button>
      </div>
    </div>
  );
}
