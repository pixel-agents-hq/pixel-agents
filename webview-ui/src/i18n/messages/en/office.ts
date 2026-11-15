/** English strings: office. The source of truth — vi/office.ts must carry every key. */
export const office = {
  // Agent label (ToolOverlay)
  needsApproval: 'Needs approval',
  waitingForInput: 'Waiting for input',
  idle: 'Idle',
  subtask: 'Subtask',
  teamLead: 'LEAD',
  closeAgent: 'Close agent',
  contextLeft: '{pct}% context left ({used}k of {max}k tokens used)',

  // Tool statuses: the provider's English status text, re-worded at display
  // time by toolStatusText.ts (the variable part is kept as sent).
  statusReading: 'Reading {file}',
  statusEditing: 'Editing {file}',
  statusWriting: 'Writing {file}',
  statusRunning: 'Running: {command}',
  statusRunningSubtask: 'Running subtask',
  statusSearchingFiles: 'Searching files',
  statusSearchingCode: 'Searching code',
  statusFetchingWeb: 'Fetching web content',
  statusSearchingWeb: 'Searching the web',
  statusSubtask: 'Subtask: {description}',
  statusWaitingForAnswer: 'Waiting for your answer',
  statusPlanning: 'Planning',
  statusEditingNotebook: 'Editing notebook',
  statusCreatingTeam: 'Creating team',
  statusCreatingTeamNamed: 'Creating team: {team}',
  statusSendingMessage: 'Sending message',
  statusUsing: 'Using {tool}',
} as const;
