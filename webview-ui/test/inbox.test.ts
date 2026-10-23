/**
 * The "Needs you" inbox (docs/office/DESIGN.md, phase G), pure: who is
 * waiting on the user and why, oldest first; the "Paused by usage limit"
 * group; the label / strip strings; the one URL shape "Open in Claude"
 * opens; the client store's reducer; and the routing exception that keeps a
 * paused agent at its desk instead of on the smoking terrace.
 *
 * Run with: npm test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { ServerMessage } from '../../core/src/messages.js';
import type { InboxAgent } from '../src/inbox/inboxModel.js';
import {
  buildInbox,
  formatClock,
  formatDuration,
  inboxLabel,
  pausedSummary,
  pausedTag,
  resumeText,
  safeClaudeUrl,
} from '../src/inbox/inboxModel.js';
import { EMPTY_INBOX, reduceInbox } from '../src/inbox/inboxState.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { DestinationSignals } from '../src/office/engine/zoneRouting.js';
import { Destination, pickDestination } from '../src/office/engine/zoneRouting.js';
import { ZoneLabel } from '../src/office/zones.js';
import { installZoneCatalog, run, zonedOffice } from './livingOfficeFixture.js';

beforeAll(installZoneCatalog);

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 14:00 local time on 2026-10-18. */
const NOW = new Date(2026, 9, 18, 14, 0, 0).getTime();
const at = (h: number, m = 0, dayOffset = 0) =>
  new Date(2026, 9, 18 + dayOffset, h, m, 0, 0).getTime();

const agent = (id: number, over: Partial<InboxAgent> = {}): InboxAgent => ({
  id,
  permission: false,
  asking: false,
  ...over,
});

