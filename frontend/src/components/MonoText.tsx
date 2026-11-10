import type { ReactNode } from 'react';
import Typography from '@mui/material/Typography';

import { monoFontFamily } from '../theme';

export function MonoText({
  children,
  color = 'text.disabled',
}: {
  children: ReactNode;
  color?: string;
}) {
  return (
    <Typography
      component="span"
      sx={{ fontFamily: monoFontFamily, fontSize: 10, color, whiteSpace: 'nowrap' }}
    >
      {children}
    </Typography>
  );
}
