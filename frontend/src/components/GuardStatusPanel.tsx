import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { GUARD_TEXT, ROOT_PATH_MAX_WIDTH_PX } from '../constants';
import type { GuardLine, GuardStatusView } from '../features/agents/guardStatus';

const TONE_COLORS = {
  ok: 'success.main',
  warn: 'warning.main',
  neutral: 'text.secondary',
} as const;

function GuardLineRow({ line }: { line: GuardLine }) {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline', mt: 0.5 }}>
      <Typography sx={{ fontSize: 11, color: 'text.disabled', flexShrink: 0 }}>
        {line.label}
      </Typography>
      <Typography sx={{ fontSize: 12, color: TONE_COLORS[line.tone], flexShrink: 0 }}>
        {line.value}
      </Typography>
      {line.detail !== undefined && (
        <Typography
          title={line.detail}
          noWrap
          sx={{ fontSize: 11, color: 'text.secondary', maxWidth: ROOT_PATH_MAX_WIDTH_PX }}
        >
          {line.detail}
        </Typography>
      )}
    </Box>
  );
}

/** 三條狀態分開呈現，不合併成單一「已保護」。 */
export function GuardStatusPanel({ status }: { status: GuardStatusView }) {
  return (
    <Box>
      {status.protectedSummary && (
        <Typography sx={{ fontSize: 12, color: 'success.main' }}>{GUARD_TEXT.summary}</Typography>
      )}
      {status.lines.map((line) => (
        <GuardLineRow key={line.label} line={line} />
      ))}
      {status.otherReasons.map((reason) => (
        <Typography key={reason} sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5 }}>
          {GUARD_TEXT.otherReasonLabel}：{reason}
        </Typography>
      ))}
    </Box>
  );
}
