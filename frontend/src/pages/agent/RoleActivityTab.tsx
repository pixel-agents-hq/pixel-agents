import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { RoleBadge } from '../../components/RoleBadge';
import type { GuardInactiveReason } from '../../protocol';
import { useRouteAgent } from './useRouteAgent';

const REASON_LABELS: Record<GuardInactiveReason, string> = {
  not_standalone_agent: '不是由本主機啟動的 Agent',
  hooks_not_installed: 'hooks 尚未安裝',
  pretooluse_hook_missing: '缺少 PreToolUse hook',
  hook_script_missing: '找不到 hook 腳本',
  awaiting_first_verdict: '等待第一次判定',
  no_workspace_root: '工作空間沒有根目錄',
  no_curator: '工作空間沒有 KB Writer',
};

export function RoleActivityTab() {
  const agent = useRouteAgent();
  const { guard } = agent;

  if (!guard) {
    return (
      <Typography sx={{ p: 3, fontSize: 12, color: 'text.disabled' }}>
        尚未收到這個 Agent 的規則生效狀態
      </Typography>
    );
  }

  return (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 560 }}>
      <Box>
        <Typography sx={{ fontSize: 11, color: 'text.disabled', mb: 0.75 }}>
          啟動時的 roles
        </Typography>
        {guard.permissionRoles === null ? (
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
            無（不套用權限限制）
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', gap: 0.75 }}>
            {guard.permissionRoles.map((role) => (
              <RoleBadge key={role} role={role} />
            ))}
          </Box>
        )}
      </Box>
      <Box>
        <Typography sx={{ fontSize: 11, color: 'text.disabled', mb: 0.75 }}>
          規則是否生效
        </Typography>
        <Typography sx={{ fontSize: 12, color: guard.active ? 'success.main' : 'warning.main' }}>
          {guard.active ? '生效中' : '未生效'}
        </Typography>
        {guard.reasons.map((reason) => (
          <Typography key={reason} sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>
            · {REASON_LABELS[reason]}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}
