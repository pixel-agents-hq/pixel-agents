import type { OfficeTool } from '../tool.js';
import { closeAgent } from './closeAgent.js';
import { editLayout } from './editLayout.js';
import { getLayout } from './getLayout.js';
import { launchAgent } from './launchAgent.js';
import { listAgents } from './listAgents.js';
import { listCatalog } from './listCatalog.js';
import { readAgentTerminal } from './readAgentTerminal.js';
import { sendMessage } from './sendMessage.js';
import { undoLayoutEdit } from './undoLayoutEdit.js';
import { visit } from './visit.js';

/** Every Pixel Office MCP tool, in the order agents see them. A new tool is
 *  its own file in this folder plus one line here. */
export const OFFICE_TOOLS: readonly OfficeTool[] = [
  listAgents,
  getLayout,
  listCatalog,
  readAgentTerminal,
  sendMessage,
  visit,
  launchAgent,
  closeAgent,
  editLayout,
  undoLayoutEdit,
];
