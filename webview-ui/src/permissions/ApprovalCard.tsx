import { useState } from 'react';

import type {
  PermissionAnswer,
  PermissionBehavior,
  PermissionQuestion,
} from '../../../core/src/messages.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import type { ApprovalCard as ApprovalCardState, QuestionDraft } from './approvalState.js';
import {
  approvalCardFooter,
  draftAnswers,
  draftComplete,
  emptyDraft,
  setDraftOther,
  toggleDraftOption,
} from './approvalState.js';

interface ApprovalCardProps {
  card: ApprovalCardState | null;
  /** Read-only board (no token): the card shows, its buttons don't. */
  readOnly: boolean;
  /** `repo · title · machine` for the agent that asked. */
  agentLabel: string;
  onAnswer: (behavior: PermissionBehavior, answers?: PermissionAnswer[]) => void;
  onClose: () => void;
}

/**
 * The approval card: what the session wants to run, in full, and — on a
 * privileged board only — Allow / Deny for this one request. Deny asks no
 * further questions. Never offers "always allow": an answer here is this once,
 * and the settings' deny rules still win. An AskUserQuestion shows its
 * questions instead, answered with its own options (or "Other" text).
 */
export function ApprovalCard({ card, readOnly, agentLabel, onAnswer, onClose }: ApprovalCardProps) {
  if (!card) return null;
  const { request } = card;
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={request.questions ? '❓ Claude asks' : '🔐 Needs approval'}
      zIndex={60}
    >
      <div className="flex flex-col gap-6 px-10 pb-6 max-w-[640px]" data-testid="approval-card">
        <div className="text-sm text-text-muted" data-testid="approval-agent">
          {agentLabel}
        </div>
        {request.questions ? (
          // Keyed by request: a new question never inherits the last one's picks.
          <QuestionForm
            key={request.requestId}
            card={card}
            questions={request.questions}
            readOnly={readOnly}
            onAnswer={onAnswer}
          />
        ) : (
          <PermissionBody card={card} readOnly={readOnly} onAnswer={onAnswer} />
        )}
      </div>
    </Modal>
  );
}

interface BodyProps {
  card: ApprovalCardState;
  readOnly: boolean;
  onAnswer: ApprovalCardProps['onAnswer'];
}

function PermissionBody({ card, readOnly, onAnswer }: BodyProps) {
  const { request } = card;
  const footer = approvalCardFooter(card, readOnly);
  return (
    <>
      <div className="text-lg" data-testid="approval-tool">
        {request.tool}
      </div>
      <pre
        className="font-mono text-[12px] whitespace-pre-wrap break-all bg-bg-dark border-2 border-border p-6 max-h-[40vh] overflow-auto m-0 select-text"
        data-testid="approval-detail"
      >
        {request.detail}
      </pre>
      {footer.kind === 'outcome' && <Outcome text={footer.text} />}
      {footer.kind === 'readOnly' && <ReadOnlyNote note={footer.note} />}
      {footer.kind === 'buttons' && (
        <>
          <div className="flex gap-8">
            <Button
              variant={footer.disabled ? 'disabled' : 'accent'}
              disabled={footer.disabled}
              onClick={() => onAnswer('allow')}
              data-testid="approval-allow"
            >
              ✅ Allow
            </Button>
            <Button
              variant={footer.disabled ? 'disabled' : 'default'}
              disabled={footer.disabled}
              onClick={() => onAnswer('deny')}
              data-testid="approval-deny"
            >
              ❌ Deny
            </Button>
          </div>
          <Scope note={footer.note} />
        </>
      )}
    </>
  );
}

function QuestionForm({
  card,
  questions,
  readOnly,
  onAnswer,
}: BodyProps & { questions: PermissionQuestion[] }) {
  const [draft, setDraft] = useState<QuestionDraft[]>(() => emptyDraft(questions));
  const footer = approvalCardFooter(card, readOnly);
  const locked = footer.kind !== 'buttons' || footer.disabled;
  const complete = draftComplete(draft);
  return (
    <>
      <div className="flex flex-col gap-10 max-h-[55vh] overflow-y-auto pixel-scrollbar">
        {questions.map((q, qi) => (
          <fieldset
            key={qi}
            className="flex flex-col gap-4 border-0 p-0 m-0 min-w-0"
            data-testid="approval-question"
          >
            <legend className="p-0 mb-4">
              {q.header && <span className="text-xs text-accent-bright mr-6">{q.header}</span>}
              <span className="text-lg">{q.question}</span>
              {q.multiSelect && <span className="text-2xs text-text-muted ml-6">(pick any)</span>}
            </legend>
            {q.options.map((option, oi) => {
              const picked = draft[qi].options.includes(oi);
              return (
                <button
                  key={oi}
                  type="button"
                  disabled={locked}
                  aria-pressed={picked}
                  onClick={() => setDraft((d) => toggleDraftOption(d, questions, qi, oi))}
                  className={`flex flex-col items-start gap-2 text-left py-4 px-8 border-2 rounded-none ${
                    picked ? 'bg-active-bg border-accent' : 'bg-btn-bg border-transparent'
                  } ${locked ? 'cursor-default' : 'cursor-pointer hover:bg-btn-hover'}`}
                  data-testid="approval-option"
                >
                  <span className="text-sm">
                    {q.multiSelect ? (picked ? '☑ ' : '☐ ') : picked ? '◉ ' : '○ '}
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="text-2xs text-text-muted">{option.description}</span>
                  )}
                </button>
              );
            })}
            {!readOnly && (
              <input
                type="text"
                value={draft[qi].other}
                disabled={locked}
                placeholder="Other…"
                onChange={(e) => {
                  const other = e.target.value;
                  setDraft((d) => setDraftOther(d, qi, other));
                }}
                className="text-sm py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
                data-testid="approval-other"
              />
            )}
          </fieldset>
        ))}
      </div>
      {footer.kind === 'outcome' && <Outcome text={footer.text} />}
      {footer.kind === 'readOnly' && <ReadOnlyNote note={footer.note} />}
      {footer.kind === 'buttons' && (
        <>
          <div className="flex gap-8">
            <Button
              variant={footer.disabled || !complete ? 'disabled' : 'accent'}
              disabled={footer.disabled || !complete}
              onClick={() => onAnswer('allow', draftAnswers(draft))}
              data-testid="approval-submit"
            >
              ✅ Answer
            </Button>
            <Button
              variant={footer.disabled ? 'disabled' : 'default'}
              disabled={footer.disabled}
              onClick={() => onAnswer('deny')}
              data-testid="approval-deny"
            >
              ⏭️ Skip
            </Button>
          </div>
          <Scope note={footer.note} />
        </>
      )}
    </>
  );
}

function Outcome({ text }: { text: string }) {
  return (
    <div className="text-lg" data-testid="approval-outcome">
      {text}
    </div>
  );
}

function ReadOnlyNote({ note }: { note: string }) {
  return (
    <div className="text-sm text-text-muted" data-testid="approval-read-only">
      {note}
    </div>
  );
}

function Scope({ note }: { note: string }) {
  return (
    <div className="text-2xs text-text-muted" data-testid="approval-scope">
      {note}
    </div>
  );
}
