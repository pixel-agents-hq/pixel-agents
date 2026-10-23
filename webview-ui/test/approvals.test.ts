import { describe, expect, it } from 'vitest';

import type { ServerMessage } from '../../core/src/messages.js';
import {
  agentClickAction,
  agentsWithPending,
  APPROVAL_LABEL_TEXT,
  APPROVAL_READ_ONLY_NOTE,
  APPROVAL_SCOPE_NOTE,
  approvalAgentLabel,
  type ApprovalCard as ApprovalCardState,
  approvalCardFooter,
  approvalsReducer,
  type ApprovalsState,
  draftAnswers,
  draftComplete,
  emptyDraft,
  INITIAL_APPROVALS,
  QUESTION_LABEL_TEXT,
  QUESTION_READ_ONLY_NOTE,
  QUESTION_SCOPE_NOTE,
  remoteSetupHint,
  setDraftOther,
  toggleDraftOption,
} from '../src/permissions/approvalState.js';

function pending(requestId: string, id: number, since = 1): ServerMessage {
  return {
    type: 'permissionPending',
    requestId,
    id,
    tool: 'Bash',
    detail: 'git push --force origin main',
    since,
  };
}

function apply(state: ApprovalsState, ...msgs: ServerMessage[]): ApprovalsState {
  return msgs.reduce((s, msg) => approvalsReducer(s, { type: 'message', msg }), state);
}

describe('approvalsReducer', () => {
  it('tracks pending requests per agent and opens the oldest for a clicked agent', () => {
    let state = apply(INITIAL_APPROVALS, pending('b', 1, 20), pending('a', 1, 10), pending('c', 2));
    expect([...agentsWithPending(state.pending).keys()].sort()).toEqual([1, 2]);
    state = approvalsReducer(state, { type: 'open', agentId: 1 });
    expect(state.card?.request.requestId).toBe('a');
    expect(approvalsReducer(INITIAL_APPROVALS, { type: 'open', agentId: 9 }).card).toBeNull();
  });

  it('a resolution drops the request and shows its outcome on the open card', () => {
    let state = apply(INITIAL_APPROVALS, pending('a', 1));
    state = approvalsReducer(state, { type: 'open', agentId: 1 });
    state = apply(state, { type: 'permissionResolved', requestId: 'a', id: 1, outcome: 'allowed' });
    expect(state.pending).toEqual({});
    expect(state.card?.outcome).toBe('allowed');
    expect(approvalsReducer(state, { type: 'close' }).card).toBeNull();
  });

  it('answers once: a second click (or a click after the outcome) does nothing', () => {
    let state = approvalsReducer(apply(INITIAL_APPROVALS, pending('a', 1)), {
      type: 'open',
      agentId: 1,
    });
    state = approvalsReducer(state, { type: 'answer', behavior: 'deny' });
    expect(state.card?.answering).toBe('deny');
    expect(approvalsReducer(state, { type: 'answer', behavior: 'allow' })).toBe(state);
  });

  it('a reconnect snapshot (officeAccess first) starts over; a closed agent drops its requests', () => {
    let state = approvalsReducer(apply(INITIAL_APPROVALS, pending('a', 1), pending('b', 2)), {
      type: 'open',
      agentId: 1,
    });
    state = apply(state, { type: 'agentClosed', id: 1 });
    expect(Object.keys(state.pending)).toEqual(['b']);
    expect(state.card).toBeNull();
    state = apply(state, { type: 'officeAccess', readOnly: true });
    expect(state).toEqual(INITIAL_APPROVALS);
  });

  it('labels the card repo · title', () => {
    expect(approvalAgentLabel('hobbyfi-blog', 'Fix the build')).toBe(
      'hobbyfi-blog · Fix the build',
    );
    expect(approvalAgentLabel('hobbyfi-blog', '  ')).toBe('hobbyfi-blog');
    expect(approvalAgentLabel(undefined, undefined)).toBe('Agent');
  });
});

