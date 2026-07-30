import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';

describe('claudeTeamProvider', () => {
  describe('identity', () => {
    it('has providerId "claude"', () => {
      expect(claudeTeamProvider.providerId).toBe('claude');
    });

    it('spawns teammates via "Agent" tool', () => {
      expect(claudeTeamProvider.teammateSpawnTools.has('Agent')).toBe(true);
    });

    it('uses "Task" for within-turn subagents', () => {
      expect(claudeTeamProvider.withinTurnSubagentTools.has('Task')).toBe(true);
    });
  });

  describe.each([
    { tool: 'Agent', input: { run_in_background: true }, expected: true },
    { tool: 'Agent', input: { run_in_background: false }, expected: false },
    { tool: 'Agent', input: {}, expected: false },
    // Non-boolean run_in_background must not trigger the teammate path.
    { tool: 'Agent', input: { run_in_background: 'true' }, expected: false },
    { tool: 'Agent', input: { run_in_background: 1 }, expected: false },
    // Task/arbitrary tools never spawn teammates regardless of flags.
    { tool: 'Task', input: { run_in_background: true }, expected: false },
    { tool: 'Read', input: {}, expected: false },
    { tool: 'WebSearch', input: { run_in_background: true }, expected: false },
  ])('isTeammateSpawnCall($tool, $input)', ({ tool, input, expected }) => {
    it(`returns ${expected}`, () => {
      expect(claudeTeamProvider.isTeammateSpawnCall(tool, input)).toBe(expected);
    });
  });

  describe('extractTeammateNameFromEvent', () => {
    it('reads current teammate_name when present', () => {
      expect(
        claudeTeamProvider.extractTeammateNameFromEvent({ teammate_name: 'web-researcher' }),
      ).toBe('web-researcher');
    });

    it('falls back to agent_type for SubagentStart compatibility', () => {
      expect(
        claudeTeamProvider.extractTeammateNameFromEvent({ agent_type: 'web-researcher' }),
      ).toBe('web-researcher');
    });

    it('prefers teammate_name when both names are present', () => {
      expect(
        claudeTeamProvider.extractTeammateNameFromEvent({
          teammate_name: 'web-researcher',
          agent_type: 'legacy-agent-type',
        }),
      ).toBe('web-researcher');
    });

    it('falls back when teammate_name is not a string', () => {
      expect(
        claudeTeamProvider.extractTeammateNameFromEvent({
          teammate_name: 42,
          agent_type: 'web-researcher',
        }),
      ).toBe('web-researcher');
    });

    it('returns undefined when teammate identity is missing or malformed', () => {
      expect(claudeTeamProvider.extractTeammateNameFromEvent({})).toBeUndefined();
      expect(
        claudeTeamProvider.extractTeammateNameFromEvent({ teammate_name: null, agent_type: 42 }),
      ).toBeUndefined();
    });
  });

  describe('discoverTeammates', () => {
    const fsMod = require('fs') as typeof import('fs');
    const tmpRoot = path.join(os.tmpdir(), 'pixel-agents-discover-' + Date.now());

    afterEach(() => {
      try {
        fsMod.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('returns empty array when teammate directory does not exist', () => {
      const result = claudeTeamProvider.discoverTeammates(tmpRoot, 'nonexistent-sess');
      expect(result).toEqual([]);
    });

    it('skips jsonl files without a valid sidecar', () => {
      const sessDir = path.join(tmpRoot, 'sess-1', 'subagents');
      fsMod.mkdirSync(sessDir, { recursive: true });
      fsMod.writeFileSync(path.join(sessDir, 'orphan.jsonl'), '{}');
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-1')).toEqual([]);
    });

    it('returns jsonlPath + teammateName for each valid teammate', () => {
      const sessDir = path.join(tmpRoot, 'sess-1', 'subagents');
      fsMod.mkdirSync(sessDir, { recursive: true });
      const agentA = path.join(sessDir, 'agent-a.jsonl');
      const agentB = path.join(sessDir, 'agent-b.jsonl');
      fsMod.writeFileSync(agentA, '');
      fsMod.writeFileSync(
        agentA.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"web-researcher"}',
      );
      fsMod.writeFileSync(agentB, '');
      fsMod.writeFileSync(
        agentB.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"code-reviewer"}',
      );
      const result = claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-1');
      expect(result.map((t) => t.teammateName).sort()).toEqual(['code-reviewer', 'web-researcher']);
      expect(result.every((t) => t.jsonlPath.endsWith('.jsonl'))).toBe(true);
    });

    it('exposes the sidecar name when present (named background spawn)', () => {
      const sessDir = path.join(tmpRoot, 'sess-1', 'subagents');
      fsMod.mkdirSync(sessDir, { recursive: true });
      const agentA = path.join(sessDir, 'agent-a.jsonl');
      fsMod.writeFileSync(agentA, '');
      fsMod.writeFileSync(
        agentA.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"general-purpose","toolUseId":"toolu_1","description":"Write a haiku","name":"ghost-writer"}',
      );
      const result = claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-1');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('ghost-writer');
      expect(result[0].toolUseId).toBe('toolu_1');
      expect(result[0].description).toBe('Write a haiku');
    });

    it('leaves name undefined when absent or malformed (unnamed spawn)', () => {
      const sessDir = path.join(tmpRoot, 'sess-1', 'subagents');
      fsMod.mkdirSync(sessDir, { recursive: true });
      const unnamed = path.join(sessDir, 'agent-a.jsonl');
      fsMod.writeFileSync(unnamed, '');
      fsMod.writeFileSync(
        unnamed.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"general-purpose","toolUseId":"toolu_1"}',
      );
      const malformed = path.join(sessDir, 'agent-b.jsonl');
      fsMod.writeFileSync(malformed, '');
      fsMod.writeFileSync(
        malformed.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"general-purpose","toolUseId":"toolu_2","name":42}',
      );
      const result = claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-1');
      expect(result).toHaveLength(2);
      expect(result.every((t) => t.name === undefined)).toBe(true);
    });
  });

  describe('extractTeammateSpawnFromToolResult', () => {
    const spawnText =
      'Spawned successfully. (This tool result is internal metadata.)\n' +
      'agent_id: wa-broadcast-safety-research@session-029c4a18\nname: wa-broadcast-safety-research';

    it('extracts teammate name + team from an Agent spawn result (block array)', () => {
      expect(
        claudeTeamProvider.extractTeammateSpawnFromToolResult!('Agent', [
          { type: 'text', text: spawnText },
        ]),
      ).toEqual({
        teammateName: 'wa-broadcast-safety-research',
        teamName: 'session-029c4a18',
      });
    });

    it('extracts from plain string content', () => {
      expect(claudeTeamProvider.extractTeammateSpawnFromToolResult!('Agent', spawnText)).toEqual({
        teammateName: 'wa-broadcast-safety-research',
        teamName: 'session-029c4a18',
      });
    });

    it('returns null for non-spawn tools even when the text matches', () => {
      expect(claudeTeamProvider.extractTeammateSpawnFromToolResult!('Task', spawnText)).toBeNull();
      expect(claudeTeamProvider.extractTeammateSpawnFromToolResult!('Read', spawnText)).toBeNull();
    });

    it('returns null for Agent results without an agent_id line', () => {
      expect(
        claudeTeamProvider.extractTeammateSpawnFromToolResult!('Agent', [
          { type: 'text', text: 'Async agent launched successfully.' },
        ]),
      ).toBeNull();
      expect(claudeTeamProvider.extractTeammateSpawnFromToolResult!('Agent', undefined)).toBeNull();
    });
  });

  describe('discoverTeammates (new-style: top-level tagged sessions)', () => {
    const fsMod = require('fs') as typeof import('fs');
    const tmpRoot = path.join(os.tmpdir(), 'pixel-agents-discover-new-' + Date.now());
    const LEAD_SESSION = '11111111-1111-4111-8111-111111111111';
    const MATE_SESSION = '22222222-2222-4222-8222-222222222222';
    const TEAM = 'session-abc12345';

    /** Teammate transcript as newer harnesses write it: setting records first
     *  (no team tags), tags appear on the first user record. */
    function writeTeammateFile(sessionId: string, teamName: string, agentName: string): string {
      const p = path.join(tmpRoot, `${sessionId}.jsonl`);
      fsMod.writeFileSync(
        p,
        JSON.stringify({ type: 'agent-setting', agentSetting: 'general-purpose', sessionId }) +
          '\n' +
          JSON.stringify({ type: 'mode', mode: 'default' }) +
          '\n' +
          JSON.stringify({
            type: 'user',
            teamName,
            agentName,
            message: { role: 'user', content: 'go' },
          }) +
          '\n',
      );
      return p;
    }

    afterEach(() => {
      try {
        fsMod.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('finds top-level teammate sessions tagged with the team, with their own sessionId', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      // Lead's own transcript: untagged user record, must never be a teammate.
      fsMod.writeFileSync(
        path.join(tmpRoot, `${LEAD_SESSION}.jsonl`),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
      );
      writeTeammateFile(MATE_SESSION, TEAM, 'wa-research');

      const result = claudeTeamProvider.discoverTeammates(tmpRoot, LEAD_SESSION, TEAM);
      expect(result).toEqual([
        {
          jsonlPath: path.join(tmpRoot, `${MATE_SESSION}.jsonl`),
          teammateName: 'wa-research',
          sessionId: MATE_SESSION,
        },
      ]);
    });

    it('ignores sessions tagged with a different team', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      writeTeammateFile(MATE_SESSION, 'session-other000', 'stranger');
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, LEAD_SESSION, TEAM)).toEqual([]);
    });

    it('skips new-style scanning entirely when teamName is not provided', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      writeTeammateFile(MATE_SESSION, TEAM, 'wa-research');
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, LEAD_SESSION)).toEqual([]);
    });

    it('re-checks settings-only files on later scans (tags arrive after creation)', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      const p = path.join(tmpRoot, `${MATE_SESSION}.jsonl`);
      // Freshly created transcript: only setting records so far.
      fsMod.writeFileSync(
        p,
        JSON.stringify({ type: 'agent-setting', agentSetting: 'general-purpose' }) + '\n',
      );
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, LEAD_SESSION, TEAM)).toEqual([]);
      // Tagged user record lands -> next scan must pick it up.
      fsMod.appendFileSync(
        p,
        JSON.stringify({
          type: 'user',
          teamName: TEAM,
          agentName: 'late-bloomer',
          message: { role: 'user', content: 'go' },
        }) + '\n',
      );
      const result = claudeTeamProvider.discoverTeammates(tmpRoot, LEAD_SESSION, TEAM);
      expect(result.map((t) => t.teammateName)).toEqual(['late-bloomer']);
    });

    it('combines old-style sidecar teammates with new-style tagged sessions', () => {
      const sessDir = path.join(tmpRoot, LEAD_SESSION, 'subagents');
      fsMod.mkdirSync(sessDir, { recursive: true });
      const oldStyle = path.join(sessDir, 'agent-a.jsonl');
      fsMod.writeFileSync(oldStyle, '');
      fsMod.writeFileSync(
        oldStyle.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"web-researcher"}',
      );
      writeTeammateFile(MATE_SESSION, TEAM, 'wa-research');

      const result = claudeTeamProvider.discoverTeammates(tmpRoot, LEAD_SESSION, TEAM);
      expect(result.map((t) => t.teammateName).sort()).toEqual(['wa-research', 'web-researcher']);
      const oldEntry = result.find((t) => t.teammateName === 'web-researcher')!;
      expect(oldEntry.sessionId).toBeUndefined();
    });
  });

  describe('getTeamMetadataForSession', () => {
    const fsMod = require('fs') as typeof import('fs');
    const tmpRoot = path.join(os.tmpdir(), 'pixel-agents-meta-' + Date.now());

    afterEach(() => {
      try {
        fsMod.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('returns null when file does not exist', () => {
      expect(
        claudeTeamProvider.getTeamMetadataForSession(path.join(tmpRoot, 'missing.jsonl')),
      ).toBeNull();
    });

    it('returns null when first line has no teamName', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      const p = path.join(tmpRoot, 'no-team.jsonl');
      fsMod.writeFileSync(p, JSON.stringify({ other: 'value' }) + '\n');
      expect(claudeTeamProvider.getTeamMetadataForSession(p)).toBeNull();
    });

    it('extracts teamName + agentName from the first JSONL line', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      const p = path.join(tmpRoot, 'teammate.jsonl');
      fsMod.writeFileSync(
        p,
        JSON.stringify({ teamName: 'research', agentName: 'web-researcher' }) +
          '\n' +
          JSON.stringify({ other: 'should-be-ignored' }) +
          '\n',
      );
      expect(claudeTeamProvider.getTeamMetadataForSession(p)).toEqual({
        teamName: 'research',
        agentName: 'web-researcher',
      });
    });

    it('agentName is undefined for the lead (no agentName field)', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      const p = path.join(tmpRoot, 'lead.jsonl');
      fsMod.writeFileSync(p, JSON.stringify({ teamName: 'research' }) + '\n');
      expect(claudeTeamProvider.getTeamMetadataForSession(p)).toEqual({
        teamName: 'research',
        agentName: undefined,
      });
    });

    it('scans past untagged setting records to find team tags (newer harnesses)', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      const p = path.join(tmpRoot, 'new-style.jsonl');
      fsMod.writeFileSync(
        p,
        JSON.stringify({ type: 'agent-setting', agentSetting: 'general-purpose' }) +
          '\n' +
          JSON.stringify({ type: 'mode', mode: 'default' }) +
          '\n' +
          JSON.stringify({ type: 'user', teamName: 'session-abc12345', agentName: 'researcher' }) +
          '\n',
      );
      expect(claudeTeamProvider.getTeamMetadataForSession(p)).toEqual({
        teamName: 'session-abc12345',
        agentName: 'researcher',
      });
    });

    it('returns null when the first conversational record is untagged', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      const p = path.join(tmpRoot, 'plain-session.jsonl');
      fsMod.writeFileSync(
        p,
        JSON.stringify({ type: 'mode', mode: 'default' }) +
          '\n' +
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) +
          '\n' +
          JSON.stringify({ type: 'assistant', teamName: 'too-late' }) +
          '\n',
      );
      expect(claudeTeamProvider.getTeamMetadataForSession(p)).toBeNull();
    });
  });

  describe('getTeamMembers', () => {
    // Writes under ~/.claude/teams/<TEAM_NAME>/ and cleans up in afterEach.
    const fs = require('fs') as typeof import('fs');
    const TEAM_NAME = 'test-team-' + Date.now();

    afterEach(() => {
      // Cleanup any test artifacts
      try {
        fs.rmSync(path.join(os.homedir(), '.claude', 'teams', TEAM_NAME), {
          recursive: true,
          force: true,
        });
      } catch {
        /* ignore */
      }
    });

    it('returns null when the team config does not exist', () => {
      const result = claudeTeamProvider.getTeamMembers('nonexistent-team-xyz-' + Date.now());
      expect(result).toBeNull();
    });

    it('returns members when config is well-formed', () => {
      const teamDir = path.join(os.homedir(), '.claude', 'teams', TEAM_NAME);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [{ name: 'team-lead' }, { name: 'web-researcher' }],
        }),
      );
      const result = claudeTeamProvider.getTeamMembers(TEAM_NAME);
      expect(result).not.toBeNull();
      expect([...result!].sort()).toEqual(['team-lead', 'web-researcher']);
    });

    it('returns null when config is not valid JSON', () => {
      const teamDir = path.join(os.homedir(), '.claude', 'teams', TEAM_NAME);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(path.join(teamDir, 'config.json'), 'not json');
      expect(claudeTeamProvider.getTeamMembers(TEAM_NAME)).toBeNull();
    });

    it('excludes members marked isActive:false (finished one-shot teammates)', () => {
      const teamDir = path.join(os.homedir(), '.claude', 'teams', TEAM_NAME);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [
            { name: 'team-lead' },
            { name: 'still-running', isActive: true },
            { name: 'finished', isActive: false },
          ],
        }),
      );
      const result = claudeTeamProvider.getTeamMembers(TEAM_NAME);
      expect([...result!].sort()).toEqual(['still-running', 'team-lead']);
    });

    it('skips members without a string name', () => {
      const teamDir = path.join(os.homedir(), '.claude', 'teams', TEAM_NAME);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [
            { name: 'valid' },
            { agentType: 'no-name' },
            { name: 42 },
            { name: 'also-valid' },
          ],
        }),
      );
      const result = claudeTeamProvider.getTeamMembers(TEAM_NAME);
      expect([...result!].sort()).toEqual(['also-valid', 'valid']);
    });
  });

  describe('extractTeamMetadataFromRecord', () => {
    it('returns teamName + agentName when both present', () => {
      expect(
        claudeTeamProvider.extractTeamMetadataFromRecord({
          teamName: 'research',
          agentName: 'web-researcher',
        }),
      ).toEqual({ teamName: 'research', agentName: 'web-researcher' });
    });

    it('returns teamName with undefined agentName for the lead', () => {
      expect(claudeTeamProvider.extractTeamMetadataFromRecord({ teamName: 'research' })).toEqual({
        teamName: 'research',
        agentName: undefined,
      });
    });

    it('returns null when teamName is missing', () => {
      expect(claudeTeamProvider.extractTeamMetadataFromRecord({})).toBeNull();
    });

    it('returns null when teamName is not a string', () => {
      expect(claudeTeamProvider.extractTeamMetadataFromRecord({ teamName: 42 })).toBeNull();
    });
  });
});
