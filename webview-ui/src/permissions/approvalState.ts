import type {
  PermissionAnswer,
  PermissionBehavior,
  PermissionOutcome,
  PermissionQuestion,
  ServerMessage,
} from '../../../core/src/messages.js';

/** How long the card shows a request's outcome before it closes itself. */
export const APPROVAL_OUTCOME_SHOW_MS = 2_500;

/** The label an agent with a pending request shows instead of its activity. */
export const APPROVAL_LABEL_TEXT = '🔐 needs approval — click';
/** The same for a pending AskUserQuestion. */
export const QUESTION_LABEL_TEXT = '❓ question — click';

/** Under the buttons: what an answer from the board can and cannot do. */
export const APPROVAL_SCOPE_NOTE = "Only this once. Your settings' deny rules still apply.";
/** Under a question's buttons. */
export const QUESTION_SCOPE_NOTE = 'Skip declines the question; Claude carries on without it.';

/** In place of the buttons, for a read-only (untokened) board. */
export const APPROVAL_READ_ONLY_NOTE = "Open the board's private link to approve";
export const QUESTION_READ_ONLY_NOTE = "Open the board's private link to answer";

/** The setup hint's text, for a relayed session whose permission prompt never
 *  waited on the board (its computer has no approvals hook). */
export function remoteSetupHint(machine: string): string[] {
  return [
    `${machine} is asking in its own terminal, but it isn't waiting for an answer from this board, so it can only be answered there.`,
    `To answer from the board, add the second, waiting PermissionRequest hook to ${machine}'s ~/.claude/settings.json (remote/README.md, "Approvals from the board"), then start a new Claude Code session there.`,
  ];
}

/** What clicking an agent does: open its pending request's card; explain why
 *  a relayed session waiting on a permission has none; or the usual focus. */
export type AgentClickAction = 'card' | 'setupHint' | 'focus';

export function agentClickAction(agent: {
  hasPending: boolean;
  /** Where a relayed session runs; undefined for this machine. */
  machine?: string;
  /** Its permission bubble is up. */
  needsPermission: boolean;
}): AgentClickAction {
  if (agent.hasPending) return 'card';
  if (agent.machine !== undefined && agent.needsPermission) return 'setupHint';
  return 'focus';
}

/** One request a session is waiting on (permissionPending). */
export interface PendingApproval {
  requestId: string;
  agentId: number;
  tool: string;
  detail: string;
  since: number;
  /** AskUserQuestion: the card offers these instead of Allow. */
  questions?: PermissionQuestion[];
}

/** The open approval card: which request, and how it ended once it has. */
export interface ApprovalCard {
  request: PendingApproval;
  /** Set once this board sent an answer, so the buttons can't send twice. */
  answering?: PermissionBehavior;
  /** Set by permissionResolved; the card shows it, then closes. */
  outcome?: PermissionOutcome;
}

export interface ApprovalsState {
  pending: Record<string, PendingApproval>;
  card: ApprovalCard | null;
  /** Requests whose card this viewer closed unanswered: auto-open (TV mode)
   *  leaves them alone. Dropped once the request ends. */
  dismissed: Record<string, true>;
}

export type ApprovalsAction =
  | { type: 'message'; msg: ServerMessage }
  | { type: 'open'; agentId: number }
  | { type: 'autoOpen' }
  | { type: 'answer'; behavior: PermissionBehavior }
  | { type: 'close' };

export const INITIAL_APPROVALS: ApprovalsState = { pending: {}, card: null, dismissed: {} };

/** The card's `repo · title · machine` line; any part may be unknown. */
export function approvalAgentLabel(
  repo: string | undefined,
  title: string | undefined,
  machine?: string,
): string {
  return [repo, title?.trim(), machine].filter((part) => part).join(' · ') || 'Agent';
}

/** What the card's bottom section shows. The ONE place privilege decides
 *  whether the answer buttons exist (ApprovalCard renders exactly this). */
export type ApprovalCardFooter =
  | { kind: 'outcome'; text: string }
  | { kind: 'readOnly'; note: string }
  | { kind: 'buttons'; disabled: boolean; note: string };

export function approvalCardFooter(card: ApprovalCard, readOnly: boolean): ApprovalCardFooter {
  const question = card.request.questions !== undefined;
  if (card.outcome) return { kind: 'outcome', text: outcomeText(card.outcome, question) };
  if (readOnly) {
    return { kind: 'readOnly', note: question ? QUESTION_READ_ONLY_NOTE : APPROVAL_READ_ONLY_NOTE };
  }
  return {
    kind: 'buttons',
    disabled: card.answering !== undefined,
    note: question ? QUESTION_SCOPE_NOTE : APPROVAL_SCOPE_NOTE,
  };
}

/** Short text for how a request ended. */
export function outcomeText(outcome: PermissionOutcome, question = false): string {
  switch (outcome) {
    case 'allowed':
      return question ? '✅ Answered' : '✅ Allowed';
    case 'denied':
      return question ? '⏭️ Skipped' : '❌ Denied';
    case 'answeredInTerminal':
      return 'Answered in the terminal';
    case 'expired':
      return 'Expired: answer it in the terminal';
  }
}

/** The oldest pending request for an agent (any agent when undefined) that
 *  passes `keep`, if any. */
