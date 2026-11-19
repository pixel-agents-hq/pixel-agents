import type { OfficeTool } from '../tool.js';
import { listAgents } from './listAgents.js';

/** Every Pixel Office MCP tool, in the order agents see them. A new tool is
 *  its own file in this folder plus one line here. */
export const OFFICE_TOOLS: readonly OfficeTool[] = [listAgents];