describe('buildInbox', () => {
  it('lists every agent waiting on the user, oldest wait first, with its reason', () => {
    const inbox = buildInbox(
      [
        agent(1, { status: 'waiting', waitingSince: NOW - 5 * MIN }),
        agent(2, { permission: true, permissionSince: NOW - 20 * MIN }),
        agent(3), // working
        agent(4, { asking: true, askingSince: NOW - 10 * MIN }),
      ],
      NOW,
    );
    expect(inbox.waiting.map((r) => [r.id, r.reason])).toEqual([
      [2, 'permission'],
      [4, 'question'],
      [1, 'done'],
    ]);
    expect(inbox.waiting[0].since).toBe(NOW - 20 * MIN);
    expect(inbox.paused).toEqual([]);
  });

  it('ranks a question over a permission over a finished turn for one agent', () => {
    // A live AskUserQuestion raises its own permission prompt: it is a question.
    const both = buildInbox(
      [agent(1, { status: 'waiting', permission: true, asking: true, waitingSince: NOW - MIN })],
      NOW,
    );
    expect(both.waiting).toHaveLength(1);
    expect(both.waiting[0].reason).toBe('question');
    const permission = buildInbox(
      [agent(1, { status: 'waiting', permission: true, waitingSince: NOW - MIN })],
      NOW,
    );
    expect(permission.waiting[0].reason).toBe('permission');
  });

  it('dates a wait it never saw start from now, never in the future', () => {
    const inbox = buildInbox(
      [agent(1, { permission: true }), agent(2, { status: 'waiting', waitingSince: NOW + MIN })],
      NOW,
    );
    expect(inbox.waiting.map((r) => r.since)).toEqual([NOW, NOW]);
  });

  it('puts a paused agent in its own group, never in the waiting list', () => {
    const inbox = buildInbox(
      [
        agent(1, { status: 'waiting', waitingSince: NOW - HOUR, limit: { reason: 'session' } }),
        agent(2, { status: 'waiting', limit: { reason: 'weekly', resetsAt: at(18) } }),
        agent(3, { status: 'waiting', limit: { reason: 'session', resetsAt: at(15) } }),
        agent(4, { status: 'waiting', waitingSince: NOW - MIN }),
      ],
      NOW,
    );
    expect(inbox.waiting.map((r) => r.id)).toEqual([4]);
    // Soonest resume first, unknown resets last.
    expect(inbox.paused.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it('labels a row title · repo · machine', () => {
    expect(inboxLabel({ id: 1, title: 'Fix login', repo: 'web', machine: 'Mac' })).toBe(
      'Fix login · web · Mac',
    );
    expect(inboxLabel({ id: 1, title: 'Fix login', repo: 'web' })).toBe('Fix login · web · local');
    expect(inboxLabel({ id: 1, repo: 'web' })).toBe('web · local');
    expect(inboxLabel({ id: 7 })).toBe('Agent 7 · local');
  });
});

describe('formatting', () => {
  it('formats clock times, with the weekday for another day', () => {
    expect(formatClock(at(18, 30), NOW)).toBe('6:30 pm');
    expect(formatClock(at(0, 5), NOW)).toBe('12:05 am');
    expect(formatClock(at(12), NOW)).toBe('12:00 pm');
    expect(formatClock(at(9, 0, 1), NOW)).toBe('Mon 9:00 am');
  });

  it('formats a countdown', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(14 * MIN)).toBe('14m');
    expect(formatDuration(HOUR + 12 * MIN)).toBe('1h 12m');
    expect(formatDuration(27 * HOUR)).toBe('1d 3h');
    expect(formatDuration(-5)).toBe('0s');
  });

  it('says when a paused agent resumes', () => {
    expect(resumeText({ reason: 'session', resetsAt: NOW + HOUR + 12 * MIN }, NOW)).toBe(
      'session limit · resumes in 1h 12m',
    );
    expect(resumeText({ reason: 'weekly' }, NOW)).toBe('weekly limit · reset time unknown');
    expect(resumeText({ resetsAt: NOW - 1 }, NOW)).toBe('usage limit · resuming');
  });

  it('tags a paused label', () => {
    expect(pausedTag({ reason: 'session', resetsAt: at(18, 30) }, NOW)).toBe(
      '⏸️ paused until 6:30 pm',
    );
    expect(pausedTag({ reason: 'session' }, NOW)).toBe('⏸️ paused');
  });

  it('summarizes the pauses for the TODAY strip', () => {
    expect(pausedSummary({}, NOW)).toBeNull();
    expect(
      pausedSummary({ 1: { resetsAt: at(18, 30) }, 2: { resetsAt: at(16) }, 3: {} }, NOW),
    ).toBe('⏸️ 3 paused · resume 4:00 pm');
    expect(pausedSummary({ 1: {} }, NOW)).toBe('⏸️ 1 paused');
    // Only agents still on the board count.
    expect(pausedSummary({ 1: {}, 9: {} }, NOW, new Set([1]))).toBe('⏸️ 1 paused');
  });
});

describe('Open in Claude: the URL allowlist', () => {
  it('opens claude.ai/code pages over https', () => {
    expect(safeClaudeUrl('https://claude.ai/code/session_012Dp')).toBe(
      'https://claude.ai/code/session_012Dp',
    );
  });

  it('refuses everything else', () => {
    for (const url of [
      undefined,
      '',
      'not a url',
      'http://claude.ai/code/session_1',
      'https://claude.ai/settings',
      'https://claude.ai.evil.com/code/session_1',
      'https://evil.com/claude.ai/code/',
      'https://user:pw@claude.ai/code/session_1',
      'https://claude.ai:8443/code/session_1',
      'javascript:alert(1)',
    ]) {
      expect(safeClaudeUrl(url)).toBeUndefined();
    }
  });
});

describe('reduceInbox', () => {
  const apply = (messages: ServerMessage[], now = NOW) =>
    messages.reduce((state, msg) => reduceInbox(state, msg, now), EMPTY_INBOX);

  it('keeps links and pauses by agent, and drops them on agentClosed', () => {
    const state = apply([
      {
        type: 'agentLink',
        id: 1,
        url: 'https://claude.ai/code/session_1',
        resumeCommand: 'claude --resume a',
      },
      { type: 'agentLimit', id: 1, paused: true, reason: 'session', resetsAt: at(18) },
    ]);
    expect(state.links[1]).toEqual({
      url: 'https://claude.ai/code/session_1',
      resumeCommand: 'claude --resume a',
    });
    expect(state.limits[1]).toEqual({ reason: 'session', resetsAt: at(18) });
    const cleared = reduceInbox(state, { type: 'agentLimit', id: 1, paused: false }, NOW);
    expect(cleared.limits).toEqual({});
    const closed = reduceInbox(state, { type: 'agentClosed', id: 1 }, NOW);
    expect(closed.links).toEqual({});
    expect(closed.limits).toEqual({});
  });

  it('clocks a live question and a permission from when they were seen', () => {
    let state = reduceInbox(
      EMPTY_INBOX,
      {
        type: 'agentToolStart',
        id: 1,
        toolId: 'q1',
        status: 'Waiting',
        toolName: 'AskUserQuestion',
      },
      NOW - 3 * MIN,
    );
    state = reduceInbox(state, { type: 'agentToolPermission', id: 2 }, NOW - MIN);
    // A repeat doesn't restart either clock.
    state = reduceInbox(state, { type: 'agentToolPermission', id: 2 }, NOW);
    expect(state.asking[1]).toEqual({ q1: NOW - 3 * MIN });
    expect(state.permissionSince[2]).toBe(NOW - MIN);
    state = reduceInbox(state, { type: 'agentToolDone', id: 1, toolId: 'q1' }, NOW);
    state = reduceInbox(state, { type: 'agentToolPermissionClear', id: 2 }, NOW);
    expect(state.asking).toEqual({});
    expect(state.permissionSince).toEqual({});
  });

  it('ignores other messages without a new state', () => {
    expect(reduceInbox(EMPTY_INBOX, { type: 'agentSelected', id: 1 }, NOW)).toBe(EMPTY_INBOX);
    expect(
      reduceInbox(
        EMPTY_INBOX,
        { type: 'agentToolStart', id: 1, toolId: 't', status: 'Reading', toolName: 'Read' },
        NOW,
      ),
    ).toBe(EMPTY_INBOX);
  });
});

describe('routing: a paused agent stays at its desk', () => {
  const NONE: DestinationSignals = {
    sleeping: false,
    permission: false,
    askingUser: false,
    testing: false,
    longCommand: false,
    onBreak: false,
    active: false,
    waiting: false,
  };

  it('is not sent to Smoke (or the Lounge) as waiting', () => {
    expect(pickDestination({ ...NONE, waiting: true })).toBe(Destination.SMOKE);
    expect(pickDestination({ ...NONE, waiting: true, paused: true })).toBe(Destination.DESK);
    expect(pickDestination({ ...NONE, waiting: true, sleeping: true, paused: true })).toBe(
      Destination.DESK,
    );
  });

  it('still answers a permission or a question in the Meeting room', () => {
    expect(pickDestination({ ...NONE, paused: true, permission: true })).toBe(Destination.MEETING);
  });

  it('in the office: sits at its desk instead of walking to the terrace, and smokes once un-paused', () => {
    const os: OfficeState = zonedOffice();
    os.addAgent(1, 0, 0, 'd1', true);
    const ch = os.characters.get(1)!;
    os.setAgentPaused(1, true);
    os.setAgentActive(1, false);
    run(os, 15);
    expect(ch.zoneTarget?.zone ?? null).not.toBe(ZoneLabel.SMOKE);
    os.setAgentPaused(1, false);
    run(os, 15);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.SMOKE);
  });
});
