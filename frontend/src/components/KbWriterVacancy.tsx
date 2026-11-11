import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';

import { useAppDispatch, useAppSelector } from '../app/hooks';
import { CURATOR_TEXT, KB_WRITER_NOTE_MAX_WIDTH_PX } from '../constants';
import { directoryLabel, vacantBindingPath } from '../features/workspaces/curatorBinding';
import { curatorBindingRevokeRequested } from '../features/workspaces/curatorSaga';

interface KbWriterVacancyViewProps {
  directoryName: string;
  pending: boolean;
  onRevoke: () => void;
  sx?: SxProps<Theme>;
}

/** 職缺說明與撤銷綁定按鈕。名稱與路徑一律以純文字顯示。 */
export function KbWriterVacancyView({
  directoryName,
  pending,
  onRevoke,
  sx,
}: KbWriterVacancyViewProps) {
  const text = `${CURATOR_TEXT.vacancyPrefix}${directoryName}${CURATOR_TEXT.vacancySuffix}`;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, ...sx }}>
      <Typography
        title={text}
        noWrap
        sx={{ fontSize: 10, color: 'text.disabled', maxWidth: KB_WRITER_NOTE_MAX_WIDTH_PX }}
      >
        {text}
      </Typography>
      <Button
        size="small"
        variant="outlined"
        disabled={pending}
        onClick={onRevoke}
        sx={{ fontSize: 11 }}
      >
        {pending ? CURATOR_TEXT.pending : CURATOR_TEXT.revoke}
      </Button>
    </Box>
  );
}

/** KB Writer 職缺（沒有人擔任、但有綁定目錄）時顯示；主機不支援 KB Writer 時隱藏。 */
export function KbWriterVacancy({ workspaceId, sx }: { workspaceId: string; sx?: SxProps<Theme> }) {
  const dispatch = useAppDispatch();
  const curatorsAvailable = useAppSelector((state) => state.workspaces.curatorsAvailable);
  const curators = useAppSelector((state) => state.workspaces.curators);
  const bindings = useAppSelector((state) => state.workspaces.bindings);
  const directories = useAppSelector((state) => state.workspaces.directories);
  const pending = useAppSelector((state) => state.workspaces.pendingCurators.includes(workspaceId));

  const path = vacantBindingPath(workspaceId, curators, bindings);
  if (!curatorsAvailable || path === undefined) return null;

  return (
    <KbWriterVacancyView
      directoryName={directoryLabel(directories, path)}
      pending={pending}
      onRevoke={() => dispatch(curatorBindingRevokeRequested(workspaceId))}
      sx={sx}
    />
  );
}
