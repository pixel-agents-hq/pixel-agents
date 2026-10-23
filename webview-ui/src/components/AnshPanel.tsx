import type { AnshAction } from '../../../core/src/messages.js';
import { closeAnshPanel, markAnshAsking, useAnshState } from '../ansh/anshStore.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';
import { Modal } from './ui/Modal.js';

const ACTION_ICON: Record<AnshAction, string> = {
  visit: '👣',
  chatManager: '💬',
  stretch: '🚶',
  stay: '🪑',
};

const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

interface AnshPanelProps {
  /** A read-only office watches Ansh but can't switch him off or ask him. */
  readOnly: boolean;
}

/**
 * Ansh's thoughts (a click on Ansh opens it): what he has said today, newest
 * first, and -- privileged only -- the on/off switch and "Ask Ansh", which
 * runs a thought now on the operator's Claude subscription (the server still
 * applies its own rate limit and daily cap).
 */
export function AnshPanel({ readOnly }: AnshPanelProps) {
  const s = useAnshState();
  const busy = s.asking || s.thinking;
  const ask = () => {
    markAnshAsking();
    transport.send({ type: 'askAnsh' });
  };
  const toggle = () => transport.send({ type: 'setAnshBrainEnabled', enabled: !s.enabled });

  return (
    <Modal isOpen={s.panelOpen} onClose={closeAnshPanel} title="🧠 Ansh's thoughts">
      <div className="flex flex-col gap-4 px-10 py-4 max-w-[420px]" data-testid="ansh-panel">
        {!s.supported ? (
          <p className="text-sm">Ansh thinks only on the standalone board (npx pixel-agents).</p>
        ) : (
          <>
            <p className="text-sm opacity-80">
              {s.thinking
                ? 'Thinking…'
                : s.enabled
                  ? `${s.thoughtsToday} of ${s.dailyCap} thoughts today.`
                  : 'Switched off.'}
            </p>
            {!readOnly && (
              <>
                <Checkbox
                  label="Ansh thinks for himself"
                  checked={s.enabled}
                  onChange={toggle}
                  className="px-0!"
                />
                <Button
                  onClick={ask}
                  disabled={!s.enabled || busy || s.thoughtsToday >= s.dailyCap}
                  data-testid="ansh-ask"
                >
                  {busy ? 'Thinking…' : 'Ask Ansh'}
                </Button>
              </>
            )}
            <ul className="flex flex-col gap-3 list-none p-0 m-0 max-h-[50vh] overflow-y-auto">
              {s.thoughts.length === 0 && <li className="text-sm opacity-70">No thoughts yet.</li>}
              {[...s.thoughts].reverse().map((t) => (
                <li key={t.at} className="text-sm border-b border-border pb-3">
                  <span className="opacity-70">
                    {timeOf(t.at)} {ACTION_ICON[t.action]}{' '}
                  </span>
                  {t.say}
                  {!t.aiWritten && <span className="opacity-50"> (built-in)</span>}
                </li>
              ))}
            </ul>
            <p className="text-xs opacity-60">
              Ansh only walks and talks. He can't approve, message or stop an agent.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
