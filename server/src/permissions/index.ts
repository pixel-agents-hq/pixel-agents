import type { AgentStateStore } from '../agentStateStore.js';
import { readConfig } from '../configPersistence.js';
import { PermissionApprovals } from './approvalRegistry.js';
import { appendApprovalLog } from './approvalsLog.js';
import { APPROVALS_ENV } from './constants.js';
import { approvalsSwitchedOff } from './killSwitch.js';

/** The standalone server's approvals: kill switch read per request (env +
 *  config.json), answers appended to ~/.pixel-agents/approvals.log. */
export function createPermissionApprovals(store: AgentStateStore): PermissionApprovals {
  return new PermissionApprovals({
    store,
    isSwitchedOff: () => approvalsSwitchedOff(process.env[APPROVALS_ENV], readConfig()),
    log: (entry) => appendApprovalLog(entry),
  });
}
