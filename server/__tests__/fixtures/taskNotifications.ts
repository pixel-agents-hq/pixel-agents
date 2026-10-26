/**
 * Background-agent notices as Claude Code 2.1.309 writes them to the lead's
 * transcript (queue-operation content), copied from a real session
 * (2026-10-25). The interim one arrives while the agent still lives: it
 * stopped to wait on background work of its own. Its first notice names the
 * spawn's tool id; the ones after it name only the task id.
 */

export function interimNotice(taskId: string, toolUseId?: string): string {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    ...(toolUseId ? [`<tool-use-id>${toolUseId}</tool-use-id>`] : []),
    `<output-file>/tmp/claude-501/tasks/${taskId}.output</output-file>`,
    '<status>completed</status>',
    '<summary>Agent "Rebase layers 2-8 on 1" is waiting on its own background work</summary>',
    '<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>',
    '<result>This agent has not reported yet: it is waiting on its own background work and will deliver its report through SubagentHandback when that finishes.',
    '</result>',
    '<usage><total_tokens>81234</total_tokens><tool_uses>57</tool_uses><duration_ms>242000</duration_ms></usage>',
    '</task-notification>',
  ].join('\n');
}

export function finishedNotice(taskId: string, toolUseId?: string): string {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    ...(toolUseId ? [`<tool-use-id>${toolUseId}</tool-use-id>`] : []),
    `<output-file>/tmp/claude-501/tasks/${taskId}.output</output-file>`,
    '<status>completed</status>',
    '<summary>Agent "Apply review to layer 1" finished</summary>',
    '<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>',
    `<result>This agent's report was delivered to you as a message from "${taskId}" (its SubagentHandback call). Read it there; it is not repeated here.`,
    '</result>',
    '<usage><total_tokens>40211</total_tokens><tool_uses>31</tool_uses><duration_ms>180000</duration_ms></usage>',
    '</task-notification>',
  ].join('\n');
}

/** The queue-operation record that carries a notice. */
export function noticeRecord(content: string): string {
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content });
}
