import type { ReactNode } from 'react';
import Typography from '@mui/material/Typography';

export function MonoText({
  children,
  color = 'text.disabled',
}: {
  children: ReactNode;
  color?: string;
}) {
  return (
    <Typography component="span" sx={{ fontSize: 10, color, whiteSpace: 'nowrap' }}>
      {children}
    </Typography>
  );
}
