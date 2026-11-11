import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { WORKSPACE_ROOT_TEXT } from '../constants';

interface WorkspaceRootFieldProps {
  /** 輸入中的根目錄；空字串表示不設定 */
  value: string;
  onChange: (value: string) => void;
  /** 設定過的根目錄，知識庫有內容後就不能再改 */
  editable: boolean;
  /** 已設定根目錄，但還在確認知識庫是否為空 */
  checking: boolean;
  disabled: boolean;
  overlapName: string | undefined;
}

/** 工作空間設定頁的根目錄欄位。只編輯草稿，由頁面唯一的「儲存」一併送出。 */
export function WorkspaceRootField({
  value,
  onChange,
  editable,
  checking,
  disabled,
  overlapName,
}: WorkspaceRootFieldProps) {
  return (
    <Box sx={{ px: 3, py: 2, borderBottom: 1, borderColor: 'divider' }}>
      <Typography sx={{ fontSize: 11, color: 'text.disabled', mb: 0.5 }}>
        {WORKSPACE_ROOT_TEXT.label}
      </Typography>
      <TextField
        size="small"
        fullWidth
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={WORKSPACE_ROOT_TEXT.inputLabel}
        disabled={disabled || !editable}
      />
      {!editable && (
        <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.75 }}>
          {checking ? WORKSPACE_ROOT_TEXT.checking : WORKSPACE_ROOT_TEXT.locked}
        </Typography>
      )}
      {overlapName !== undefined && (
        <Typography sx={{ fontSize: 11, color: 'warning.main', mt: 0.75 }}>
          {WORKSPACE_ROOT_TEXT.overlapPrefix}
          {overlapName}
        </Typography>
      )}
      <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.75 }}>
        {WORKSPACE_ROOT_TEXT.explain}
      </Typography>
    </Box>
  );
}