export function oldestPendingFor(
  pending: Record<string, PendingApproval>,
  agentId: number | undefined,
  keep: (req: PendingApproval) => boolean = () => true,
): PendingApproval | undefined {
  let oldest: PendingApproval | undefined;
  for (const req of Object.values(pending)) {
    if (agentId !== undefined && req.agentId !== agentId) continue;
    if (!keep(req)) continue;
    if (!oldest || req.since < oldest.since) oldest = req;
  }
  return oldest;
}

/** Agents that have at least one pending request, each with the label it
 *  shows (a question when its oldest request is one). */
export function agentsWithPending(pending: Record<string, PendingApproval>): Map<number, string> {
  const labels = new Map<number, string>();
  for (const req of Object.values(pending)) {
    if (labels.has(req.agentId)) continue;
    const oldest = oldestPendingFor(pending, req.agentId)!;
    labels.set(req.agentId, oldest.questions ? QUESTION_LABEL_TEXT : APPROVAL_LABEL_TEXT);
  }
  return labels;
}

function without<T>(record: Record<string, T>, keep: (key: string, value: T) => boolean) {
  return Object.fromEntries(Object.entries(record).filter(([k, v]) => keep(k, v)));
}

/** Pure state transitions for the approvals UI (Node-tested). */
export function approvalsReducer(state: ApprovalsState, action: ApprovalsAction): ApprovalsState {
  switch (action.type) {
    case 'message': {
      const msg = action.msg;
      switch (msg.type) {
        case 'officeAccess':
          // First message of every (re)connect snapshot: what was pending
          // before is re-sent if it still is, and anything resolved while we
          // were away must not keep its buttons.
          return INITIAL_APPROVALS;
        case 'permissionPending': {
          const request: PendingApproval = {
            requestId: msg.requestId,
            agentId: msg.id,
            tool: msg.tool,
            detail: msg.detail,
            since: msg.since,
          };
          if (msg.questions) request.questions = msg.questions;
          return { ...state, pending: { ...state.pending, [msg.requestId]: request } };
        }
        case 'permissionResolved': {
          const pending = without(state.pending, (_, req) => req.requestId !== msg.requestId);
          const dismissed = without(state.dismissed, (id) => id !== msg.requestId);
          const card =
            state.card?.request.requestId === msg.requestId
              ? { ...state.card, outcome: msg.outcome }
              : state.card;
          return { pending, card, dismissed };
        }
        case 'agentClosed': {
          const pending = without(state.pending, (_, req) => req.agentId !== msg.id);
          const dismissed = without(state.dismissed, (id) => id in pending);
          const card = state.card?.request.agentId === msg.id ? null : state.card;
          return { pending, card, dismissed };
        }
        default:
          return state;
      }
    }
    case 'open': {
      const request = oldestPendingFor(state.pending, action.agentId);
      return request ? { ...state, card: { request } } : state;
    }
    case 'autoOpen': {
      if (state.card) return state;
      const request = oldestPendingFor(
        state.pending,
        undefined,
        (req) => !state.dismissed[req.requestId],
      );
      return request ? { ...state, card: { request } } : state;
    }
    case 'answer':
      if (!state.card || state.card.answering || state.card.outcome) return state;
      return { ...state, card: { ...state.card, answering: action.behavior } };
    case 'close': {
      const card = state.card;
      // Closed while still waiting: this viewer chose not to answer it here.
      const dismissed =
        card && !card.outcome && !card.answering
          ? { ...state.dismissed, [card.request.requestId]: true as const }
          : state.dismissed;
      return { ...state, card: null, dismissed };
    }
  }
}

// ── Question drafts ──────────────────────────────────────────────────────────

/** What the viewer has picked so far, one entry per question. */
export interface QuestionDraft {
  options: number[];
  other: string;
}

export function emptyDraft(questions: readonly PermissionQuestion[]): QuestionDraft[] {
  return questions.map(() => ({ options: [], other: '' }));
}

/** Click option `option` of question `index`: a single-select question takes
 *  it (clicking it again clears it), a multi-select one toggles it. */
export function toggleDraftOption(
  draft: readonly QuestionDraft[],
  questions: readonly PermissionQuestion[],
  index: number,
  option: number,
): QuestionDraft[] {
  return draft.map((entry, i) => {
    if (i !== index) return entry;
    const has = entry.options.includes(option);
    if (!questions[i].multiSelect) return { ...entry, options: has ? [] : [option] };
    return {
      ...entry,
      options: has ? entry.options.filter((n) => n !== option) : [...entry.options, option],
    };
  });
}

export function setDraftOther(
  draft: readonly QuestionDraft[],
  index: number,
  other: string,
): QuestionDraft[] {
  return draft.map((entry, i) => (i === index ? { ...entry, other } : entry));
}

/** Every question has an option or some "Other" text. */
export function draftComplete(draft: readonly QuestionDraft[]): boolean {
  return draft.length > 0 && draft.every((d) => d.options.length > 0 || d.other.trim() !== '');
}

/** The draft as the answerPermission `answers` the server checks. */
export function draftAnswers(draft: readonly QuestionDraft[]): PermissionAnswer[] {
  return draft.map((d) => {
    const answer: PermissionAnswer = { options: [...d.options].sort((a, b) => a - b) };
    const other = d.other.trim();
    if (other) answer.other = other;
    return answer;
  });
}
