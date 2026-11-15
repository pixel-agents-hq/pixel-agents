/**
 * Tool status text in the UI's language. The provider sends its statuses in
 * English ("Reading foo.ts", "Running: npm test" — Claude's formatToolStatus),
 * and toolUtils.ts reads those English prefixes for animation, so the wire
 * text stays as it is: this re-words it only where it is shown, keeping the
 * variable part (file, command, description) as sent. Anything it doesn't
 * recognize is shown unchanged.
 */

import type { MessageKey, MessageVars } from '../i18n/index.js';
import { t } from '../i18n/index.js';

type Rule =
  { exact: string; key: MessageKey } | { prefix: string; key: MessageKey; varName: string };

/** Exact texts first: "Editing notebook" and "Running subtask" would otherwise
 *  match the "Editing " / "Running" prefixes. */
const RULES: readonly Rule[] = [
  { exact: 'Running subtask', key: 'office.statusRunningSubtask' },
  { exact: 'Searching files', key: 'office.statusSearchingFiles' },
  { exact: 'Searching code', key: 'office.statusSearchingCode' },
  { exact: 'Fetching web content', key: 'office.statusFetchingWeb' },
  { exact: 'Searching the web', key: 'office.statusSearchingWeb' },
  { exact: 'Waiting for your answer', key: 'office.statusWaitingForAnswer' },
  { exact: 'Planning', key: 'office.statusPlanning' },
  { exact: 'Editing notebook', key: 'office.statusEditingNotebook' },
  { exact: 'Creating team', key: 'office.statusCreatingTeam' },
  { exact: 'Sending message', key: 'office.statusSendingMessage' },
  { prefix: 'Reading ', key: 'office.statusReading', varName: 'file' },
  { prefix: 'Editing ', key: 'office.statusEditing', varName: 'file' },
  { prefix: 'Writing ', key: 'office.statusWriting', varName: 'file' },
  { prefix: 'Running: ', key: 'office.statusRunning', varName: 'command' },
  { prefix: 'Subtask: ', key: 'office.statusSubtask', varName: 'description' },
  { prefix: 'Creating team: ', key: 'office.statusCreatingTeamNamed', varName: 'team' },
  { prefix: 'Using ', key: 'office.statusUsing', varName: 'tool' },
];

/** A provider's English tool status, in the UI's language (or `translateFn`'s,
 *  for tests); unrecognized text comes back unchanged. */
export function localizeToolStatus(
  status: string,
  translateFn: (key: MessageKey, vars?: MessageVars) => string = t,
): string {
  for (const rule of RULES) {
    if ('exact' in rule) {
      if (status === rule.exact) return translateFn(rule.key);
    } else if (status.startsWith(rule.prefix)) {
      return translateFn(rule.key, { [rule.varName]: status.slice(rule.prefix.length) });
    }
  }
  return status;
}