describe('approval card visibility by privilege', () => {
  const card: ApprovalCardState = {
    request: {
      requestId: 'a',
      agentId: 1,
      tool: 'Bash',
      detail: 'git push --force origin main',
      since: 1,
    },
  };

  it('a privileged board gets Allow / Deny with the this-once note', () => {
    expect(approvalCardFooter(card, false)).toEqual({
      kind: 'buttons',
      disabled: false,
      note: APPROVAL_SCOPE_NOTE,
    });
    expect(APPROVAL_SCOPE_NOTE).toBe("Only this once. Your settings' deny rules still apply.");
  });

  it('a read-only board gets no buttons, only where to approve', () => {
    expect(approvalCardFooter(card, true)).toEqual({
      kind: 'readOnly',
      note: APPROVAL_READ_ONLY_NOTE,
    });
    expect(APPROVAL_READ_ONLY_NOTE).toBe("Open the board's private link to approve");
  });

  it('the buttons go inert once this board answered', () => {
    expect(approvalCardFooter({ ...card, answering: 'allow' }, false)).toMatchObject({
      kind: 'buttons',
      disabled: true,
    });
  });

  it('once resolved, every board sees the outcome instead', () => {
    for (const readOnly of [false, true]) {
      expect(approvalCardFooter({ ...card, outcome: 'answeredInTerminal' }, readOnly)).toEqual({
        kind: 'outcome',
        text: 'Answered in the terminal',
      });
    }
    expect(approvalCardFooter({ ...card, outcome: 'allowed' }, false)).toMatchObject({
      text: '✅ Allowed',
    });
    expect(approvalCardFooter({ ...card, outcome: 'denied' }, true)).toMatchObject({
      text: '❌ Denied',
    });
  });
});

const QUESTIONS = [
  {
    question: 'Which meter?',
    header: 'Meter',
    multiSelect: false,
    options: [{ label: 'Server room' }, { label: 'Limit meter' }],
  },
  {
    question: 'Which hosts?',
    multiSelect: true,
    options: [{ label: 'PC' }, { label: 'Mac' }, { label: 'NAS' }],
  },
];

function question(requestId: string, id: number, since = 1): ServerMessage {
  return {
    type: 'permissionPending',
    requestId,
    id,
    tool: 'AskUserQuestion',
    detail: 'AskUserQuestion {…}',
    since,
    questions: QUESTIONS,
  };
}

describe('questions', () => {
  it('keeps the questions and labels the agent as asking', () => {
    const state = apply(INITIAL_APPROVALS, question('q', 1), pending('p', 2));
    expect(state.pending.q.questions).toEqual(QUESTIONS);
    expect(agentsWithPending(state.pending).get(1)).toBe(QUESTION_LABEL_TEXT);
    expect(agentsWithPending(state.pending).get(2)).toBe(APPROVAL_LABEL_TEXT);
  });

  it('a question card says answer / skip, not allow / deny', () => {
    const state = approvalsReducer(apply(INITIAL_APPROVALS, question('q', 1)), {
      type: 'open',
      agentId: 1,
    });
    const card = state.card!;
    expect(approvalCardFooter(card, false)).toEqual({
      kind: 'buttons',
      disabled: false,
      note: QUESTION_SCOPE_NOTE,
    });
    expect(approvalCardFooter(card, true)).toEqual({
      kind: 'readOnly',
      note: QUESTION_READ_ONLY_NOTE,
    });
    expect(approvalCardFooter({ ...card, outcome: 'allowed' }, false)).toMatchObject({
      text: '✅ Answered',
    });
    expect(approvalCardFooter({ ...card, outcome: 'denied' }, false)).toMatchObject({
      text: '⏭️ Skipped',
    });
  });

  it('a draft: single-select takes one option, multi-select toggles, Other counts', () => {
    let draft = emptyDraft(QUESTIONS);
    expect(draftComplete(draft)).toBe(false);
    draft = toggleDraftOption(draft, QUESTIONS, 0, 0);
    draft = toggleDraftOption(draft, QUESTIONS, 0, 1);
    expect(draft[0].options).toEqual([1]);
    draft = toggleDraftOption(draft, QUESTIONS, 0, 1);
    expect(draft[0].options).toEqual([]);
    draft = toggleDraftOption(draft, QUESTIONS, 0, 0);
    draft = toggleDraftOption(draft, QUESTIONS, 1, 2);
    draft = toggleDraftOption(draft, QUESTIONS, 1, 0);
    draft = toggleDraftOption(draft, QUESTIONS, 1, 2);
    expect(draft[1].options).toEqual([0]);
    expect(draftComplete(draft)).toBe(true);
    draft = setDraftOther(draft, 1, '  a NAS  ');
    expect(draftAnswers(draft)).toEqual([{ options: [0] }, { options: [0], other: 'a NAS' }]);
    const otherOnly = setDraftOther(emptyDraft(QUESTIONS.slice(0, 1)), 0, 'neither');
    expect(draftComplete(otherOnly)).toBe(true);
    expect(draftComplete(setDraftOther(otherOnly, 0, '   '))).toBe(false);
  });

  it('labels the card with the machine of a relayed session', () => {
    expect(approvalAgentLabel('pixel-agents', 'Fix it', 'Mac')).toBe('pixel-agents · Fix it · Mac');
  });
});

