import { TerminalPanel } from '../../features/terminal/TerminalPanel';
import { useRouteAgent } from './useRouteAgent';

export function ClaudeCodeTab() {
  const agent = useRouteAgent();
  return <TerminalPanel agentId={agent.id} />;
}
