import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { Link as RouterLink, useParams } from 'react-router';

import { useAppSelector } from '../app/hooks';
import { KB_REVIEW_STATUSES } from '../constants';
import type { KbReviewStatus } from '../constants';
import { agentDisplayName } from '../features/agents/agentSelectors';
import { selectWorkspace } from '../features/workspaces/workspaceSelectors';
import { NotFoundPage } from './NotFoundPage';

const STATUS_LABELS: Record<KbReviewStatus, string> = {
  pending: '待審核',
  approved: '已核准',
  rejected: '已拒絕',
};

function isKbReviewStatus(value: string): value is KbReviewStatus {
  return (KB_REVIEW_STATUSES as readonly string[]).includes(value);
}

export function KbReviewPage() {
  const { workspaceId = '', status = '' } = useParams();
  const workspace = useAppSelector((state) => selectWorkspace(state, workspaceId));
  const curatorId = useAppSelector((state) => state.workspaces.curators[workspaceId]);
  const curator = useAppSelector((state) =>
    curatorId === undefined ? undefined : state.agents.byId[curatorId],
  );

  if (!isKbReviewStatus(status)) {
    return <NotFoundPage message="找不到這個審核分頁" homeTo={`/w/${workspaceId}/kb-review`} />;
  }

  return (
    <>
      <Box sx={{ px: 3, pt: 2.5, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="h6">知識庫寫入審核</Typography>
        <Typography sx={{ fontSize: 12, color: 'text.disabled', mt: '1px' }}>
          {workspace?.name} 工作空間
          {curator
            ? ` · 由 ${agentDisplayName(curator)} (KB Writer) 審核`
            : ' · 尚未指定 KB Writer'}
        </Typography>
      </Box>

      <Tabs
        value={status}
        sx={{
          minHeight: 36,
          px: 3,
          bgcolor: 'background.default',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        {KB_REVIEW_STATUSES.map((value) => (
          <Tab
            key={value}
            value={value}
            label={STATUS_LABELS[value]}
            component={RouterLink}
            to={`/w/${workspaceId}/kb-review/${value}`}
            sx={{ minHeight: 36, py: 0, fontSize: 12 }}
          />
        ))}
      </Tabs>

      <Box sx={{ flex: 1, overflowY: 'auto', p: 3 }}>
        <Typography sx={{ fontSize: 12, color: 'text.disabled', mb: 2 }}>
          後端協定目前沒有提供 KB 寫入請求的訊息，審核清單待協定支援後再實作。
        </Typography>
        {curator && (
          <Button
            variant="outlined"
            component={RouterLink}
            to={`/w/${workspaceId}/agents/${curator.id}`}
          >
            前往 KB Writer
          </Button>
        )}
      </Box>
    </>
  );
}
