import type { OfficeTool } from '../tool.js';
import { closeAgent } from './closeAgent.js';
import { closePcShell } from './closePcShell.js';
import { editCharacters } from './editCharacters.js';
import { editDirectories } from './editDirectories.js';
import { editLayout } from './editLayout.js';
import { getFeatureGuide } from './getFeatureGuide.js';
import { getLayout } from './getLayout.js';
import { launchAgent } from './launchAgent.js';
import { listAgents } from './listAgents.js';
import { listCatalog } from './listCatalog.js';
import { listCharacters } from './listCharacters.js';
import { listDirectories } from './listDirectories.js';
import { listPcShells } from './listPcShells.js';
import { listWardrobe } from './listWardrobe.js';
import { openPcShell } from './openPcShell.js';
import { readAgentTerminal } from './readAgentTerminal.js';
import { readPcShell } from './readPcShell.js';
import { sendMessage } from './sendMessage.js';
import { tutorial } from './tutorial.js';
import { typeInPcShell } from './typeInPcShell.js';
import { undoCharacterEdit } from './undoCharacterEdit.js';
import { undoLayoutEdit } from './undoLayoutEdit.js';
import { visit } from './visit.js';

/** Every Pixel Office MCP tool, in the order agents see them. A new tool is
 *  its own file in this folder plus one line here. */
export const OFFICE_TOOLS: readonly OfficeTool[] = [
  listAgents,
  getLayout,
  listCatalog,
  listWardrobe,
  listCharacters,
  editCharacters,
  undoCharacterEdit,
  listDirectories,
  editDirectories,
  readAgentTerminal,
  sendMessage,
  visit,
  launchAgent,
  closeAgent,
  listPcShells,
  openPcShell,
  readPcShell,
  typeInPcShell,
  closePcShell,
  editLayout,
  undoLayoutEdit,
  getFeatureGuide,
  tutorial,
];
