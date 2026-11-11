import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router';

import { useAppDispatch, useAppSelector } from '../app/hooks';
import { WorkspaceRootField } from '../components/WorkspaceRootControl';
import { WORKSPACE_ROOT_TEXT, WORKSPACE_SETTINGS_TEXT } from '../constants';
import { selectAgentsInWorkspace } from '../features/agents/agentSelectors';
import { EMPTY_KB_VIEW, kbListRequested, kbTargetKey } from '../features/kb/kbSlice';
import {
  canEditWorkspaceRoot,
  confirmMessage,
  countAgentsLosingProtection,
  findOverlappingWorkspace,
  rootChangeNeedsConfirm,
} from '../features/workspaces/workspaceRoot';
import { DEFAULT_WORKSPACE_ID } from '../protocol';
import type { Directory, Workspace } from '../protocol';
import { selectWorkspace } from '../features/workspaces/workspaceSelectors';
import {
  canEditRootPath,
  canSaveSettings,
  directoryOptions,
  draftEqualsWorkspace,
  draftFromWorkspace,
  kbViewIsEmpty,
  reflectsDraft,
  removesDirectories,
  rootChanged,
  toggleDirectory,
} from '../features/workspaces/workspaceSettings';
import type { WorkspaceDraft } from '../features/workspaces/workspaceSettings';
import { workspaceSaveRequested } from '../features/workspaces/workspaceSettingsSaga';
import { NotFoundPage } from './NotFoundPage';

interface WorkspaceSettingsViewProps {
  workspace: Workspace;
  directories: Directory[];
  workspaces: Workspace[];
  draft: WorkspaceDraft;
  pending: boolean;
  /** undefined = 知識庫清單還沒回來 */
  kbIsEmpty: boolean | undefined;
  onDraftChange: (draft: WorkspaceDraft) => void;
  onSave: () => void;
}

