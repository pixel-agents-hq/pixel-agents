import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

import { useAppDispatch, useAppSelector } from '../app/hooks';
import { CURATOR_TEXT, KB_WRITER_NOTE_MAX_WIDTH_PX } from '../constants';
import type { Agent } from '../features/agents/agentsSlice';
import {
  canBeCurator,
  curatorActionFor,
  curatorChangeRequested,
} from '../features/workspaces/curatorSaga';
import { curatorPersistenceNote } from '../features/workspaces/curatorBinding';
import { selectWorkspace } from '../features/workspaces/workspaceSelectors';
import { DEFAULT_WORKSPACE_ID } from '../protocol';
import { KbWriterVacancy } from './KbWriterVacancy';

function Note({ children, color }: { children: string; color: string }) {
  return (
    <Typography
      title={children}
      noWrap
      sx={{ fontSize: 10, color, maxWidth: KB_WRITER_NOTE_MAX_WIDTH_PX }}
    >
      {children}
    </Typography>
  );
}

/** Agent 標頭的 KB Writer 控制；狀態完全來自伺服器廣播的 curators，不做樂觀更新。 */
export function KbWriterControl({ agent }: { agent: Agent }) {
  const dispatch = useAppDispatch();
  const workspaceId = agent.workspaceId || DEFAULT_WORKSPACE_ID;
  const curatorsAvailable = useAppSelector((state) => state.workspaces.curatorsAvailable);
  const curatorId = useAppSelector((state) => state.workspaces.curators[workspaceId]);
  const pending = useAppSelector((state) => state.workspaces.pendingCurators.includes(workspaceId));
  const rootPath = useAppSelector((state) => selectWorkspace(state, workspaceId)?.rootPath);

  if (!curatorsAvailable) return null;
  if (!canBeCurator(agent)) return <KbWriterVacancy workspaceId={workspaceId} />;

  const action = curatorActionFor(curatorId, agent.id);
  return (
    <>
      <KbWriterVacancy workspaceId={workspaceId} />
      {rootPath === undefined && <Note color="warning.main">{CURATOR_TEXT.noRoot}</Note>}
      <Note color="text.disabled">{curatorPersistenceNote(workspaceId)}</Note>
      <Button
        size="small"
        variant="outlined"
        disabled={pending}
        onClick={() => dispatch(curatorChangeRequested({ workspaceId, agentId: agent.id }))}
        sx={{ fontSize: 11 }}
      >
        {pending ? CURATOR_TEXT.pending : CURATOR_TEXT[action]}
      </Button>
    </>
  );
}
