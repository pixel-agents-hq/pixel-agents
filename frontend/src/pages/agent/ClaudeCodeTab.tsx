import { AgentTerminal } from './AgentTerminal';
import { useRouteAgent } from './useRouteAgent';

export function ClaudeCodeTab() {
  return <AgentTerminal agent={useRouteAgent()} />;
}
