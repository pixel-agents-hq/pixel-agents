import { APPROVALS_OFF_VALUES } from './constants.js';

/**
 * Whether approvals from the board are switched off. Two switches, either one
 * enough: the PIXEL_AGENTS_APPROVALS env var set to an off value, or
 * `approvalsEnabled: false` at the top level of ~/.pixel-agents/config.json
 * (absent = on). Shared by the hook script (which then never waits on the
 * board) and the server (which then answers every wait with no decision), so
 * the two can't disagree about what "off" means.
 *
 * `config` is the parsed config file as-is (unknown shape), so the hook script
 * can pass what it read without depending on configPersistence.
 */
export function approvalsSwitchedOff(envValue: string | undefined, config: unknown): boolean {
  if (envValue !== undefined) {
    const normalized = envValue.trim().toLowerCase();
    if ((APPROVALS_OFF_VALUES as readonly string[]).includes(normalized)) return true;
  }
  return (
    config !== null &&
    typeof config === 'object' &&
    (config as { approvalsEnabled?: unknown }).approvalsEnabled === false
  );
}