export function WorkspaceSettingsView({
  workspace,
  directories,
  workspaces,
  draft,
  pending,
  kbIsEmpty,
  onDraftChange,
  onSave,
}: WorkspaceSettingsViewProps) {
  const options = directoryOptions(directories, workspaces, workspace, draft.directoryPaths);
  const dirty = !draftEqualsWorkspace(workspace, draft);
  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <Box sx={{ px: 3, pt: 2.5, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Button
          size="small"
          component={RouterLink}
          to={`/w/${workspace.id}`}
          sx={{ fontSize: 11, mb: 1 }}
        >
          {WORKSPACE_SETTINGS_TEXT.back}
        </Button>
        <Typography variant="h6">{WORKSPACE_SETTINGS_TEXT.title}</Typography>
        <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>{workspace.name}</Typography>
      </Box>

      <Box sx={{ px: 3, py: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Typography sx={{ fontSize: 11, color: 'text.disabled', mb: 0.5 }}>
          {WORKSPACE_SETTINGS_TEXT.nameLabel}
        </Typography>
        <TextField
          size="small"
          fullWidth
          value={draft.name}
          onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
          placeholder={WORKSPACE_SETTINGS_TEXT.nameHint}
          disabled={pending}
        />
      </Box>

      {canEditWorkspaceRoot(workspace.id) && (
        <WorkspaceRootField
          value={draft.rootPath}
          onChange={(rootPath) => onDraftChange({ ...draft, rootPath })}
          editable={canEditRootPath(workspace, kbIsEmpty)}
          checking={kbIsEmpty === undefined}
          disabled={pending}
          overlapName={findOverlappingWorkspace(draft.rootPath, workspace.id, workspaces)?.name}
        />
      )}

      <Box sx={{ px: 3, py: 2 }}>
        <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
          {WORKSPACE_SETTINGS_TEXT.directoriesLabel}
        </Typography>
        <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 1 }}>
          {WORKSPACE_SETTINGS_TEXT.directoriesHint}
        </Typography>
        {options.length === 0 && (
          <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>
            {WORKSPACE_SETTINGS_TEXT.directoriesEmpty}
          </Typography>
        )}
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          {options.map(({ directory, checked, ownerName }) => (
            <FormControlLabel
              key={directory.path}
              disabled={pending || ownerName !== undefined}
              control={
                <Checkbox
                  size="small"
                  checked={checked}
                  onChange={(event) =>
                    onDraftChange(toggleDirectory(draft, directory.path, event.target.checked))
                  }
                />
              }
              label={
                <Typography sx={{ fontSize: 12 }}>
                  {directory.name}
                  <Box component="span" sx={{ color: 'text.disabled' }}>
                    {' · '}
                    {directory.path}
                  </Box>
                  {ownerName !== undefined && (
                    <Box component="span" sx={{ color: 'warning.main' }}>
                      {' · '}
                      {WORKSPACE_SETTINGS_TEXT.ownedByPrefix}
                      {ownerName}
                    </Box>
                  )}
                </Typography>
              }
            />
          ))}
        </Box>
        {removesDirectories(workspace, draft) && (
          <Typography sx={{ fontSize: 11, color: 'warning.main', mt: 1 }}>
            {WORKSPACE_SETTINGS_TEXT.removalNote}
          </Typography>
        )}
      </Box>

      <Box sx={{ px: 3, pb: 3, display: 'flex', gap: 1.5, alignItems: 'center' }}>
        <Button
          variant="contained"
          disabled={!canSaveSettings(workspace, draft, pending)}
          onClick={onSave}
        >
          {WORKSPACE_SETTINGS_TEXT.save}
        </Button>
        {pending && (
          <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
            {WORKSPACE_SETTINGS_TEXT.saving}
          </Typography>
        )}
        {!pending && dirty && (
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
            {WORKSPACE_SETTINGS_TEXT.dirty}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function WorkspaceSettingsForm({ workspace }: { workspace: Workspace }) {
  const dispatch = useAppDispatch();
  const directories = useAppSelector((state) => state.workspaces.directories);
  const workspaces = useAppSelector((state) => state.workspaces.workspaces);
  const connected = useAppSelector((state) => state.connection.status === 'connected');
  const agents = useAppSelector((state) => selectAgentsInWorkspace(state, workspace.id));
  const pending = useAppSelector((state) => state.workspaces.pendingSaves.includes(workspace.id));
  const hasRoot = workspace.rootPath !== undefined;
  const kbTarget = { scope: 'workspace', workspaceId: workspace.id } as const;
  const kbView = useAppSelector((state) => state.kb.byKey[kbTargetKey(kbTarget)]) ?? EMPTY_KB_VIEW;
  const [edited, setEdited] = useState<WorkspaceDraft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const wasPending = useRef(false);
  const rootBeforeSave = useRef<string | undefined>(undefined);

  // 已設定根目錄時，列出知識庫來判斷是不是空的（空的才能改根目錄）。
  useEffect(() => {
    if (hasRoot && connected) dispatch(kbListRequested(kbTarget));
    // kbTarget 只由 workspace.id 決定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, workspace.id, hasRoot, connected]);

  // 沒有編輯、或編輯結果已與伺服器廣播一致時，直接顯示最新的伺服器資料。
  const draft =
    edited !== null && !draftEqualsWorkspace(workspace, edited)
      ? edited
      : draftFromWorkspace(workspace);

  // 儲存完成且伺服器已反映草稿時丟掉草稿：根目錄存的是 realpath，文字不一定與輸入相同。
  useEffect(() => {
    if (wasPending.current && !pending && edited !== null) {
      const rootBlank = edited.rootPath.trim() === '';
      const rootSaved = rootBlank
        ? workspace.rootPath === undefined
        : workspace.rootPath !== undefined &&
          (workspace.rootPath !== rootBeforeSave.current || !rootChanged(workspace, edited));
      if (reflectsDraft(workspace, edited) && rootSaved) setEdited(null);
    }
    wasPending.current = pending;
  }, [pending, edited, workspace]);

  const save = () => {
    setConfirming(false);
    rootBeforeSave.current = workspace.rootPath;
    dispatch(workspaceSaveRequested({ workspaceId: workspace.id, draft }));
  };
  const requestSave = () => {
    if (rootChanged(workspace, draft) && rootChangeNeedsConfirm(workspace.rootPath)) {
      setConfirming(true);
    } else {
      save();
    }
  };

  return (
    <>
      <WorkspaceSettingsView
        workspace={workspace}
        directories={directories}
        workspaces={workspaces}
        draft={draft}
        pending={pending}
        kbIsEmpty={kbViewIsEmpty(kbView)}
        onDraftChange={setEdited}
        onSave={requestSave}
      />
      <Dialog open={confirming} onClose={() => setConfirming(false)}>
        <DialogTitle sx={{ fontSize: 14 }}>{WORKSPACE_ROOT_TEXT.confirmTitle}</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12 }}>
            {confirmMessage(countAgentsLosingProtection(agents))}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setConfirming(false)} sx={{ fontSize: 11 }}>
            {WORKSPACE_ROOT_TEXT.confirmCancel}
          </Button>
          <Button
            size="small"
            variant="contained"
            color="warning"
            onClick={save}
            sx={{ fontSize: 11 }}
          >
            {WORKSPACE_ROOT_TEXT.confirmOk}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export function WorkspaceSettingsPage() {
  const { workspaceId = '' } = useParams();
  const workspace = useAppSelector((state) => selectWorkspace(state, workspaceId));
  if (!workspace || workspace.id === DEFAULT_WORKSPACE_ID) {
    return <NotFoundPage message={WORKSPACE_SETTINGS_TEXT.unavailable} homeTo="/" />;
  }
  return <WorkspaceSettingsForm key={workspaceId} workspace={workspace} />;
}
