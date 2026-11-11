import { useMemo } from 'react';
import { useParams } from 'react-router';

import { useAppSelector } from '../../app/hooks';
import { KbPanel } from '../../components/kb/KbPanel';
import { KB_TEXT } from '../../constants';
import { selectWorkspace } from '../../features/workspaces/workspaceSelectors';
import type { KbTarget } from '../../protocol';

export function WorkspaceKbTab() {
  const { workspaceId = '' } = useParams();
  const hasRoot = useAppSelector((state) => Boolean(selectWorkspace(state, workspaceId)?.rootPath));
  const target = useMemo<KbTarget | null>(
    () => (hasRoot ? { scope: 'workspace', workspaceId } : null),
    [hasRoot, workspaceId],
  );
  return <KbPanel target={target} blockedNote={hasRoot ? null : KB_TEXT.noRoot} />;
}