describe('auto-open (TV mode)', () => {
  it('opens the oldest pending request when no card is open', () => {
    const state = apply(INITIAL_APPROVALS, pending('new', 2, 20), question('old', 1, 10));
    const opened = approvalsReducer(state, { type: 'autoOpen' });
    expect(opened.card?.request.requestId).toBe('old');
    // An open card is never swapped out.
    const again = approvalsReducer(apply(opened, pending('newest', 3, 30)), { type: 'autoOpen' });
    expect(again.card?.request.requestId).toBe('old');
  });

  it('a card closed unanswered stays closed; the next request opens instead', () => {
    let state = apply(INITIAL_APPROVALS, pending('a', 1, 10), pending('b', 2, 20));
    state = approvalsReducer(state, { type: 'autoOpen' });
    state = approvalsReducer(state, { type: 'close' });
    expect(state.dismissed).toEqual({ a: true });
    state = approvalsReducer(state, { type: 'autoOpen' });
    expect(state.card?.request.requestId).toBe('b');
    // Clicking the agent still opens a dismissed request on purpose.
    state = approvalsReducer(state, { type: 'close' });
    state = approvalsReducer(state, { type: 'autoOpen' });
    expect(state.card).toBeNull();
    expect(approvalsReducer(state, { type: 'open', agentId: 1 }).card?.request.requestId).toBe('a');
  });

  it('closing an answered or resolved card dismisses nothing; resolution forgets dismissals', () => {
    let state = apply(INITIAL_APPROVALS, pending('a', 1));
    state = approvalsReducer(state, { type: 'autoOpen' });
    state = approvalsReducer(state, { type: 'answer', behavior: 'allow' });
    state = approvalsReducer(state, { type: 'close' });
    expect(state.dismissed).toEqual({});
    state = approvalsReducer(apply(state, pending('b', 2)), { type: 'open', agentId: 2 });
    state = approvalsReducer(state, { type: 'close' });
    expect(state.dismissed).toEqual({ b: true });
    state = apply(state, {
      type: 'permissionResolved',
      requestId: 'b',
      id: 2,
      outcome: 'answeredInTerminal',
    });
    expect(state.dismissed).toEqual({});
  });
});

describe('agentClickAction', () => {
  it('a pending request opens its card, from any machine', () => {
    expect(agentClickAction({ hasPending: true, needsPermission: true })).toBe('card');
    expect(agentClickAction({ hasPending: true, machine: 'Mac', needsPermission: true })).toBe(
      'card',
    );
  });

  it('a relayed session asking without a card gets the setup hint', () => {
    expect(agentClickAction({ hasPending: false, machine: 'Mac', needsPermission: true })).toBe(
      'setupHint',
    );
    expect(remoteSetupHint('Mac').join(' ')).toMatch(/Mac's ~\/\.claude\/settings\.json/);
  });

  it('anything else focuses as before', () => {
    expect(agentClickAction({ hasPending: false, machine: 'Mac', needsPermission: false })).toBe(
      'focus',
    );
    expect(agentClickAction({ hasPending: false, needsPermission: true })).toBe('focus');
  });
});
