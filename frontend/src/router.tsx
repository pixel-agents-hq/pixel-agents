import { createBrowserRouter, Navigate } from 'react-router';

import { HomeRedirect } from './layout/HomeRedirect';
import { ManagementShell } from './layout/ManagementShell';
import { WorkspaceShell } from './layout/WorkspaceShell';
import { AddAgentPage } from './pages/AddAgentPage';
import { AddWorkspacePage } from './pages/AddWorkspacePage';
import { AllAgentsPage } from './pages/AllAgentsPage';
import { AgentDetailLayout } from './pages/agent/AgentDetailLayout';
import { AgentKbTab } from './pages/agent/AgentKbTab';
import { AgentRoute } from './pages/agent/AgentRoute';
import { ClaudeCodeTab } from './pages/agent/ClaudeCodeTab';
import { RoleActivityTab } from './pages/agent/RoleActivityTab';
import { SessionLogTab } from './pages/agent/SessionLogTab';
import { DashboardPage } from './pages/DashboardPage';
import { KbReviewPage } from './pages/KbReviewPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { WorkspaceSettingsPage } from './pages/WorkspaceSettingsPage';
import { WorkspaceAgentsTab } from './pages/workspace/WorkspaceAgentsTab';
import { WorkspaceKbTab } from './pages/workspace/WorkspaceKbTab';

export const router = createBrowserRouter([
  {
    path: '/',
    children: [
      { index: true, element: <HomeRedirect /> },
      {
        element: <ManagementShell placeholder="新工作空間…" />,
        children: [{ path: 'workspaces/new', element: <AddWorkspacePage /> }],
      },
      {
        element: <ManagementShell placeholder="新 Agent…" />,
        children: [{ path: 'agents/new', element: <AddAgentPage /> }],
      },
      {
        element: <ManagementShell />,
        children: [{ path: 'agents', element: <AllAgentsPage /> }],
      },
      {
        path: 'w/:workspaceId',
        element: <WorkspaceShell />,
        children: [
          {
            element: <DashboardPage />,
            children: [
              { index: true, element: <WorkspaceAgentsTab /> },
              { path: 'kb', element: <WorkspaceKbTab /> },
            ],
          },
          {
            path: 'agents/:agentId',
            element: <AgentRoute />,
            children: [
              {
                element: <AgentDetailLayout />,
                children: [
                  { index: true, element: <Navigate to="claude" replace /> },
                  { path: 'claude', element: <ClaudeCodeTab /> },
                  { path: 'log', element: <SessionLogTab /> },
                  { path: 'kb', element: <AgentKbTab /> },
                  { path: 'roles', element: <RoleActivityTab /> },
                ],
              },
              {
                path: 'terminal',
                lazy: async () => ({
                  Component: (await import('./pages/agent/TerminalPage')).TerminalPage,
                }),
              },
            ],
          },
          { path: 'settings', element: <WorkspaceSettingsPage /> },
          {
            path: 'kb-review',
            children: [
              { index: true, element: <Navigate to="pending" replace /> },
              { path: ':status', element: <KbReviewPage /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
