import { useEffect, useState } from 'react';

import type { ToolActivity } from '../office/types.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

interface AgentDiagnostics {
  id: number;
  projectDir: string;
  projectDirExists: boolean;
  jsonlFile: string;
  jsonlExists: boolean;
  fileSize: number;
  fileOffset: number;
  lastDataAt: number;
  linesProcessed: number;
}

interface DebugViewProps {
  agents: number[];
  selectedAgent: number | null;
  agentTools: Record<number, ToolActivity[]>;
  agentStatuses: Record<number, string>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  onSelectAgent: (id: number) => void;
}

function ToolDot({ tool }: { tool: ToolActivity }) {
  const color = tool.done
    ? 'bg-status-success'
    : tool.permissionWait
      ? 'bg-status-permission'
      : 'bg-status-active';
  return (
    <span
      className={`w-6 h-6 rounded-full inline-block shrink-0 ${color} ${tool.done ? '' : 'pixel-pulse'}`}
    />
  );
}

function ToolLine({ tool }: { tool: ToolActivity }) {
  return (
    <span
      className={`text-base flex items-center gap-5 ${tool.done ? 'opacity-50' : 'opacity-80'}`}
    >
      <ToolDot tool={tool} />
      {tool.permissionWait && !tool.done ? 'Needs approval' : tool.status}
    </span>
  );
}

function formatTimeAgo(ms: number): string {
  if (ms === 0) return 'never';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function DebugView({
  agents,
  selectedAgent,
  agentTools,
  agentStatuses,
  subagentTools,
  onSelectAgent,
}: DebugViewProps) {
  const [diagnostics, setDiagnostics] = useState<Record<number, AgentDiagnostics>>({});

  // Request diagnostics from extension periodically
  useEffect(() => {
    transport.send({ type: 'requestDiagnostics' });
    const interval = setInterval(() => {
      transport.send({ type: 'requestDiagnostics' });
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // Listen for diagnostics response
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'agentDiagnostics') {
        const map: Record<number, AgentDiagnostics> = {};
        for (const a of msg.agents as AgentDiagnostics[]) {
          map[a.id] = a;
        }
        setDiagnostics(map);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const renderAgentCard = (id: number) => {
    const isSelected = selectedAgent === id;
    const tools = agentTools[id] || [];
    const subs = subagentTools[id] || {};
    const status = agentStatuses[id];
    const hasActiveTools = tools.some((t) => !t.done);
    const diag = diagnostics[id];
    return (
      <div
        key={id}
        className={`rounded-none py-6 px-8 border-2 cursor-pointer ${isSelected ? 'border-accent bg-active-bg' : 'border-border'}`}
        onClick={() => onSelectAgent(id)}
      >
        <span className="flex items-center justify-between">
          <span
            className={`rounded-none py-6 px-10 text-xl ${isSelected ? 'text-white font-bold' : ''}`}
          >
            Agent #{id}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              transport.send({ type: 'closeAgent', id });
            }}
            className={`opacity-70 ${isSelected ? 'text-white' : ''}`}
            title="Close agent"
          >
            ✕
          </Button>
        </span>
        {(tools.length > 0 || status === 'waiting') && (
          <div className="flex flex-col gap-[1px] mt-4 pl-4">
            {tools.map((tool) => (
              <div key={tool.toolId}>
                <ToolLine tool={tool} />
                {subs[tool.toolId] && subs[tool.toolId].length > 0 && (
                  <div className="ml-3 pl-8 mt-[1px] flex flex-col gap-[1px] border-l-2 border-border">
                    {subs[tool.toolId].map((subTool) => (
                      <ToolLine key={subTool.toolId} tool={subTool} />
                    ))}
                  </div>
                )}
              </div>
            ))}
            {status === 'waiting' && !hasActiveTools && (
              <span className="text-base opacity-85 flex items-center gap-5">
                <span className="w-6 h-6 rounded-full inline-block shrink-0 bg-status-permission" />
                Might be waiting for input
              </span>
            )}
          </div>
        )}
        {/* Connection diagnostics */}
        {diag && (
          <div className="mt-6 py-4 px-6 text-xs opacity-70 flex flex-col gap-2 border-t border-white/8">
            <span>
              <span className={diag.jsonlExists ? 'text-status-success' : 'text-status-error'}>
                {diag.jsonlExists ? 'JSONL connected' : 'JSONL not found'}
              </span>
              {' | '}
              Lines: {diag.linesProcessed}
              {' | '}
              Last data: {formatTimeAgo(diag.lastDataAt)}
            </span>
            <span className="opacity-60 text-2xs break-all">{diag.jsonlFile}</span>
            {!diag.projectDirExists && (
              <span className="text-2xs text-status-error">
                Project dir does not exist: {diag.projectDir}
              </span>
            )}
            {diag.jsonlExists && diag.fileSize > 0 && diag.linesProcessed === 0 && (
              <span className="text-2xs text-status-permission">
                File has data ({diag.fileSize} bytes) but 0 lines parsed. Possible format issue.
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="absolute inset-0 overflow-auto bg-bg z-15">
      <div className="px-12 py-6 text-2xl">
        <h2 className="text-3xl font-bold mb-8">Debug View</h2>
        <div className="flex flex-col gap-6">{agents.map(renderAgentCard)}</div>
      </div>
    </div>
  );
}
