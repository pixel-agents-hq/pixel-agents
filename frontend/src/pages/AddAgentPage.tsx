import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router';

import { useAppDispatch, useAppSelector } from '../app/hooks';
import { EventFlow } from '../components/EventFlow';
import type { EventFlowStep } from '../components/EventFlow';
import { FormField } from '../components/FormField';
import { agentDisplayName, selectAllAgents } from '../features/agents/agentSelectors';
import { canCreateAgent, normalizeAgentPath } from '../features/agentCreation/createAgentForm';
import {
  AGENT_CREATED_NOTICE,
  AGENT_CREATION_TIMEOUT_NOTICE,
  noticeState,
} from '../features/agentCreation/creationNotice';
import { agentCreationRequested } from '../features/agentCreation/createAgentSaga';
import { useAwaitCreation } from '../features/agentCreation/useAwaitCreation';
import { selectVisibleWorkspaces } from '../features/workspaces/workspaceSelectors';
import type { PermissionRole } from '../protocol';
import { controlBorderColor, roleColors } from '../theme';

const ROLE_OPTIONS: { role: PermissionRole; label: string }[] = [
  { role: 'R', label: 'Read' },
  { role: 'E', label: 'Edit' },
  { role: 'D', label: 'Delete' },
];

function RoleChip({
  role,
  label,
  active,
  disabled = false,
  onToggle,
}: {
  role: keyof typeof roleColors;
  label: string;
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const colors = roleColors[role];
  return (
    <ButtonBase
      aria-pressed={active}
      disabled={disabled}
      onClick={onToggle}
      sx={{
        px: 1.75,
        py: 0.75,
        gap: 0.625,
        borderRadius: '4px',
        border: '1px solid',
        borderColor: active ? colors.color : controlBorderColor,
        bgcolor: active ? colors.background : 'background.paper',
        opacity: disabled ? 0.65 : 1,
      }}
    >
      <Box
        component="span"
        sx={{ fontSize: 12, fontWeight: 600, color: active ? colors.color : 'text.disabled' }}
      >
        {role}
      </Box>
      <Box component="span" sx={{ fontSize: 11, color: active ? colors.color : 'text.disabled' }}>
        {label}
      </Box>
    </ButtonBase>
  );
}

export function AddAgentPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const workspaces = useAppSelector(selectVisibleWorkspaces);
  const curators = useAppSelector((state) => state.workspaces.curators);
  const curatorsAvailable = useAppSelector((state) => state.workspaces.curatorsAvailable);
  const agents = useAppSelector(selectAllAgents);

  const initialWorkspaceId = searchParams.get('workspace') ?? workspaces[0]?.id ?? '';
  const defaultRolesOf = (id: string) => workspaces.find((w) => w.id === id)?.permissionRoles ?? [];
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [agentPath, setAgentPath] = useState('');
  const [roles, setRoles] = useState<PermissionRole[]>(() => defaultRolesOf(initialWorkspaceId));
  const [becomeCurator, setBecomeCurator] = useState(false);
  const [name, setName] = useState('');
  const [startNow, setStartNow] = useState(false);

  const workspace = workspaces.find((w) => w.id === workspaceId);
  const existingCuratorId = curators[workspaceId];
  const existingCurator =
    existingCuratorId === undefined ? undefined : agents.find((a) => a.id === existingCuratorId);
  // KB Writer 必須是已經啟用的 Agent，所以沒勾「建立後立即啟用」時不能指定
  const curatorLocked = !curatorsAvailable || existingCuratorId !== undefined || !startNow;
  const willBecomeCurator = becomeCurator && !curatorLocked;

  const workspaceAgentIds = agents.filter((a) => a.workspaceId === workspaceId).map((a) => a.id);
  const onCreated = useCallback(
    () => void navigate(`/w/${workspaceId}`, { state: noticeState(AGENT_CREATED_NOTICE) }),
    [navigate, workspaceId],
  );
  const launch = useAwaitCreation(workspaceAgentIds, onCreated);

  const chooseWorkspace = (id: string) => {
    setWorkspaceId(id);
    setRoles(defaultRolesOf(id));
    setBecomeCurator(false);
  };

  const toggleRole = (role: PermissionRole) =>
    setRoles((current) =>
      current.includes(role) ? current.filter((r) => r !== role) : [...current, role],
    );

  const submit = () => {
    if (!workspace || !canCreateAgent(workspace.id, agentPath, launch.pending)) return;
    launch.begin();
    dispatch(
      agentCreationRequested({
        workspaceId: workspace.id,
        name: name.trim(),
        directoryPath: normalizeAgentPath(agentPath),
        start: startNow,
        permissionRoles: roles.length > 0 ? roles : null,
        becomeCurator: willBecomeCurator,
      }),
    );
  };

  const flowSteps: EventFlowStep[] = [
    { label: 'submit', value: 'form data', tone: 'plain' },
    {
      label: 'send',
      value: 'createAgent',
      detail: '{name, workspaceId, directoryPath, permissionRoles, start}',
      tone: 'send',
    },
    { label: 'receive', value: 'agentCreated', detail: '{id, stopped}', tone: 'receive' },
    ...(startNow
      ? [
          {
            label: 'receive',
            value: 'terminalSessionOpened',
            detail: '{agentId}',
            tone: 'receive',
          } as const,
        ]
      : []),
    ...(willBecomeCurator
      ? [
          {
            label: 'send',
            value: 'setWorkspaceCurator',
            detail: '{workspaceId, agentId}',
            tone: 'send',
          } as const,
        ]
      : []),
    { label: 'navigate', value: '/w/:workspaceId', tone: 'plain' },
  ];

  const backTo = `/w/${workspaceId}`;

  return (
    <Box sx={{ flex: 1, overflowY: 'auto', px: 6, py: 4.5 }}>
      <Box sx={{ width: '100%', maxWidth: 520 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3.5 }}>
          <Button
            variant="outlined"
            component={RouterLink}
            to={backTo}
            aria-label="返回"
            sx={{ minWidth: 0, width: 28, height: 28, p: 0, fontSize: 15 }}
          >
            ‹
          </Button>
          <Typography variant="h6">New Agent</Typography>
        </Box>

        <FormField label="Name" hint="Agent 的顯示名稱，留空則使用目錄名稱">
          <TextField
            fullWidth
            size="small"
            value={name}
            onChange={(event) => setName(event.target.value)}
            slotProps={{ htmlInput: { maxLength: 64 } }}
          />
        </FormField>

        <FormField label="Workspace" hint="Agent 所屬的工作空間">
          <Select
            fullWidth
            size="small"
            value={workspaceId}
            onChange={(event) => chooseWorkspace(event.target.value)}
          >
            {workspaces.map((item) => (
              <MenuItem key={item.id} value={item.id}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography sx={{ fontSize: 13 }}>{item.name}</Typography>
                  <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
                    {item.rootPath ?? item.directoryPaths[0] ?? ''}
                  </Typography>
                </Box>
              </MenuItem>
            ))}
          </Select>
        </FormField>

        <FormField
          label="Path"
          hint="Agent 工作的資料夾（絕對路徑）。不存在會自動建立，並登記為此工作空間的目錄，建立後初始化 Agent 的個人知識庫"
        >
          <TextField
            fullWidth
            size="small"
            required
            placeholder="/Users/you/projects/my-agent"
            value={agentPath}
            onChange={(event) => setAgentPath(event.target.value)}
            slotProps={{ htmlInput: { 'aria-label': 'Path' } }}
          />
        </FormField>

        <FormField label="Roles" hint="點擊切換 Agent 在此工作空間的操作權限">
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {ROLE_OPTIONS.map(({ role, label }) => (
              <RoleChip
                key={role}
                role={role}
                label={label}
                active={roles.includes(role)}
                onToggle={() => toggleRole(role)}
              />
            ))}
            <RoleChip
              role="W"
              label="KB Writer"
              active={willBecomeCurator}
              disabled={curatorLocked}
              onToggle={() => setBecomeCurator((value) => !value)}
            />
          </Box>
          {roles.length === 0 && (
            <Typography sx={{ fontSize: 11, color: 'warning.main', mt: 0.75 }}>
              未選任何 role：不套用權限限制
            </Typography>
          )}
        </FormField>

        <Box
          sx={{
            mb: 3.5,
            p: 1.5,
            bgcolor: '#0d0d13',
            border: 1,
            borderColor: 'divider',
            borderRadius: '4px',
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.25,
              mb: existingCurator || !curatorsAvailable ? 1 : 0,
            }}
          >
            <Box sx={{ flex: 1 }}>
              <Typography
                sx={{ fontSize: 12, fontWeight: 500, color: 'text.secondary', mb: '2px' }}
              >
                KB Writer
              </Typography>
              <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
                指定此 Agent 為工作空間的知識庫寫入者
              </Typography>
            </Box>
            <Switch
              checked={willBecomeCurator}
              disabled={curatorLocked}
              onChange={(event) => setBecomeCurator(event.target.checked)}
              slotProps={{ input: { 'aria-label': '指定為 KB Writer' } }}
            />
          </Box>
          {existingCurator && (
            <Box
              sx={{
                px: 1.25,
                py: 0.875,
                bgcolor: 'rgba(234,179,8,0.06)',
                border: '1px solid rgba(234,179,8,0.2)',
                borderRadius: '3px',
              }}
            >
              <Typography sx={{ fontSize: 11, color: 'warning.dark' }}>
                ⚠ {workspace?.name} 已有 KB Writer：{agentDisplayName(existingCurator)}
              </Typography>
            </Box>
          )}
          {!curatorsAvailable && (
            <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
              此主機不支援 KB Writer
            </Typography>
          )}
        </Box>

        <FormControlLabel
          sx={{ mb: 2.5, display: 'flex' }}
          control={
            <Checkbox
              size="small"
              checked={startNow}
              onChange={(event) => setStartNow(event.target.checked)}
            />
          }
          label={
            <Box>
              <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>建立後立即啟用</Typography>
              <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
                不勾選則只建立，之後在工作空間裡按「啟用」才會開始執行 Claude Code
              </Typography>
            </Box>
          }
        />

        {launch.timedOut && (
          <Typography role="status" sx={{ fontSize: 11, color: 'warning.main', mb: 1.5 }}>
            {AGENT_CREATION_TIMEOUT_NOTICE}
          </Typography>
        )}

        <EventFlow steps={flowSteps} />

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button
            variant="contained"
            disabled={!canCreateAgent(workspaceId, agentPath, launch.pending)}
            onClick={submit}
            sx={{ px: 2.5, py: 1, fontSize: 13 }}
          >
            {launch.pending ? 'Creating…' : 'Create Agent'}
          </Button>
          <Button component={RouterLink} to={backTo} sx={{ color: 'text.secondary', fontSize: 13 }}>
            Cancel
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
