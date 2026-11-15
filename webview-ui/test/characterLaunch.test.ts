import { describe, expect, it } from 'vitest';

import type { CharacterProfile } from '../../core/src/characterProfiles.js';
import { isCharacterLaunch } from '../../core/src/characterProfiles.js';
import type { LaunchRole } from '../../core/src/messages.js';
import {
  isValidLaunchValue,
  launchBadge,
  launchSummary,
  normalizeLaunch,
  offeredRoles,
  pathBasename,
  roleModel,
  setLaunchField,
} from '../src/characters/launch.js';

const profile = (launch?: CharacterProfile['launch']): CharacterProfile =>
  ({ body: 'flat', ...(launch ? { launch } : {}) }) as CharacterProfile;

describe('normalizeLaunch', () => {
  it('is undefined for nothing, an empty draft or only blanks', () => {
    expect(normalizeLaunch(undefined)).toBeUndefined();
    expect(normalizeLaunch({})).toBeUndefined();
    expect(normalizeLaunch({ agent: '', model: '  ', effort: null })).toBeUndefined();
  });

  it('trims and keeps valid fields', () => {
    expect(normalizeLaunch({ agent: ' reviewer ', model: 'sonnet[1m]', effort: 'high' })).toEqual({
      agent: 'reviewer',
      model: 'sonnet[1m]',
      effort: 'high',
    });
  });

  it('drops invalid custom values', () => {
    expect(normalizeLaunch({ agent: 'rm -rf /', model: 'opus; ls', effort: 'extreme' })).toBe(
      undefined,
    );
    expect(normalizeLaunch({ agent: 'ok', model: '$(whoami)' })).toEqual({ agent: 'ok' });
  });

  it('only ever yields what the server accepts', () => {
    const out = normalizeLaunch({ agent: 'a.b_c-d', model: 'claude-opus-5-5', effort: 'max' });
    expect(isCharacterLaunch(out)).toBe(true);
  });
});

describe('isValidLaunchValue', () => {
  it('follows the core patterns per field', () => {
    expect(isValidLaunchValue('agent', 'code-reviewer')).toBe(true);
    expect(isValidLaunchValue('agent', 'has space')).toBe(false);
    expect(isValidLaunchValue('agent', 'x'.repeat(65))).toBe(false);
    expect(isValidLaunchValue('model', 'claude-haiku-4-5:latest')).toBe(true);
    expect(isValidLaunchValue('model', 'a|b')).toBe(false);
    expect(isValidLaunchValue('effort', 'xhigh')).toBe(true);
    expect(isValidLaunchValue('effort', 'High')).toBe(false);
  });
});

describe('setLaunchField', () => {
  it('adds launch on the first setting', () => {
    const p = profile();
    expect(setLaunchField(p, 'model', 'opus')).toBe(true);
    expect(p.launch).toEqual({ model: 'opus' });
  });

  it('removes launch when every field is back to its default', () => {
    const p = profile({ agent: 'planner', effort: 'low' });
    setLaunchField(p, 'agent', null);
    expect(p.launch).toEqual({ effort: 'low' });
    setLaunchField(p, 'effort', '');
    expect(p).not.toHaveProperty('launch');
  });

  it('rejects an invalid value and leaves the profile alone', () => {
    const p = profile({ agent: 'planner' });
    expect(setLaunchField(p, 'agent', 'bad name')).toBe(false);
    expect(p.launch).toEqual({ agent: 'planner' });
  });
});

describe('summaries', () => {
  it('joins the set fields and picks one word for a badge', () => {
    expect(launchSummary(undefined)).toBe('');
    expect(launchSummary({ agent: 'a', effort: 'max' })).toBe('a · max');
    expect(launchBadge({ model: 'opus', effort: 'low' })).toBe('opus');
    expect(launchBadge({ effort: 'low' })).toBe('low');
    expect(launchBadge(undefined)).toBe('');
  });

  it('names a Directory by its folder', () => {
    expect(pathBasename('/Users/me/work/app/')).toBe('app');
    expect(pathBasename('C:\\code\\site')).toBe('site');
  });
});

describe('offeredRoles', () => {
  const roles: LaunchRole[] = [
    { name: 'p', scope: 'project', directory: '/a', model: 'haiku' },
    { name: 'u', scope: 'user', model: 'sonnet' },
    { name: 'p', scope: 'project', directory: '/b' },
    { name: 'u', scope: 'user' },
  ];

  it('lists user roles first, each definition once', () => {
    expect(offeredRoles(roles).map((r) => `${r.name}${r.directory ?? ''}`)).toEqual([
      'u',
      'p/a',
      'p/b',
    ]);
  });

  it("reads a role's model from its first definition", () => {
    expect(roleModel(roles, 'u')).toBe('sonnet');
    expect(roleModel(roles, 'p')).toBe('haiku');
    expect(roleModel(roles, 'missing')).toBeUndefined();
    expect(roleModel(roles, undefined)).toBeUndefined();
  });
});
