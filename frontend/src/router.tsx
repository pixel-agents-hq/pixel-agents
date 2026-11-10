import { createBrowserRouter, Navigate } from 'react-router';

import { HomeRedirect } from './layout/HomeRedirect';
import { ManagementShell } from './layout/ManagementShell';
import { RootLayout } from './layout/RootLayout';
import { WorkspaceShell } from './layout/WorkspaceShell';
import { AddAgentPage } from './pages/AddAgentPage';
import { AddWorkspacePage } from './pages/AddWorkspacePage';
import { AllAgentsPage } from './pages/AllAgentsPage';
import { AgentDetailLayout } from './pages/agent/AgentDetailLayout';
import { AgentRoute } from './pages/agent/AgentRoute';
import { ClaudeCodeTab } from './pages/agent/ClaudeCodeTab';
import { FilesChangedTab } from './pages/agent/FilesChangedTab';
import { RoleActivityTab } from './pages/agent/RoleActivityTab';
import { SessionLogTab } from './pages/agent/SessionLogTab';
import { DashboardPage } from './pages/DashboardPage';
import { KbReviewPage } from './pages/KbReviewPage';
import { NotFoundPage } from './pages/NotFoundPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
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
          { index: true, element: <DashboardPage /> },
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
                  { path: 'files', element: <FilesChangedTab /> },
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
