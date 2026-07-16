import { type ClaudeMockScenarioBuilder } from './mock-claude';

export const INLINE_TEAMMATE_ROLE = 'web-researcher';
export const INLINE_TEAMMATE_ALIAS = 'teammate';
export const INLINE_TEAMMATE_SLUG = `agent-${INLINE_TEAMMATE_ROLE}`;
export const TMUX_TEAMMATE_ALIAS = 'tmux-teammate';

export function uniqueTeamName(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

export function inlineTeammateSlug(role: string): string {
  return `agent-${role}`;
}

export function withNamedInlineTeammateSession(
  builder: ClaudeMockScenarioBuilder,
  alias: string,
  role: string,
): ClaudeMockScenarioBuilder {
  const slug = inlineTeammateSlug(role);
  return builder.defineSession(alias, slug, {
    transcriptPathTemplate: `{{projectDir}}/{{sessionId}}/subagents/${slug}.jsonl`,
    sidecarPathTemplate: `{{projectDir}}/{{sessionId}}/subagents/${slug}.meta.json`,
    sidecarJson: {
      agentType: role,
    },
  });
}

export function withInlineTeammateSessions(
  builder: ClaudeMockScenarioBuilder,
  teammates: Array<{ alias: string; role: string }>,
): ClaudeMockScenarioBuilder {
  let scenario = builder;
  for (const teammate of teammates) {
    scenario = withNamedInlineTeammateSession(scenario, teammate.alias, teammate.role);
  }
  return scenario;
}

export function withInlineTeammateSession(
  builder: ClaudeMockScenarioBuilder,
): ClaudeMockScenarioBuilder {
  return withNamedInlineTeammateSession(builder, INLINE_TEAMMATE_ALIAS, INLINE_TEAMMATE_ROLE);
}

export function withTmuxTeammateSession(
  builder: ClaudeMockScenarioBuilder,
): ClaudeMockScenarioBuilder {
  return builder.defineSession(TMUX_TEAMMATE_ALIAS, '{{sessionId}}-tmux');
}
